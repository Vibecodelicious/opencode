import { describe, expect, test } from "bun:test"

import { toModelMessageWithIDs } from "../../src/session/archive-context"
import { MessageV2 } from "../../src/session/message-v2"

/**
 * Tests for toModelMessageWithIDs() - the ID-annotated context builder.
 *
 * This function is used ONLY for the compaction summarization LLM call.
 * It ALWAYS prefixes messages with [msg_xxx] IDs (no flag check).
 *
 * Contrast with toModelMessage() in message-v2.ts which:
 * - Default/compactionModeEnabled:false → NO ID prefixes
 * - compactionModeEnabled:true → WITH ID prefixes
 *
 * The summarization LLM must always see IDs to reference specific messages.
 */

const baseUser = {
  id: "msg_user",
  sessionID: "ses",
  role: "user" as const,
  time: { created: Date.now() },
  agent: "build",
  model: { providerID: "opencode", modelID: "opencode" },
}

const baseAssistant = {
  id: "msg_assistant",
  sessionID: "ses",
  role: "assistant" as const,
  time: { created: Date.now() },
  parentID: "msg_user",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "build",
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const basePart = {
  id: "prt",
  sessionID: "ses",
  messageID: "msg_user",
}

describe("toModelMessageWithIDs", () => {
  test("prefixes user and assistant text parts with message IDs", () => {
    const input = [
      {
        info: baseUser,
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Hello",
          },
        ],
      },
      {
        info: baseAssistant,
        parts: [
          {
            ...basePart,
            messageID: "msg_assistant",
            type: "text" as const,
            text: "Response",
          },
        ],
      },
    ]

    const result = toModelMessageWithIDs(input as any)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[msg_user] Hello")
    expect(serialized).toContain("[msg_assistant] Response")
  })

  test("preserves non-text parts and skips ignored text", () => {
    const input = [
      {
        info: baseUser,
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Ignored",
            ignored: true,
          },
          {
            ...basePart,
            id: "file_part",
            type: "file" as const,
            mime: "image/png",
            filename: "pic.png",
            url: "http://example.com/pic.png",
          },
        ],
      },
    ]

    const result = toModelMessageWithIDs(input as any)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain("Ignored")
    expect(serialized).toContain("http://example.com/pic.png")
  })

  test("renders archive placeholder with ID prefix and omits follower", () => {
    const input = [
      {
        info: {
          ...baseAssistant,
          id: "msg_anchor",
          archive: {
            summary: "summarized",
            indexTerms: ["a", "b"],
            rangeEnd: "msg_follower",
          },
        },
        parts: [
          {
            ...basePart,
            messageID: "msg_anchor",
            type: "text" as const,
            text: "Archived content",
          },
        ],
      },
      {
        info: {
          ...baseAssistant,
          id: "msg_follower",
          archivedBy: "msg_anchor",
        },
        parts: [
          {
            ...basePart,
            id: "prt_follower",
            messageID: "msg_follower",
            type: "text" as const,
            text: "Should not appear",
          },
        ],
      },
    ]

    const result = toModelMessageWithIDs(input as any)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[msg_anchor] [SMART_ARCHIVED: msg_anchor to msg_follower]")
    expect(serialized).toContain("Summary: summarized")
    expect(serialized).toContain("Index: a, b")
    expect(serialized).not.toContain("Should not appear")
    expect(serialized).not.toContain("Archived content")
  })

  test("keeps tool outputs structured and prefixes assistant text", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: baseAssistant,
        parts: [
          {
            ...basePart,
            messageID: "msg_assistant",
            type: "text",
            text: "Pre-tool",
          },
          {
            ...basePart,
            id: "tool_part",
            messageID: "msg_assistant",
            type: "tool",
            callID: "call_1",
            tool: "echo",
            state: {
              status: "completed",
              input: { value: "x" },
              output: "Echo output",
              title: "Echo",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
              attachments: [
                {
                  url: "http://example.com/file.txt",
                  mime: "text/plain",
                  filename: "file.txt",
                },
              ],
            },
          },
          {
            ...basePart,
            id: "prt_reason",
            messageID: "msg_assistant",
            type: "reasoning",
            text: "Internal thought",
          },
          {
            ...basePart,
            id: "prt_patch",
            messageID: "msg_assistant",
            type: "patch",
            hash: "h1",
            files: ["a.ts", "b.ts"],
          },
          {
            ...basePart,
            id: "prt_snapshot",
            messageID: "msg_assistant",
            type: "snapshot",
            snapshot: "snap_1",
          },
          {
            ...basePart,
            id: "prt_agent",
            messageID: "msg_assistant",
            type: "agent",
            name: "helper",
          },
          {
            ...basePart,
            id: "prt_retry",
            messageID: "msg_assistant",
            type: "retry",
            attempt: 2,
            error: {
              name: "APIError",
              message: "timeout",
              isRetryable: true,
            },
            time: { created: Date.now() },
          },
          {
            ...basePart,
            id: "prt_finish",
            messageID: "msg_assistant",
            type: "step-finish",
            reason: "done",
            snapshot: "snap_2",
            cost: 5,
            tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
      },
    ]

    const result = toModelMessageWithIDs(input)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[msg_assistant] Pre-tool")
    expect(serialized).toContain("[msg_assistant] Tool echo returned an attachment [continued]:")
    expect(serialized).toContain("http://example.com/file.txt")
    expect(serialized).toContain("tool-call")
    expect(serialized).toContain("Echo output")
    expect(serialized).toContain("[msg_assistant] Internal thought")
    expect(serialized).toContain("[msg_assistant] [PATCH h1] a.ts, b.ts")
    expect(serialized).toContain("[msg_assistant] [SNAPSHOT] snap_1")
    expect(serialized).toContain("[msg_assistant] [AGENT helper]")
    expect(serialized).toContain("[msg_assistant] [RETRY attempt=2]")
    expect(serialized).toContain("[msg_assistant] [STEP-FINISH reason=done] cost=5 tokens: input=10, output=20")
  })

  test("renders tool errors without crashing or output-available entries", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: {
          ...baseAssistant,
          id: "msg_error",
        },
        parts: [
          {
            ...basePart,
            id: "tool_error",
            messageID: "msg_error",
            type: "tool",
            tool: "fail",
            callID: "call_err",
            state: {
              status: "error",
              input: { val: 1 },
              error: "boom",
              time: { start: Date.now(), end: Date.now() },
            },
            metadata: { trace: "t1" },
          },
        ],
      },
    ]

    const result = toModelMessageWithIDs(input)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("tool-result")
    expect(serialized).toContain("error-text")
    expect(serialized).toContain("boom")
    expect(serialized).not.toContain("output-available")
  })
})

