/**
 * Integration Tests for Message ID Privacy and Two-Phase Compaction Flow
 *
 * Story 5.4 - These tests prevent regression of the message ID visibility bug.
 *
 * ORIGINAL BUG (Fixed in Epic 5):
 * The LLM's responses contained message ID prefixes (e.g., [msg_b9621c3530011d998346apfpEa])
 * that didn't correspond to any stored message. When users attempted to compact these IDs,
 * the operation failed with "Message not found". Root cause: toModelMessage() was prefixing
 * all messages with [msg_xxx] IDs, teaching the LLM the pattern which it then mimicked incorrectly.
 *
 * SOLUTION:
 * 1. Hide message IDs by default in toModelMessage() (FR23)
 * 2. Compact tool can enable ID visibility via session flag (FR24)
 * 3. Two-phase compaction flow: prepare → see IDs → execute → hide IDs
 *
 * These tests verify the complete flow from flag management through context building.
 */

import { describe, expect, test, beforeEach } from "bun:test"

import { CompactionModeState } from "../../src/session/compaction-mode-state"
import { toModelMessageWithIDs } from "../../src/session/archive-context"
import { MessageV2 } from "../../src/session/message-v2"
import { isPrepareMode, PREPARE_MODE_RESPONSE } from "../../src/tool/compact"

// Test fixtures
const baseUser: MessageV2.User = {
  id: "msg_user_integration",
  sessionID: "ses_integration",
  role: "user",
  time: { created: Date.now() },
  agent: "build",
  model: { providerID: "opencode", modelID: "opencode" },
}

