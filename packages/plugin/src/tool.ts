import type { Message as SDKMessage, Part } from "@opencode-ai/sdk/v2"
import { z } from "zod"

export type Message = SDKMessage & {
  metadata?: { [key: string]: any }
}

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  /**
   * Full conversation messages for the current session.
   * Each entry contains the message info and its associated parts.
   */
  messages: Array<{ info: Message; parts: Part[] }>
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
  /**
   * Update a message by ID.
   * Identity fields (`id`, `sessionID`, `role`) are immutable.
   */
  updateMessage(id: string, fn: (draft: Message) => void): Promise<void>
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
