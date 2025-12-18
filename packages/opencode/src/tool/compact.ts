import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./compact.txt"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"

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

    // Build success output
    const totalMessages = validatedRanges.reduce((sum, r) => sum + r.messages.length, 0)
    const rangeDescriptions = validatedRanges
      .map(
        (r) =>
          `[${r.range.startMessageId} to ${r.range.endMessageId} (${r.messages.length} message${r.messages.length === 1 ? "" : "s"})]`,
      )
      .join(", ")

    return {
      title: "Compaction validation",
      output: `Validated ${normalized.length} range(s) for compaction: ${rangeDescriptions}. Total: ${totalMessages} messages. Ready for summarization.`,
      metadata: {
        rangeCount: normalized.length,
        totalMessages,
      },
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid compact input: ${details}`
  },
})
