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
import { Storage } from "../storage/storage"
import { Config } from "../config/config"
import { Permission } from "../permission"

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

/**
 * A normalized message range with both start and end message IDs.
 * Used internally to represent validated compaction ranges.
 */
export interface NormalizedRange {
  /** ID of the first message in the range */
  startMessageId: string
  /** ID of the last message in the range (inclusive) */
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

    // Validate non-empty content - reject empty summaries
    const summary = v.summary.trim()
    if (summary.length === 0) {
      log.warn("skipping entry with empty summary", { key })
      continue
    }

    const indexTerms = v.indexTerms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 7)
    if (indexTerms.length === 0) {
      log.warn("skipping entry with no valid index terms", { key })
      continue
    }

    result[key] = { summary, indexTerms }
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

// ============================================================================
// Archive Metadata Storage (Story 2.3)
// ============================================================================

/**
 * Input for storing archive metadata to messages.
 */
export interface ArchiveMetadataInput {
  /** The session ID containing the messages to archive */
  sessionID: string
  /** Validated ranges with their messages, ready for archival */
  validatedRanges: Array<{
    range: NormalizedRange
    messages: MessageV2.WithParts[]
  }>
  /** Summaries keyed by startMessageId for each range */
  summaries: Record<string, CompactionSummary>
}

/**
 * Result of storing archive metadata.
 */
export interface ArchiveMetadataResult {
  /** Number of messages successfully archived */
  archivedCount: number
  /** Number of messages skipped (already archived by concurrent operations) */
  skippedCount: number
  /** Error messages for ranges that failed to archive */
  errors: string[]
}

/**
 * Stores archive metadata to messages for the given ranges.
 *
 * ## Behavior
 * - First unarchived message in each range becomes the anchor with `archive` field
 * - Subsequent unarchived messages get `archivedBy` field pointing to anchor
 * - If original first message is already archived, next unarchived message is promoted to anchor
 * - Original message content is preserved (only metadata fields are added)
 *
 * ## Atomicity Guarantees
 *
 * This function provides the following guarantees backed by Storage.update():
 *
 * 1. **Per-message atomicity**: Each message update via Storage.update() is atomic.
 *    The file is read, modified, and written under an exclusive lock (Lock.write()).
 *    If the process crashes during write, Bun's atomic write (temp file + rename)
 *    ensures the file remains in its pre-update state.
 *
 * 2. **Partial range success**: If a range fails mid-way (e.g., Storage.update() throws),
 *    messages already archived remain archived. The anchor's rangeEnd is corrected to
 *    the actual last archived message, ensuring no orphaned archivedBy references point
 *    to non-existent anchors within this operation.
 *
 * 3. **Crash recovery**: On crash, the worst case is:
 *    - Some messages in a range are archived, others aren't
 *    - The anchor's rangeEnd may be incorrect (will be corrected on next archive attempt
 *      or can be detected via validateArchiveReferences())
 *    - Original content is NEVER lost (we only add metadata fields, never modify parts[])
 *
 * 4. **Race condition protection**: Each message update checks inside the lock if the
 *    message was already archived by a concurrent operation, and skips if so. This
 *    prevents duplicate archival and ensures consistent state.
 *
 * 5. **RangeEnd ownership verification**: When correcting rangeEnd after partial archival,
 *    we verify the anchor's summary matches our operation to avoid overwriting concurrent
 *    operations' rangeEnd values.
 *
 * @see Storage.update for the underlying atomic update implementation
 *
 * ## Idempotency
 * This function is idempotent in terms of final state - calling it multiple times with the
 * same input produces the same archived messages. However, the return value differs:
 * - First call: `archivedCount = N` (messages archived)
 * - Subsequent calls: `archivedCount = 0, skippedCount = N` (messages already archived)
 *
 * @param input - The session ID, validated ranges, and summaries to archive
 * @returns Result containing counts of archived/skipped messages and any errors
 */
