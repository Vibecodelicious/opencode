import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./compact.txt"

const RangeSchema = z.object({
  startMessageId: z.string().min(1, "startMessageId is required").describe("First message ID in the range"),
  endMessageId: z.string().min(1).optional().describe("Optional last message ID in the range (inclusive)"),
})

const Parameters = z.object({
  ranges: z
    .array(RangeSchema, {
      invalid_type_error: "ranges must be an array of message ID ranges",
    })
    .nonempty("ranges must include at least one range")
    .describe("Message ranges to consider for compaction preparation"),
})

export const CompactTool = Tool.define("compact", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params) {
    const rangeCount = params.ranges.length
    return {
      title: "Compaction placeholder",
      output: `Not yet implemented: compaction stub received ${rangeCount} range(s).`,
      metadata: {},
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid compact input: ${details}`
  },
})
