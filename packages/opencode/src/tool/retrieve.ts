import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./retrieve.txt"

const Parameters = z.object({
  archiveId: z.string().min(1, "archiveId is required").describe("Identifier for the archived conversation to retrieve"),
})

export const RetrieveTool = Tool.define("retrieve", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params) {
    return {
      title: "Retrieve placeholder",
      output: `Not yet implemented: retrieval stub for archive ${params.archiveId}.`,
      metadata: {},
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid retrieve input: ${details}`
  },
})