export async function storeArchiveMetadata(input: ArchiveMetadataInput): Promise<ArchiveMetadataResult> {
  const errors: string[] = []
  let archivedCount = 0
  let skippedCount = 0

  for (const { range, messages } of input.validatedRanges) {
    const summary = input.summaries[range.startMessageId]
    if (!summary) {
      errors.push(`No summary found for range starting at ${range.startMessageId}`)
      continue
    }

    // Defensive check: skip ranges with no messages (shouldn't happen but prevents errors)
    if (messages.length === 0) {
      log.warn("range has no messages, skipping", {
        sessionID: input.sessionID,
        startMessageId: range.startMessageId,
        endMessageId: range.endMessageId,
      })
      continue
    }

    // Declare outside try so catch can access them for rangeEnd correction
    let anchorId: string | null = null
    let actualRangeEnd: string | null = null
    let rangeArchivedCount = 0
    let rangeSkippedCount = 0

    try {
      // Single pass: dynamically select anchor and archive messages
      // Anchor selection happens inside Storage.update lock to handle races
      for (const msg of messages) {
        // Pre-check: skip messages already archived in our input data.
        // This avoids unnecessary I/O while still handling concurrent races inside the lock.
        if (msg.info.archive || msg.info.archivedBy) {
          log.debug("message already archived in input data, skipping", {
            messageID: msg.info.id,
            existingArchive: !!msg.info.archive,
            existingArchivedBy: msg.info.archivedBy,
          })
          rangeSkippedCount++
          continue
        }

        await Storage.update<MessageV2.Info>(["message", input.sessionID, msg.info.id], (draft) => {
          // Race condition protection: skip if archived by concurrent operation
          if (draft.archive || draft.archivedBy) {
            log.debug("message already archived by concurrent operation, skipping", {
              messageID: msg.info.id,
              existingArchive: !!draft.archive,
              existingArchivedBy: draft.archivedBy,
            })
            rangeSkippedCount++
            return
          }

          if (anchorId === null) {
            // First unarchived message becomes the anchor
            anchorId = msg.info.id
            draft.archive = {
              summary: summary.summary,
              indexTerms: summary.indexTerms,
              rangeEnd: range.endMessageId, // May update later if end messages were skipped
            }
          } else {
            // Subsequent unarchived messages point to the anchor
            draft.archivedBy = anchorId
          }
          actualRangeEnd = msg.info.id
          rangeArchivedCount++
        })
      }

      // Correct anchor's rangeEnd if the actual last archived message differs from intended.
      // This handles: (a) some end messages skipped due to pre-archival, (b) only anchor archived.
      // Safety: verify archive ownership via summary match to avoid overwriting concurrent operations.
      if (anchorId && actualRangeEnd && actualRangeEnd !== range.endMessageId) {
        const correctedRangeEnd = actualRangeEnd // Capture for closure (TypeScript narrowing)
        const expectedSummary = summary.summary // Verify ownership before correcting
        await Storage.update<MessageV2.Info>(["message", input.sessionID, anchorId], (draft) => {
          // Only correct rangeEnd if this archive was created by us (same summary)
          // This prevents overwriting a concurrent operation's rangeEnd
          if (draft.archive && draft.archive.summary === expectedSummary) {
            draft.archive.rangeEnd = correctedRangeEnd
          }
        })
      }

      archivedCount += rangeArchivedCount
      skippedCount += rangeSkippedCount

      if (anchorId) {
        log.info("archived range", {
          sessionID: input.sessionID,
          anchorMessageId: anchorId,
          actualRangeEnd,
          messageCount: rangeArchivedCount,
          skippedCount: rangeSkippedCount,
        })
      } else {
        log.info("range fully archived by concurrent operations, skipped", {
          sessionID: input.sessionID,
          originalStart: range.startMessageId,
          originalEnd: range.endMessageId,
          skippedCount: rangeSkippedCount,
        })
      }
    } catch (e) {
      // Fix rangeEnd if we partially archived before failure
      if (anchorId && actualRangeEnd) {
        // Count the partially archived messages regardless of rangeEnd fix success
        archivedCount += rangeArchivedCount
        skippedCount += rangeSkippedCount

        const correctedRangeEnd = actualRangeEnd // Capture for closure (TypeScript narrowing)
        const expectedSummary = summary.summary // Verify ownership before correcting
        try {
          await Storage.update<MessageV2.Info>(["message", input.sessionID, anchorId], (draft) => {
            // Only correct rangeEnd if this archive was created by us (same summary)
            if (draft.archive && draft.archive.summary === expectedSummary) {
              draft.archive.rangeEnd = correctedRangeEnd
            }
          })
          log.debug("fixed anchor rangeEnd after partial failure", {
            sessionID: input.sessionID,
            anchorId,
            actualRangeEnd,
            archivedCount: rangeArchivedCount,
          })
        } catch (updateError) {
          log.error("failed to update anchor rangeEnd after partial failure", {
            anchorId,
            actualRangeEnd,
            error: updateError,
          })
        }
      }

      const errorMsg = e instanceof Error ? e.message : String(e)
      errors.push(`Failed to archive range ${range.startMessageId}: ${errorMsg}`)
      log.error("failed to archive range", {
        sessionID: input.sessionID,
        startMessageId: range.startMessageId,
        error: e,
      })
      // Continue with next range - partial archival is acceptable
    }
  }

  return { archivedCount, skippedCount, errors }
}

