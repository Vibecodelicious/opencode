import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./retrieve.txt"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { Token } from "../util/token"
import { Log } from "../util/log"

const log = Log.create({ service: "tool.retrieve" })

const Parameters = z.object({
  archiveId: z.string().min(1, "archiveId is required").describe("Identifier for the archived conversation to retrieve"),
})

/**
 * Metadata returned by the retrieve tool.
 * Covers both error cases (with error field) and success cases (with full details).
 */
type RetrieveMetadata = {
  archiveId: string
  error?: "not_found" | "not_anchor" | "broken_range_end" | "empty_range"
  rangeEnd?: string
  messageCount?: number
  tokenEstimate?: number
  summary?: string
  indexTerms?: string[]
}

/**
 * Fetches a message by ID from the session storage.
 * Returns the message info and parts, or null if not found.
 */
async function getMessage(sessionID: string, messageID: string): Promise<MessageV2.WithParts | null> {
  try {
    const result = await MessageV2.get({ sessionID, messageID })
    if (!result?.info) {
      return null
    }
    return result
  } catch (error) {
    log.debug("getMessage failed", { sessionID, messageID, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * Collects all messages in the archive range from anchor to rangeEnd.
 * Messages are filtered by ID range using lexicographic comparison.
 */
function collectMessagesInRange(
  allMessages: MessageV2.WithParts[],
  anchorId: string,
  rangeEnd: string,
): MessageV2.WithParts[] {
  return allMessages.filter((m) => m.info.id >= anchorId && m.info.id <= rangeEnd)
}

/**
 * Extracts text content from a message's parts for display.
 * Follows patterns from archive-context.ts.
 */
function extractMessageContent(msg: MessageV2.WithParts): string {
  const contentParts: string[] = []

  for (const part of msg.parts) {
    if (part.type === "text" && "text" in part && !part.ignored) {
      contentParts.push(part.text)
    }
    if (part.type === "tool" && part.state?.status === "completed" && part.state.output) {
      // Include tool name and output for context
      const toolName = part.tool ?? "unknown"
      contentParts.push(`[Tool: ${toolName}]\n${part.state.output}`)
    }
    if (part.type === "reasoning" && "text" in part) {
      contentParts.push(`[Reasoning]\n${part.text}`)
    }
  }

  return contentParts.join("\n\n")
}

/**
 * Formats a single message for LLM-readable output.
 * Includes message ID prefix for reference.
 */
function formatMessage(msg: MessageV2.WithParts): string {
  const role = msg.info.role === "user" ? "User message" : "Assistant message"
  const content = extractMessageContent(msg)

  if (!content.trim()) {
    return `[${msg.info.id}] ${role}: (empty)`
  }

  return `[${msg.info.id}] ${role}:\n${content}`
}

/**
 * Formats retrieved archive content for LLM readability.
 */
function formatRetrievedContent(
  archiveId: string,
  rangeEnd: string,
  messages: MessageV2.WithParts[],
): string {
  const header =
    archiveId === rangeEnd
      ? `Retrieved content from archive ${archiveId}:`
      : `Retrieved content from archive ${archiveId} to ${rangeEnd}:`

  const formattedMessages = messages.map(formatMessage).join("\n\n")

  return `${header}\n\n${formattedMessages}`
}

/**
 * Estimates token count for a set of messages by summing up text content.
 * Reuses pattern from compact.ts.
 */
function estimateTokensForMessages(messages: MessageV2.WithParts[]): number {
  let totalText = ""
  for (const msg of messages) {
    for (const part of msg.parts) {
      // Only count non-ignored text parts (matching extractMessageContent behavior)
      if (part.type === "text" && "text" in part && !part.ignored) {
        totalText += part.text
      }
      if (part.type === "tool" && part.state?.status === "completed" && part.state.output) {
        totalText += part.state.output
      }
      if (part.type === "reasoning" && "text" in part) {
        totalText += part.text
      }
    }
  }
  return Token.estimate(totalText)
}

export const RetrieveTool = Tool.define<typeof Parameters, RetrieveMetadata>("retrieve", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    const { archiveId } = params

    log.info("retrieving archive", { sessionID: ctx.sessionID, archiveId })

    // Step 1: Find the archive anchor message
    const anchor = await getMessage(ctx.sessionID, archiveId)

    if (!anchor) {
      log.warn("archive not found", { sessionID: ctx.sessionID, archiveId })
      return {
        title: "Archive retrieval failed",
        output: `Error: Message ${archiveId} does not exist. Please check the archive ID and try again.`,
        metadata: {
          error: "not_found",
          archiveId,
        },
      }
    }

    // Step 2: Verify the message is an archive anchor (has archive field)
    if (!anchor.info.archive) {
      log.warn("message is not an archive anchor", { sessionID: ctx.sessionID, archiveId })
      return {
        title: "Archive retrieval failed",
        output: `Error: Message ${archiveId} is not an archive anchor. It does not have archive metadata. The archiveId must be the first message ID shown in a [SMART_ARCHIVED: ...] placeholder.`,
        metadata: {
          error: "not_anchor",
          archiveId,
        },
      }
    }

    const archive = anchor.info.archive
    const rangeEnd = archive.rangeEnd

    // Step 3: Verify rangeEnd message exists (broken reference check)
    if (rangeEnd !== archiveId) {
      const rangeEndMessage = await getMessage(ctx.sessionID, rangeEnd)
      if (!rangeEndMessage) {
        log.error("broken rangeEnd reference", { sessionID: ctx.sessionID, archiveId, rangeEnd })
        return {
          title: "Archive retrieval failed",
          output: `Error: Archive ${archiveId} has a broken reference. The range end message ${rangeEnd} does not exist. This may indicate data corruption.`,
          metadata: {
            error: "broken_range_end",
            archiveId,
            rangeEnd,
          },
        }
      }
    }

    // Step 4: Load all session messages and collect the archive range
    const allMessages = await Session.messages({ sessionID: ctx.sessionID })
    const messagesInRange = collectMessagesInRange(allMessages, archiveId, rangeEnd)

    if (messagesInRange.length === 0) {
      log.error("no messages found in range", { sessionID: ctx.sessionID, archiveId, rangeEnd })
      return {
        title: "Archive retrieval failed",
        output: `Error: No messages found in archive range ${archiveId} to ${rangeEnd}. This may indicate data inconsistency.`,
        metadata: {
          error: "empty_range",
          archiveId,
          rangeEnd,
        },
      }
    }

    // Step 5: Format the content for LLM readability
    const formattedContent = formatRetrievedContent(archiveId, rangeEnd, messagesInRange)
    const tokenEstimate = estimateTokensForMessages(messagesInRange)

    log.info("archive retrieved successfully", {
      sessionID: ctx.sessionID,
      archiveId,
      rangeEnd,
      messageCount: messagesInRange.length,
      tokenEstimate,
    })

    return {
      title: "Retrieved archived content",
      output: formattedContent,
      metadata: {
        archiveId,
        rangeEnd,
        messageCount: messagesInRange.length,
        tokenEstimate,
        summary: archive.summary,
        indexTerms: archive.indexTerms,
      },
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid retrieve input: ${details}`
  },
})