describe("toModelMessageWithIDs vs toModelMessage differentiation", () => {
  test("toModelMessageWithIDs ALWAYS prefixes IDs (no flag, no options)", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: baseUser,
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Test message",
          },
        ],
      },
    ]

    // toModelMessageWithIDs has NO options parameter - it ALWAYS prefixes
    const result = toModelMessageWithIDs(input as any)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[msg_user] Test message")
  })

  test("toModelMessage with default options does NOT prefix IDs", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: baseUser,
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Test message",
          },
        ],
      },
    ]

    // toModelMessage with no options (or compactionModeEnabled: false) hides IDs
    const result = MessageV2.toModelMessage(input as any)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("Test message")
    expect(serialized).not.toContain("[msg_user]")
    expect(serialized).not.toContain("[msg_")
  })

  test("toModelMessage with compactionModeEnabled:true DOES prefix IDs", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: baseUser,
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Test message",
          },
        ],
      },
    ]

    // toModelMessage with compactionModeEnabled: true prefixes IDs
    const result = MessageV2.toModelMessage(input as any, { compactionModeEnabled: true })
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[msg_user] Test message")
  })

  test("same input produces different output based on function choice", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: baseUser,
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Hello world",
          },
        ],
      },
      {
        info: baseAssistant,
        parts: [
          {
            ...basePart,
            messageID: "msg_assistant",
            type: "text" as const,
            text: "Response here",
          },
        ],
      },
    ]

    // toModelMessageWithIDs: ALWAYS with IDs (for summarization)
    const withIds = toModelMessageWithIDs(input as any)
    const withIdsSerialized = JSON.stringify(withIds)
    expect(withIdsSerialized).toContain("[msg_user] Hello world")
    expect(withIdsSerialized).toContain("[msg_assistant] Response here")

    // toModelMessage default: NO IDs (for main conversation)
    const noIds = MessageV2.toModelMessage(input as any)
    const noIdsSerialized = JSON.stringify(noIds)
    expect(noIdsSerialized).toContain("Hello world")
    expect(noIdsSerialized).toContain("Response here")
    expect(noIdsSerialized).not.toContain("[msg_user]")
    expect(noIdsSerialized).not.toContain("[msg_assistant]")

    // toModelMessage with flag: WITH IDs (for two-phase compaction)
    const withFlag = MessageV2.toModelMessage(input as any, { compactionModeEnabled: true })
    const withFlagSerialized = JSON.stringify(withFlag)
    expect(withFlagSerialized).toContain("[msg_user] Hello world")
    expect(withFlagSerialized).toContain("[msg_assistant] Response here")
  })
})