// ============================================================================
// Reference Validation (Story 2.7)
// ============================================================================

/**
 * Result of validating archive references in a session.
 */
export interface ReferenceValidationResult {
  /** Whether all references are valid */
  valid: boolean
  /** Message IDs that have archivedBy but no corresponding anchor */
  orphanedMessages: string[]
  /** Anchor IDs whose rangeEnd points to a non-existent message */
  brokenAnchors: string[]
}

/**
 * Validates archive references in a session for consistency.
 *
 * Checks for:
 * 1. Orphaned archivedBy references - messages pointing to anchors that don't exist
 * 2. Broken rangeEnd references - anchors pointing to non-existent end messages
 *
 * This function is useful for:
 * - Debugging archive consistency issues
 * - Validating data integrity after crash recovery
 * - Identifying corruption from concurrent operations
 *
 * Note: For non-existent sessions, this returns `{valid: true, orphanedMessages: [], brokenAnchors: []}`
 * (vacuously true - no messages means no invalid references). Use Session.get() first if you
 * need to verify the session exists.
 *
 * @param sessionID - The session to validate
 * @returns Validation result with lists of orphaned/broken references
 */
export async function validateArchiveReferences(sessionID: string): Promise<ReferenceValidationResult> {
  const messages = await Session.messages({ sessionID })

  // Warn about potential performance impact for large sessions
  if (messages.length > 1000) {
    log.warn("validating references for large session - this may be slow", {
      sessionID,
      messageCount: messages.length,
    })
  }

  // Collect all archive anchors
  const archiveAnchors = new Map<string, MessageV2.Archive>()
  for (const msg of messages) {
    if (msg.info.archive) {
      archiveAnchors.set(msg.info.id, msg.info.archive)
    }
  }

  // Check for orphaned archivedBy references
  const orphanedMessages: string[] = []
  for (const msg of messages) {
    if (msg.info.archivedBy) {
      if (!archiveAnchors.has(msg.info.archivedBy)) {
        orphanedMessages.push(msg.info.id)
      }
    }
  }

  // Check for broken rangeEnd references
  const messageIds = new Set(messages.map((m) => m.info.id))
  const brokenAnchors: string[] = []
  for (const [anchorId, archive] of archiveAnchors) {
    if (archive.rangeEnd && !messageIds.has(archive.rangeEnd)) {
      brokenAnchors.push(anchorId)
    }
  }

  const valid = orphanedMessages.length === 0 && brokenAnchors.length === 0

  if (!valid) {
    log.warn("archive reference validation failed", {
      sessionID,
      orphanedCount: orphanedMessages.length,
      brokenAnchorCount: brokenAnchors.length,
    })
  }

  return {
    valid,
    orphanedMessages,
    brokenAnchors,
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

    // Validate each range and collect messages (with token estimates calculated once)
    const validatedRanges: Array<{
      range: NormalizedRange
      messages: MessageV2.WithParts[]
      tokenEstimate: number
    }> = []

    for (const range of normalized) {
      const { messages } = await validateSingleRange(ctx.sessionID, range, allMessages)
      const tokenEstimate = estimateTokensForMessages(messages)
      validatedRanges.push({ range, messages, tokenEstimate })
    }

    // Read compaction mode from config
    const config = await Config.get()
    const compactionMode: "ask" | "notify" | "silent" = config.compaction?.mode ?? "notify"

    // Calculate totals once - used by ask mode, silent mode, and output building
    const totalMessages = validatedRanges.reduce((sum, r) => sum + r.messages.length, 0)
    const totalTokens = validatedRanges.reduce((sum, r) => sum + r.tokenEstimate, 0)

    // Build range descriptions once - used by ask mode permission dialog and output
    const rangeDescriptions = validatedRanges
      .map((r) => {
        return `${r.range.startMessageId} to ${r.range.endMessageId}: ${r.messages.length} msg, ~${r.tokenEstimate.toLocaleString()} tokens`
      })
      .join("; ")

    // ASK MODE: Use Permission system to request user approval via native TUI
    // Permission metadata structure for compact tool:
    // - ranges: Original range parameters from tool call
    // - totalMessages: Count of messages across all ranges
    // - totalTokens: Estimated token count for all messages in ranges
    // - rangeDescriptions: Human-readable summary of each range (IDs, count, tokens)
    if (compactionMode === "ask") {
      log.info("ask mode: requesting permission", {
        sessionID: ctx.sessionID,
        rangeCount: normalized.length,
        totalMessages,
        totalTokens,
      })

      try {
        // Request permission via native TUI dialog
        // Throws Permission.RejectedError if user declines
        await Permission.ask({
          type: "compact",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          title: `Archive ${totalMessages} message${totalMessages === 1 ? "" : "s"} (~${totalTokens.toLocaleString()} tokens)`,
          metadata: {
            ranges: params.ranges,
            totalMessages,
            totalTokens,
            rangeDescriptions,
          },
        })
        // If we reach here, permission was granted - continue with compaction
        log.info("ask mode: permission granted, proceeding with compaction", {
          sessionID: ctx.sessionID,
          rangeCount: normalized.length,
          totalMessages,
          totalTokens,
        })
      } catch (e) {
        if (e instanceof Permission.RejectedError) {
          log.info("ask mode: permission denied, compaction cancelled", {
            sessionID: ctx.sessionID,
            rangeCount: normalized.length,
            totalMessages,
            totalTokens,
          })
        }
        throw e
      }
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

    // Store archive metadata to messages (only if we have summaries)
    let archivalResult: ArchiveMetadataResult = { archivedCount: 0, skippedCount: 0, errors: [] }
    if (Object.keys(summaries).length > 0) {
      archivalResult = await storeArchiveMetadata({
        sessionID: ctx.sessionID,
        validatedRanges,
        summaries,
      })
    }

    // Build success output with summaries (totalMessages/totalTokens already calculated above)
    const summaryCount = Object.keys(summaries).length
    const archived = archivalResult.archivedCount > 0

    // SILENT MODE: Return minimal output - user configured to not see compaction details
    if (compactionMode === "silent") {
      return {
        title: archived ? "Compaction complete" : "Compaction ready",
        output: "", // Silent mode: no output text for LLM to present
        metadata: {
          rangeCount: normalized.length,
          totalMessages,
          totalTokens,
          summaries,
          archived: archivalResult.archivedCount,
          ...(archivalResult.skippedCount > 0 && { skipped: archivalResult.skippedCount }),
          ...(archivalResult.errors.length > 0 && { archivalErrors: archivalResult.errors }),
          ...(summarizationError && { error: summarizationError }),
        },
      }
    }

    // NOTIFY/ASK MODE: Build detailed output for user feedback
    const rangeDetails = validatedRanges
      .map((r) => {
        const s = summaries[r.range.startMessageId]
        const summaryText = s?.summary ?? "No summary generated"
        const indexText = s?.indexTerms?.length ? s.indexTerms.join(", ") : "No index terms"
        return `[${r.range.startMessageId} to ${r.range.endMessageId} (${r.messages.length} message${r.messages.length === 1 ? "" : "s"}, ~${r.tokenEstimate.toLocaleString()} tokens)]
  Summary: ${summaryText}
  Index: ${indexText}`
      })
      .join("\n\n")

    const errorNote = summarizationError ? `\n\nNote: ${summarizationError}` : ""
    const archivalNote =
      archivalResult.errors.length > 0 ? `\n\nArchival issues: ${archivalResult.errors.join("; ")}` : ""
    const skippedNote =
      archivalResult.skippedCount > 0
        ? `\n\nSkipped ${archivalResult.skippedCount} message(s) already archived by concurrent operation.`
        : ""

    const title = archived ? "Compaction complete" : "Compaction summaries generated"
    const statusText = archived
      ? `Archived ${archivalResult.archivedCount} messages (~${totalTokens.toLocaleString()} tokens) across ${summaryCount} range(s).`
      : `${totalMessages} messages (~${totalTokens.toLocaleString()} tokens) ready for archival.`

    return {
      title,
      output: `Generated summaries for ${normalized.length} range(s) (${summaryCount}/${normalized.length} successful):\n\n${rangeDetails}\n\nTotal: ${statusText}${errorNote}${archivalNote}${skippedNote}`,
      metadata: {
        rangeCount: normalized.length,
        totalMessages,
        totalTokens,
        summaries,
        archived: archivalResult.archivedCount,
        ...(archivalResult.skippedCount > 0 && { skipped: archivalResult.skippedCount }),
        ...(archivalResult.errors.length > 0 && { archivalErrors: archivalResult.errors }),
        ...(summarizationError && { error: summarizationError }),
      },
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid compact input: ${details}`
  },
})
