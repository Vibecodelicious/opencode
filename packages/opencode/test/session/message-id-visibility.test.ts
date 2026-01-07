import { describe, expect, test } from "bun:test"

import { MessageV2 } from "../../src/session/message-v2"

const baseUser: MessageV2.User = {
  id: "msg_user123",
  sessionID: "ses_test",
  role: "user",
  time: { created: Date.now() },
  agent: "build",
  model: { providerID: "opencode", modelID: "opencode" },
}

const baseAssistant: MessageV2.Assistant = {
  id: "msg_assistant456",
  sessionID: "ses_test",
  role: "assistant",
  time: { created: Date.now() },
  parentID: "msg_user123",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "build",
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const basePart = {
  id: "prt_test",
  sessionID: "ses_test",
  messageID: "msg_user123",
}

describe("toModelMessage ID visibility", () => {
  describe("default behavior (no options)", () => {
    test("does NOT prefix user text with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [
            {
              ...basePart,
              type: "text" as const,
              text: "Fix the login page",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input)
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("Fix the login page")
      expect(serialized).not.toContain("[msg_user123]")
      expect(serialized).not.toContain("[msg_")
    })

    test("does NOT prefix assistant text with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "text" as const,
              text: "I'll help you fix that",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input)
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("I'll help you fix that")
      expect(serialized).not.toContain("[msg_assistant456]")
      expect(serialized).not.toContain("[msg_")
    })

    test("does NOT prefix context-gauge with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "context-gauge" as const,
              tokenCount: 50000,
              contextLimit: 100000,
              percentage: 50,
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input)
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("CONTEXT GAUGE")
      expect(serialized).not.toContain("[msg_assistant456]")
      expect(serialized).not.toContain("[msg_")
    })
  })

  describe("compactionModeEnabled: false (explicit)", () => {
    test("does NOT prefix user text with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [
            {
              ...basePart,
              type: "text" as const,
              text: "Check the API endpoint",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: false })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("Check the API endpoint")
      expect(serialized).not.toContain("[msg_user123]")
      expect(serialized).not.toContain("[msg_")
    })

    test("does NOT prefix assistant text with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "text" as const,
              text: "Looking at the endpoint now",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: false })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("Looking at the endpoint now")
      expect(serialized).not.toContain("[msg_assistant456]")
      expect(serialized).not.toContain("[msg_")
    })
  })

  describe("compactionModeEnabled: true", () => {
    test("DOES prefix user text with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [
            {
              ...basePart,
              type: "text" as const,
              text: "Fix the login page",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[msg_user123] Fix the login page")
    })

    test("DOES prefix assistant text with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "text" as const,
              text: "I'll help you fix that",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[msg_assistant456] I'll help you fix that")
    })

    test("DOES prefix context-gauge with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "context-gauge" as const,
              tokenCount: 50000,
              contextLimit: 100000,
              percentage: 50,
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[msg_assistant456] [CONTEXT GAUGE:")
    })

    test("DOES prefix reasoning parts with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "reasoning" as const,
              text: "Let me think about this",
              time: { start: Date.now(), end: Date.now() },
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[msg_assistant456] Let me think about this")
    })

    test("DOES prefix compaction and subtask parts with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [
            {
              ...basePart,
              type: "compaction" as const,
              auto: false,
            },
            {
              ...basePart,
              id: "prt_subtask",
              type: "subtask" as const,
              prompt: "test",
              description: "test subtask",
              agent: "build",
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[msg_user123] What did we do so far?")
      expect(serialized).toContain("[msg_user123] The following tool was executed by the user")
    })

    test("DOES prefix tool attachment messages with message ID", () => {
      const input: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant456",
              type: "tool" as const,
              callID: "call_123",
              tool: "screenshot",
              state: {
                status: "completed",
                input: {},
                output: "screenshot taken",
                title: "Screenshot",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
                attachments: [
                  {
                    id: "file_1",
                    sessionID: "ses_test",
                    messageID: "msg_assistant456",
                    type: "file",
                    url: "file://screenshot.png",
                    mime: "image/png",
                    filename: "screenshot.png",
                  },
                ],
              },
            },
          ],
        },
      ]

      const result = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[msg_assistant456] Tool screenshot returned an attachment:")
    })
  })

  describe("archive placeholders always retain IDs", () => {
    test("archive placeholder includes message ID regardless of compactionModeEnabled flag", () => {
      const archivedUser: MessageV2.User = {
        ...baseUser,
        id: "msg_archived",
        archive: {
          summary: "User asked about login",
          indexTerms: ["login", "authentication"],
          rangeEnd: "msg_archived",
        },
      }

      const input: MessageV2.WithParts[] = [
        {
          info: archivedUser,
          parts: [
            {
              ...basePart,
              messageID: "msg_archived",
              type: "text" as const,
              text: "This should not appear",
            },
          ],
        },
      ]

      // Test with compactionModeEnabled: false
      const resultFalse = MessageV2.toModelMessage(input, { compactionModeEnabled: false })
      const serializedFalse = JSON.stringify(resultFalse)

      expect(serializedFalse).toContain("[SMART_ARCHIVED: msg_archived]")
      expect(serializedFalse).toContain("Summary: User asked about login")
      expect(serializedFalse).not.toContain("This should not appear")

      // Test with compactionModeEnabled: true
      const resultTrue = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const serializedTrue = JSON.stringify(resultTrue)

      expect(serializedTrue).toContain("[SMART_ARCHIVED: msg_archived]")
      expect(serializedTrue).toContain("Summary: User asked about login")
      expect(serializedTrue).not.toContain("This should not appear")
    })

    test("archive placeholder with range includes both message IDs", () => {
      const archivedUser: MessageV2.User = {
        ...baseUser,
        id: "msg_anchor",
        archive: {
          summary: "Conversation about deployment",
          indexTerms: ["deploy", "kubernetes"],
          rangeEnd: "msg_end",
        },
      }

      const input: MessageV2.WithParts[] = [
        {
          info: archivedUser,
          parts: [],
        },
      ]

      const result = MessageV2.toModelMessage(input)
      const serialized = JSON.stringify(result)

      expect(serialized).toContain("[SMART_ARCHIVED: msg_anchor to msg_end]")
      expect(serialized).toContain("Summary: Conversation about deployment")
    })
  })

  describe("mixed messages", () => {
    test("handles a conversation with multiple message types", () => {
      const user1: MessageV2.User = {
        ...baseUser,
        id: "msg_u1",
      }
      const assistant1: MessageV2.Assistant = {
        ...baseAssistant,
        id: "msg_a1",
        parentID: "msg_u1",
      }
      const user2: MessageV2.User = {
        ...baseUser,
        id: "msg_u2",
      }

      const input: MessageV2.WithParts[] = [
        {
          info: user1,
          parts: [
            { ...basePart, messageID: "msg_u1", type: "text" as const, text: "Hello" },
          ],
        },
        {
          info: assistant1,
          parts: [
            { ...basePart, messageID: "msg_a1", type: "text" as const, text: "Hi there" },
            {
              ...basePart,
              id: "prt_gauge",
              messageID: "msg_a1",
              type: "context-gauge" as const,
              tokenCount: 1000,
              contextLimit: 100000,
              percentage: 1,
            },
          ],
        },
        {
          info: user2,
          parts: [
            { ...basePart, messageID: "msg_u2", type: "text" as const, text: "Thanks" },
          ],
        },
      ]

      // Default: no IDs
      const resultNoIds = MessageV2.toModelMessage(input)
      const noIdsSerialized = JSON.stringify(resultNoIds)

      expect(noIdsSerialized).toContain("Hello")
      expect(noIdsSerialized).toContain("Hi there")
      expect(noIdsSerialized).toContain("Thanks")
      expect(noIdsSerialized).toContain("CONTEXT GAUGE")
      expect(noIdsSerialized).not.toContain("[msg_u1]")
      expect(noIdsSerialized).not.toContain("[msg_a1]")
      expect(noIdsSerialized).not.toContain("[msg_u2]")

      // Compaction mode: with IDs
      const resultWithIds = MessageV2.toModelMessage(input, { compactionModeEnabled: true })
      const withIdsSerialized = JSON.stringify(resultWithIds)

      expect(withIdsSerialized).toContain("[msg_u1] Hello")
      expect(withIdsSerialized).toContain("[msg_a1] Hi there")
      expect(withIdsSerialized).toContain("[msg_u2] Thanks")
      expect(withIdsSerialized).toContain("[msg_a1] [CONTEXT GAUGE:")
    })
  })
})
