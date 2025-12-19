import z from "zod"
import { streamText, wrapLanguageModel, type ModelMessage } from "ai"
import { Tool } from "./tool"
import DESCRIPTION from "./compact.txt"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { Provider } from "../provider/provider"
import { toModelMessageWithIDs } from "../session/archive-context"
import { ProviderTransform } from "../provider/transform"
import { Log } from "../util/log"
import { Token } from "../util/token"
import { mergeDeep, pipe } from "remeda"

const log = Log.create({ service: "tool.compact" })

const RangeSchema = z.object({
  startMessageId: z.string().min(1, "startMessageId is required").describe("First message ID in the range"),
  endMessageId: z.string().min(1).optional().describe("Optional last message ID in the range (inclusive)"),
})

const Parameters = z.object({
  ranges: z
    .array(RangeSchema)
    .nonempty("ranges must include at least one range")
    .describe("Message ranges to consider for compaction preparation"),
})

interface NormalizedRange {
  startMessageId: string
  endMessageId: string
}

/**
 * Fetches a message by ID from the session storage.
 * Returns the message info and parts, or throws an error if not found.
 */
async function getMessage(sessionID: string, messageID: string): Promise<MessageV2.WithParts> {
  const result = await MessageV2.get({ sessionID, messageID }).catch(() => null)
  if (!result?.info) {
    throw new Error(`Message not found: ${messageID}`)
  }
  return result
}

/**
 * Normalizes ranges by filling in missing endMessageId with startMessageId.
 */
function normalizeRanges(ranges: Array<{ startMessageId: string; endMessageId?: string }>): NormalizedRange[] {
  return ranges.map((r) => ({
    startMessageId: r.startMessageId,
    endMessageId: r.endMessageId ?? r.startMessageId,
  }))
}

/**
 * Validates a single range for:
 * - Message existence
 * - Chronological order (startMessageId <= endMessageId)
 * - Archive status (start and end messages must not be archived)
 * Returns the messages within the range.
 */
async function validateSingleRange(
  sessionID: string,
  range: NormalizedRange,
  allMessages: MessageV2.WithParts[],
): Promise<{ messages: MessageV2.WithParts[]; start: MessageV2.WithParts; end: MessageV2.WithParts }> {
  const start = await getMessage(sessionID, range.startMessageId)
  const end = range.startMessageId === range.endMessageId ? start : await getMessage(sessionID, range.endMessageId)

  // Check chronological order (message IDs are lexicographically sortable by time)
  if (range.startMessageId > range.endMessageId) {
    throw new Error(`Start message must come before end message: ${range.startMessageId} > ${range.endMessageId}`)
  }

  // Check archive status of START message
  if (start.info.archivedBy) {
    throw new Error(`Message ${start.info.id} is already archived (part of archive ${start.info.archivedBy})`)
  }
  if (start.info.archive) {
    throw new Error(`Message ${start.info.id} is already archived (anchor of archive ending at ${start.info.archive.rangeEnd})`)
  }

  // Check archive status of END message
  if (end.info.archivedBy) {
    throw new Error(`Message ${end.info.id} is already archived (part of archive ${end.info.archivedBy})`)
  }
  if (end.info.archive) {
    throw new Error(`Message ${end.info.id} is already archived (anchor of archive ending at ${end.info.archive.rangeEnd})`)
  }

  // Collect all messages in range
  const messagesInRange = allMessages.filter(
    (m) => m.info.id >= range.startMessageId && m.info.id <= range.endMessageId,
  )

  if (messagesInRange.length === 0) {
    throw new Error(`Range contains no messages: ${range.startMessageId} to ${range.endMessageId}`)
  }

  return { messages: messagesInRange, start, end }
}

/**
 * Checks that no ranges overlap with each other.
 * Two ranges overlap if their message ID intervals intersect.
 */
function validateNoOverlaps(ranges: NormalizedRange[]): void {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]
      const b = ranges[j]

      // Two ranges overlap if one starts before the other ends and ends after the other starts
      const overlaps = a.startMessageId <= b.endMessageId && a.endMessageId >= b.startMessageId

      if (overlaps) {
        throw new Error(
          `Ranges overlap: (${a.startMessageId} to ${a.endMessageId}) and (${b.startMessageId} to ${b.endMessageId})`,
        )
      }
    }
  }
}

/**
 * Estimates token count for a set of messages by summing up text content.
 */