const baseAssistant: MessageV2.Assistant = {
  id: "msg_assistant_integration",
  sessionID: "ses_integration",
  role: "assistant",
  time: { created: Date.now() },
  parentID: "msg_user_integration",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "build",
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

const basePart = {
  id: "prt_integration",
  sessionID: "ses_integration",
  messageID: "msg_user_integration",
}

describe("Message ID Privacy - Integration Tests", () => {
  beforeEach(() => {
    CompactionModeState.reset()
  })

  describe("REGRESSION TEST: Original Bug Prevention", () => {
    /**
     * This test documents the exact bug that was fixed.
     * The LLM should NEVER see [msg_xxx] patterns during normal conversation.
     */
    test("CRITICAL: Normal conversation context NEVER contains [msg_ prefix pattern", () => {
      const conversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_abc123" },
          parts: [
            {
              ...basePart,
              messageID: "msg_abc123",
              type: "text" as const,
              text: "Please fix the authentication bug",
            },
          ],
        },
        {
          info: { ...baseAssistant, id: "msg_def456", parentID: "msg_abc123" },
          parts: [
            {
              ...basePart,
              messageID: "msg_def456",
              type: "text" as const,
              text: "I'll investigate the authentication issue",
            },
            {
              ...basePart,
              id: "prt_gauge",
              messageID: "msg_def456",
              type: "context-gauge" as const,
              tokenCount: 5000,
              contextLimit: 100000,
              percentage: 5,
            },
          ],
        },
        {
          info: { ...baseUser, id: "msg_ghi789" },
          parts: [
            {
              ...basePart,
              messageID: "msg_ghi789",
              type: "text" as const,
              text: "Thanks, let me know what you find",
            },
          ],
        },
      ]

      // This is what the LLM sees during normal conversation
      const context = MessageV2.toModelMessage(conversation)
      const serialized = JSON.stringify(context)

      // THE CRITICAL ASSERTION: No [msg_ patterns should appear
      // This prevents the LLM from learning and mimicking the ID pattern
      expect(serialized).not.toMatch(/\[msg_[a-zA-Z0-9]+\]/)

      // Content should still be present
      expect(serialized).toContain("Please fix the authentication bug")
      expect(serialized).toContain("I'll investigate the authentication issue")
      expect(serialized).toContain("Thanks, let me know what you find")
      expect(serialized).toContain("CONTEXT GAUGE")
    })

    test("CRITICAL: Archive placeholders are the ONLY exception - they contain IDs for retrieval", () => {
      const archivedConversation: MessageV2.WithParts[] = [
        {
          info: {
            ...baseUser,
            id: "msg_archived_anchor",
            archive: {
              summary: "Discussion about authentication",
              indexTerms: ["auth", "login", "security"],
              rangeEnd: "msg_archived_end",
            },
          },
          parts: [
            {
              ...basePart,
              messageID: "msg_archived_anchor",
              type: "text" as const,
              text: "This content should be replaced by placeholder",
            },
          ],
        },
      ]

      const context = MessageV2.toModelMessage(archivedConversation)
      const serialized = JSON.stringify(context)

      // Archive placeholders MUST contain IDs for retrieval
      expect(serialized).toContain("[SMART_ARCHIVED: msg_archived_anchor to msg_archived_end]")
      expect(serialized).toContain("Summary: Discussion about authentication")

      // But the original content should NOT appear
      expect(serialized).not.toContain("This content should be replaced by placeholder")
    })
  })

  describe("End-to-End Two-Phase Compaction Flow", () => {
    test("Phase 1: Prepare mode sets flag and enables ID visibility", () => {
      const sessionID = "ses_two_phase_test"
      const conversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_phase1_user", sessionID },
          parts: [
            {
              ...basePart,
              sessionID,
              messageID: "msg_phase1_user",
              type: "text" as const,
              text: "Help me debug this",
            },
          ],
        },
      ]

      // BEFORE prepare mode: IDs are hidden
      expect(CompactionModeState.get(sessionID)).toBe(false)
      const contextBefore = MessageV2.toModelMessage(conversation)
      expect(JSON.stringify(contextBefore)).not.toContain("[msg_phase1_user]")

      // Prepare mode is triggered (empty ranges)
      expect(isPrepareMode([])).toBe(true)
      expect(isPrepareMode(undefined)).toBe(true)

      // Flag is set
      CompactionModeState.set(sessionID, true)
      expect(CompactionModeState.get(sessionID)).toBe(true)

      // AFTER prepare mode: IDs are visible
      const contextAfter = MessageV2.toModelMessage(conversation, { compactionModeEnabled: true })
      expect(JSON.stringify(contextAfter)).toContain("[msg_phase1_user] Help me debug this")

      // Prepare mode response contains instructions
      expect(PREPARE_MODE_RESPONSE).toContain("Message IDs are now visible")
    })

    test("Phase 2: Execute mode detection and context transition back to hidden", () => {
      const sessionID = "ses_execute_phase_test"
      const conversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_execute_test", sessionID },
          parts: [
            {
              ...basePart,
              sessionID,
              messageID: "msg_execute_test",
              type: "text" as const,
              text: "Execute phase test message",
            },
          ],
        },
      ]

      // Start with flag enabled (simulating post-prepare state)
      CompactionModeState.set(sessionID, true)

      // Verify execute mode is detected when ranges are provided
      expect(isPrepareMode([{ startMessageId: "msg_start" }])).toBe(false)
      expect(isPrepareMode([{ startMessageId: "msg_a", endMessageId: "msg_b" }])).toBe(false)

      // While flag is true, context shows IDs
      const contextDuringExecute = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: CompactionModeState.get(sessionID),
      })
      expect(JSON.stringify(contextDuringExecute)).toContain("[msg_execute_test] Execute phase test message")

      // After compaction completes, flag is reset
      CompactionModeState.set(sessionID, false)

      // After flag reset, context hides IDs again
      const contextAfterExecute = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: CompactionModeState.get(sessionID),
      })
      expect(JSON.stringify(contextAfterExecute)).not.toContain("[msg_execute_test]")
      expect(JSON.stringify(contextAfterExecute)).toContain("Execute phase test message")
    })

    test("Full lifecycle: hidden → visible → hidden", () => {
      const sessionID = "ses_full_lifecycle"
      const conversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_lifecycle", sessionID },
          parts: [
            {
              ...basePart,
              sessionID,
              messageID: "msg_lifecycle",
              type: "text" as const,
              text: "Lifecycle test message",
            },
          ],
        },
      ]

      // 1. Initial state: IDs hidden
      expect(CompactionModeState.get(sessionID)).toBe(false)
      const context1 = MessageV2.toModelMessage(conversation)
      expect(JSON.stringify(context1)).not.toContain("[msg_lifecycle]")

      // 2. After prepare mode: IDs visible
      CompactionModeState.set(sessionID, true)
      const context2 = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: CompactionModeState.get(sessionID),
      })
      expect(JSON.stringify(context2)).toContain("[msg_lifecycle]")

      // 3. After execute mode: IDs hidden again
      CompactionModeState.set(sessionID, false)
      const context3 = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: CompactionModeState.get(sessionID),
      })
      expect(JSON.stringify(context3)).not.toContain("[msg_lifecycle]")
    })

    test("Flag reset always returns context to ID-hidden state (graceful failure handling)", () => {
      /**
       * This test verifies that regardless of what happens during compaction
       * (success with archives, success with 0 archives, or failure),
       * resetting the flag ALWAYS returns context to the ID-hidden state.
       *
       * This is critical for security: if compaction fails, we don't want
       * IDs to remain visible and potentially leak to user output.
       */
      const sessionID = "ses_failure_test"
      const conversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_failure_scenario", sessionID },
          parts: [
            {
              ...basePart,
              sessionID,
              messageID: "msg_failure_scenario",
              type: "text" as const,
              text: "Testing failure scenario",
            },
          ],
        },
      ]

      // Simulate: prepare mode was called, flag is enabled
      CompactionModeState.set(sessionID, true)

      // Context shows IDs while flag is enabled
      const contextWithIds = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: CompactionModeState.get(sessionID),
      })
      expect(JSON.stringify(contextWithIds)).toContain("[msg_failure_scenario]")

      // Simulate: compaction failed or completed with 0 archives
      // The compact tool ALWAYS resets the flag, even on failure
      CompactionModeState.set(sessionID, false)

      // CRITICAL: After reset, IDs MUST be hidden to prevent leak
      const contextAfterReset = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: CompactionModeState.get(sessionID),
      })
      expect(JSON.stringify(contextAfterReset)).not.toContain("[msg_failure_scenario]")
      expect(JSON.stringify(contextAfterReset)).toContain("Testing failure scenario")

      // Verify the flag stays false even if checked multiple times
      expect(CompactionModeState.get(sessionID)).toBe(false)
      expect(CompactionModeState.get(sessionID)).toBe(false)
    })
  })

  describe("Cross-Function Consistency", () => {
    test("toModelMessage default equals toModelMessage({compactionModeEnabled: false})", () => {
      const conversation: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [
            {
              ...basePart,
              type: "text" as const,
              text: "Consistency test",
            },
          ],
        },
      ]

      const defaultResult = MessageV2.toModelMessage(conversation)
      const explicitFalseResult = MessageV2.toModelMessage(conversation, {
        compactionModeEnabled: false,
      })

      expect(JSON.stringify(defaultResult)).toBe(JSON.stringify(explicitFalseResult))
    })

    test("toModelMessageWithIDs always matches toModelMessage({compactionModeEnabled: true}) for text content", () => {
      const conversation: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [
            {
              ...basePart,
              type: "text" as const,
              text: "Cross-function test",
            },
          ],
        },
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              messageID: "msg_assistant_integration",
              type: "text" as const,
              text: "Assistant response",
            },
          ],
        },
      ]

      const withIdsResult = toModelMessageWithIDs(conversation)
      const flagResult = MessageV2.toModelMessage(conversation, { compactionModeEnabled: true })

      // Both should contain ID prefixes
      const withIdsSerialized = JSON.stringify(withIdsResult)
      const flagSerialized = JSON.stringify(flagResult)

      expect(withIdsSerialized).toContain("[msg_user_integration] Cross-function test")
      expect(flagSerialized).toContain("[msg_user_integration] Cross-function test")
      expect(withIdsSerialized).toContain("[msg_assistant_integration] Assistant response")
      expect(flagSerialized).toContain("[msg_assistant_integration] Assistant response")
    })

    test("Documents intentional difference: tool output handling", () => {
      /**
       * INTENTIONAL DIFFERENCE:
       * - toModelMessageWithIDs() does NOT prefix tool output text (tool output is data)
       * - toModelMessage({compactionModeEnabled: true}) also does NOT prefix tool output
       *
       * Both functions are consistent in this behavior. Tool outputs are structured
       * data returned by tools, not conversational content that needs ID tracking.
       */
      const toolMessage: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              id: "tool_part",
              messageID: "msg_assistant_integration",
              type: "tool" as const,
              callID: "call_1",
              tool: "read_file",
              state: {
                status: "completed",
                input: { path: "/test.ts" },
                output: "File contents here",
                title: "Read File",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ],
        },
      ]

      const withIdsResult = toModelMessageWithIDs(toolMessage)
      const flagResult = MessageV2.toModelMessage(toolMessage, { compactionModeEnabled: true })

      // Tool outputs should NOT have [msg_ prefix on the output text itself
      const withIdsSerialized = JSON.stringify(withIdsResult)
      const flagSerialized = JSON.stringify(flagResult)

      // The tool result content appears but output text is not prefixed
      expect(withIdsSerialized).toContain("File contents here")
      expect(flagSerialized).toContain("File contents here")

      // Tool call structure is present
      expect(withIdsSerialized).toContain("tool-call")
      expect(flagSerialized).toContain("tool-call")
    })
  })

  describe("Edge Cases", () => {
    test("Empty messages are handled gracefully", () => {
      const emptyConversation: MessageV2.WithParts[] = [
        {
          info: baseUser,
          parts: [],
        },
      ]

      // Should not throw
      const result = MessageV2.toModelMessage(emptyConversation)
      expect(result).toBeDefined()
      expect(result.length).toBe(0) // No content to render
    })

    test("Messages with only tool parts (no text) are handled correctly", () => {
      const toolOnlyMessage: MessageV2.WithParts[] = [
        {
          info: baseAssistant,
          parts: [
            {
              ...basePart,
              id: "tool_only_part",
              messageID: "msg_assistant_integration",
              type: "tool" as const,
              callID: "call_tool_only",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "file1.ts\nfile2.ts",
                title: "Bash",
                metadata: {},
                time: { start: Date.now(), end: Date.now() },
              },
            },
          ],
        },
      ]

      // Default mode: no ID prefix concerns (there's no text to prefix)
      const defaultResult = MessageV2.toModelMessage(toolOnlyMessage)
      const defaultSerialized = JSON.stringify(defaultResult)
      expect(defaultSerialized).toContain("file1.ts")
      expect(defaultSerialized).toContain("tool-call")

      // Compaction mode: still works
      const compactionResult = MessageV2.toModelMessage(toolOnlyMessage, {
        compactionModeEnabled: true,
      })
      const compactionSerialized = JSON.stringify(compactionResult)
      expect(compactionSerialized).toContain("file1.ts")
    })

    test("Multiple message types in single conversation", () => {
      const mixedConversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_mixed_1" },
          parts: [
            {
              ...basePart,
              messageID: "msg_mixed_1",
              type: "text" as const,
              text: "User text",
            },
          ],
        },
        {
          info: { ...baseAssistant, id: "msg_mixed_2" },
          parts: [
            {
              ...basePart,
              messageID: "msg_mixed_2",
              type: "text" as const,
              text: "Assistant text",
            },
            {
              ...basePart,
              id: "prt_reasoning",
              messageID: "msg_mixed_2",
              type: "reasoning" as const,
              text: "Internal reasoning",
              time: { start: Date.now(), end: Date.now() },
            },
            {
              ...basePart,
              id: "prt_gauge",
              messageID: "msg_mixed_2",
              type: "context-gauge" as const,
              tokenCount: 10000,
              contextLimit: 100000,
              percentage: 10,
            },
          ],
        },
        {
          info: {
            ...baseUser,
            id: "msg_mixed_3",
            archive: {
              summary: "Archived content",
              indexTerms: ["test"],
              rangeEnd: "msg_mixed_3",
            },
          },
          parts: [],
        },
      ]

      // Default: no IDs except in archive placeholder
      const defaultResult = MessageV2.toModelMessage(mixedConversation)
      const defaultSerialized = JSON.stringify(defaultResult)

      expect(defaultSerialized).toContain("User text")
      expect(defaultSerialized).not.toContain("[msg_mixed_1]")
      expect(defaultSerialized).toContain("Assistant text")
      expect(defaultSerialized).not.toContain("[msg_mixed_2]")
      expect(defaultSerialized).toContain("[SMART_ARCHIVED: msg_mixed_3]") // Exception for archive

      // Compaction mode: all IDs visible
      const compactionResult = MessageV2.toModelMessage(mixedConversation, {
        compactionModeEnabled: true,
      })
      const compactionSerialized = JSON.stringify(compactionResult)

      expect(compactionSerialized).toContain("[msg_mixed_1] User text")
      expect(compactionSerialized).toContain("[msg_mixed_2] Assistant text")
      expect(compactionSerialized).toContain("[msg_mixed_2] Internal reasoning")
      expect(compactionSerialized).toContain("[msg_mixed_2] [CONTEXT GAUGE:")
    })
  })

  describe("Session Isolation", () => {
    test("Flag state is isolated between concurrent sessions", () => {
      const session1 = "ses_concurrent_1"
      const session2 = "ses_concurrent_2"
      const session3 = "ses_concurrent_3"

      // Set different states for each session
      CompactionModeState.set(session1, true)
      CompactionModeState.set(session2, false)
      // session3 is never explicitly set

      // Verify isolation
      expect(CompactionModeState.get(session1)).toBe(true)
      expect(CompactionModeState.get(session2)).toBe(false)
      expect(CompactionModeState.get(session3)).toBe(false)

      // Changing one doesn't affect others
      CompactionModeState.set(session1, false)
      expect(CompactionModeState.get(session1)).toBe(false)
      expect(CompactionModeState.get(session2)).toBe(false)

      // Clear one session
      CompactionModeState.set(session2, true)
      CompactionModeState.clear(session2)
      expect(CompactionModeState.get(session2)).toBe(false)
    })

    test("Context build respects per-session flag state", () => {
      const session1 = "ses_context_1"
      const session2 = "ses_context_2"

      const message1: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_ses1", sessionID: session1 },
          parts: [
            {
              ...basePart,
              sessionID: session1,
              messageID: "msg_ses1",
              type: "text" as const,
              text: "Session 1 message",
            },
          ],
        },
      ]

      const message2: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_ses2", sessionID: session2 },
          parts: [
            {
              ...basePart,
              sessionID: session2,
              messageID: "msg_ses2",
              type: "text" as const,
              text: "Session 2 message",
            },
          ],
        },
      ]

      // Session 1 has IDs enabled, Session 2 does not
      CompactionModeState.set(session1, true)
      CompactionModeState.set(session2, false)

      const context1 = MessageV2.toModelMessage(message1, {
        compactionModeEnabled: CompactionModeState.get(session1),
      })
      const context2 = MessageV2.toModelMessage(message2, {
        compactionModeEnabled: CompactionModeState.get(session2),
      })

      expect(JSON.stringify(context1)).toContain("[msg_ses1]")
      expect(JSON.stringify(context2)).not.toContain("[msg_ses2]")
    })
  })

  describe("prompt.ts Wiring Verification", () => {
    /**
     * These tests verify the integration pattern between prompt.ts and CompactionModeState.
     *
     * In prompt.ts (line 718), the context is built like this:
     *   MessageV2.toModelMessage(msgs, { compactionModeEnabled: CompactionModeState.get(sessionID) })
     *
     * This pattern means:
     * 1. The flag is read from CompactionModeState at context build time
     * 2. The flag value is passed directly to toModelMessage
     * 3. Changes to CompactionModeState affect the NEXT context build, not current one
     *
     * We test this pattern here since prompt.ts has too many dependencies to unit test directly.
     */

    test("simulates prompt.ts wiring: flag read at context build time", () => {
      const sessionID = "ses_prompt_wiring"
      const conversation: MessageV2.WithParts[] = [
        {
          info: { ...baseUser, id: "msg_prompt_test", sessionID },
          parts: [
            {
              ...basePart,
              sessionID,
              messageID: "msg_prompt_test",
              type: "text" as const,
              text: "Simulating prompt.ts behavior",
            },
          ],
        },
      ]

      // This is EXACTLY how prompt.ts builds context (line 718)
      const buildContextLikePromptTs = () =>
        MessageV2.toModelMessage(conversation, {
          compactionModeEnabled: CompactionModeState.get(sessionID),
        })

      // Initial state: flag is false, IDs hidden
      const context1 = buildContextLikePromptTs()
      expect(JSON.stringify(context1)).not.toContain("[msg_prompt_test]")

      // Compact tool sets flag (prepare mode)
      CompactionModeState.set(sessionID, true)

      // NEXT context build sees the flag change
      const context2 = buildContextLikePromptTs()
      expect(JSON.stringify(context2)).toContain("[msg_prompt_test]")

      // Compact tool resets flag (after execute mode)
      CompactionModeState.set(sessionID, false)

      // NEXT context build sees IDs hidden again
      const context3 = buildContextLikePromptTs()
      expect(JSON.stringify(context3)).not.toContain("[msg_prompt_test]")
    })

    test("verifies CompactionModeState.get returns boolean (prompt.ts contract)", () => {
      const sessionID = "ses_contract_test"

      // prompt.ts passes the result directly to toModelMessage
      // The contract requires CompactionModeState.get to return a boolean
      const flagValue = CompactionModeState.get(sessionID)
      expect(typeof flagValue).toBe("boolean")
      expect(flagValue).toBe(false)

      CompactionModeState.set(sessionID, true)
      const flagValueTrue = CompactionModeState.get(sessionID)
      expect(typeof flagValueTrue).toBe("boolean")
      expect(flagValueTrue).toBe(true)
    })
  })
})