function estimateTokensForMessages(messages: MessageV2.WithParts[]): number {
  let totalText = ""
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "text" && "text" in part) {
        totalText += part.text
      }
      if (part.type === "tool" && part.state?.status === "completed" && part.state.output) {
        totalText += part.state.output
      }
    }
  }
  return Token.estimate(totalText)
}

// ============================================================================
// Summarization Types and Functions (Story 2.2)
// ============================================================================

/**
 * Summary generated by the LLM for a compacted message range.
 */
export interface CompactionSummary {
  summary: string
  indexTerms: string[]
}

/**
 * System prompt for the compaction summarization LLM call.
 * Instructs the model to generate concise summaries and semantic index terms.
 */
const COMPACTION_SUMMARY_SYSTEM_PROMPT = `You are a context compaction assistant. Your job is to analyze conversation message ranges and generate:
1. A concise summary (1-3 sentences) for each range
2. 3-7 semantic index terms for future retrieval

Guidelines for summaries:
- Capture the essence of what was discussed/accomplished
- Be specific - include key decisions, file names, function names where relevant
- For debugging content: summarize what was tried, what was learned, what failed/succeeded

Guidelines for index terms:
- Use specific technical terms that would help retrieve this content
- Include: technologies, file names, error types, concepts discussed
- Avoid generic terms like "code", "fix", "work"

CRITICAL FOR DEBUGGING/ITERATION CONTENT:
If the content contains debugging attempts, iterations, or trial-and-error:
- Summarize WHAT WAS TRIED and WHAT WAS LEARNED
- Include specific error messages or insights discovered
- Note any constraints or requirements discovered
- Don't just say "debugging session" - capture the knowledge gained

Example good summary for debugging: "Debugged auth failure across 3 iterations. Tried: token refresh (tokens valid), session storage (sessions persisting). Found: middleware order causing session loss before auth check. Solution: move session middleware before auth."

Example bad summary for debugging: "Debugging session for authentication issues."

Respond ONLY with valid JSON in the format:
{
  "<startMessageId>": {
    "summary": "string",
    "indexTerms": ["string", ...]
  },
  ...
}`

/**
 * Parses the LLM response text to extract structured summaries.
 * Handles malformed responses gracefully by returning partial results.
 */
function parseCompactionResponse(text: string): Record<string, CompactionSummary> {
  // Try to find JSON in the response (may have markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    log.warn("No valid JSON found in compaction response", { text: text.slice(0, 200) })
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch (e) {
    log.warn("Failed to parse JSON from compaction response", { error: e, text: text.slice(0, 200) })
    return {}
  }

  if (typeof parsed !== "object" || parsed === null) {
    log.warn("Parsed JSON is not an object", { parsed })
    return {}
  }

  // Validate structure and extract valid entries
  const result: Record<string, CompactionSummary> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue
    const v = value as Record<string, unknown>
    if (typeof v.summary !== "string") continue
    if (!Array.isArray(v.indexTerms)) continue

    result[key] = {
      summary: v.summary,
      indexTerms: v.indexTerms.filter((t): t is string => typeof t === "string").slice(0, 7),
    }
  }

  return result
}

/**
 * Gets the model information from the last assistant message in the provided messages.
 * Returns null if no model information is found.
 */
function getModelFromMessages(messages: MessageV2.WithParts[]): { providerID: string; modelID: string } | null {
  const lastAssistant = messages.findLast((m) => m.info.role === "assistant")
  if (lastAssistant && "providerID" in lastAssistant.info && "modelID" in lastAssistant.info) {
    return {
      providerID: (lastAssistant.info as MessageV2.Assistant).providerID,
      modelID: (lastAssistant.info as MessageV2.Assistant).modelID,
    }
  }
  return null
}

/**
 * Generates summaries for validated message ranges using an LLM call.
 * Uses the same model as the session's last assistant message.
 */
async function generateSummaries(input: {
  sessionID: string
  allMessages: MessageV2.WithParts[]
  validatedRanges: Array<{ range: NormalizedRange; messages: MessageV2.WithParts[] }>
  model: { providerID: string; modelID: string }
  abort: AbortSignal
}): Promise<Record<string, CompactionSummary>> {
  const model = await Provider.getModel(input.model.providerID, input.model.modelID)

  // Build the user prompt with range information
  const rangeDescriptions = input.validatedRanges
    .map((r) => `- Range starting at ${r.range.startMessageId} to ${r.range.endMessageId} (${r.messages.length} messages)`)
    .join("\n")

  const userPrompt = `Analyze the following message ranges from the conversation and generate summaries with index terms for each:

${rangeDescriptions}

For EACH range, provide:
1. A concise summary (1-3 sentences) capturing the essence of the content
2. 3-7 index terms for future retrieval

IMPORTANT: The message IDs in the conversation are prefixed with [msg_xxx]. Use the startMessageId from each range as the key in your JSON response.

Respond in JSON format:
{
  "<startMessageId>": {
    "summary": "...",
    "indexTerms": ["...", "..."]
  },
  ...
}`

  log.info("generating summaries", {
    sessionID: input.sessionID,
    rangeCount: input.validatedRanges.length,
    providerID: input.model.providerID,
    modelID: input.model.modelID,
  })

  try {
    const response = await streamText({
      abortSignal: input.abort,
      maxRetries: 0,
      providerOptions: ProviderTransform.providerOptions(
        model.npm,
        model.providerID,
        pipe(
          {},
          mergeDeep(ProviderTransform.options(model.providerID, model.modelID, model.npm ?? "", input.sessionID)),
          mergeDeep(model.info.options),
        ),
      ),
      headers: model.info.headers,
      messages: [
        { role: "system", content: COMPACTION_SUMMARY_SYSTEM_PROMPT } as ModelMessage,
        ...toModelMessageWithIDs(input.allMessages),
        {
          role: "user",
          content: [{ type: "text", text: userPrompt }],
        } as ModelMessage,
      ],
      model: wrapLanguageModel({
        model: model.language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, model.providerID, model.modelID)
              }
              return args.params
            },
          },
        ],
      }),
    })

    const text = await response.text
    log.info("summaries generated", { responseLength: text.length })

    return parseCompactionResponse(text)
  } catch (e) {
    log.error("Failed to generate summaries", { error: e })
    // Return empty summaries on failure - tool should still report validation success
    return {}
  }
}

export const CompactTool = Tool.define("compact", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    const normalized = normalizeRanges(params.ranges)

    // Check for overlaps first (cheaper than message lookups)
    validateNoOverlaps(normalized)

    // Load all messages for the session (needed for range collection)
    const allMessages = await Session.messages({ sessionID: ctx.sessionID })

    // Validate each range and collect messages
    const validatedRanges: Array<{
      range: NormalizedRange
      messages: MessageV2.WithParts[]
    }> = []

    for (const range of normalized) {
      const { messages } = await validateSingleRange(ctx.sessionID, range, allMessages)
      validatedRanges.push({ range, messages })
    }

    // Get model from session messages and generate summaries
    const model = getModelFromMessages(allMessages)
    let summaries: Record<string, CompactionSummary> = {}
    let summarizationError: string | null = null

    if (model) {
      try {
        summaries = await generateSummaries({
          sessionID: ctx.sessionID,
          allMessages,
          validatedRanges,
          model,
          abort: ctx.abort,
        })
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e)
        log.warn("Failed to generate summaries", { error: e })
        summarizationError = `Summarization failed: ${errorMsg}`
      }
    } else {
      log.info("No model information available in session, skipping summarization")
      summarizationError = "No model information available in session (no assistant messages yet)"
    }

    // Build success output with summaries and token estimates
    const totalMessages = validatedRanges.reduce((sum, r) => sum + r.messages.length, 0)
    let totalTokens = 0
    const rangeDetails = validatedRanges
      .map((r) => {
        const s = summaries[r.range.startMessageId]
        const summaryText = s?.summary ?? "No summary generated"
        const indexText = s?.indexTerms?.length ? s.indexTerms.join(", ") : "No index terms"
        const tokenEstimate = estimateTokensForMessages(r.messages)
        totalTokens += tokenEstimate
        return `[${r.range.startMessageId} to ${r.range.endMessageId} (${r.messages.length} message${r.messages.length === 1 ? "" : "s"}, ~${tokenEstimate.toLocaleString()} tokens)]
  Summary: ${summaryText}
  Index: ${indexText}`
      })
      .join("\n\n")

    const summaryCount = Object.keys(summaries).length
    const errorNote = summarizationError ? `\n\nNote: ${summarizationError}` : ""

    return {
      title: "Compaction summaries generated",
      output: `Generated summaries for ${normalized.length} range(s) (${summaryCount}/${normalized.length} successful):\n\n${rangeDetails}\n\nTotal: ${totalMessages} messages (~${totalTokens.toLocaleString()} tokens) ready for archival.${errorNote}`,
      metadata: {
        rangeCount: normalized.length,
        totalMessages,
        totalTokens,
        summaries,
        ...(summarizationError && { error: summarizationError }),
      },
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid compact input: ${details}`
  },
})
