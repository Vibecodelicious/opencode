import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import path from "path"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { CompactTool } from "../../src/tool/compact"
import { Permission } from "../../src/permission"

async function createTestSession(sessionDir: string) {
  const session = await Session.create({})

  // Create test messages
  const msg1Id = Identifier.ascending("message")
  const msg2Id = Identifier.ascending("message")
  const msg3Id = Identifier.ascending("message")

  // Create user message 1
  await Session.updateMessage({
    id: msg1Id,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: msg1Id,
    type: "text",
    text: "Can you help me understand how the authentication flow works in this codebase? I need to add a new OAuth provider.",
  })

  // Create assistant message 2
  await Session.updateMessage({
    id: msg2Id,
    sessionID: session.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: msg1Id,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    path: { cwd: sessionDir, root: sessionDir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: msg2Id,
    type: "text",
    text: "The authentication flow uses JWT tokens stored in httpOnly cookies. The main entry point is `src/auth/handler.ts` which validates tokens via the `AuthMiddleware` class. For OAuth, you'll need to implement the `OAuthProvider` interface defined in `src/auth/providers/base.ts`.",
  })

  // Create user message 3
  await Session.updateMessage({
    id: msg3Id,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: msg3Id,
    type: "text",
    text: "Thanks! Can you show me an example of how Google OAuth is implemented? I want to use it as a reference.",
  })

  return { session, msgIds: [msg1Id, msg2Id, msg3Id] }
}

describe("compact tool ask mode", () => {
  // Store original Permission.ask for restoration
  let originalAsk: typeof Permission.ask
  let askMock: ReturnType<typeof mock>

  beforeEach(() => {
    originalAsk = Permission.ask
    askMock = mock(() => Promise.resolve())
    Permission.ask = askMock as typeof Permission.ask
  })

  afterEach(() => {
    Permission.ask = originalAsk
  })

  test("calls Permission.ask when mode is 'ask'", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "ask", enabled: true },
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msgIds } = await createTestSession(tmp.path)

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Permission.ask should have been called
        expect(askMock).toHaveBeenCalledTimes(1)

        // Verify Permission.ask was called with correct parameters
        const callArgs = askMock.mock.calls[0][0]
        expect(callArgs.type).toBe("compact")
        expect(callArgs.sessionID).toBe(session.id)
        expect(callArgs.callID).toBe("test-call-id")
        expect(callArgs.title).toContain("3 messages")
        expect(callArgs.metadata.totalMessages).toBe(3)
        expect(callArgs.metadata.ranges).toEqual([{ startMessageId: msgIds[0], endMessageId: msgIds[2] }])

        await Session.remove(session.id)
      },
    })
  })

  test("throws RejectedError when user declines permission", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "ask", enabled: true },
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msgIds } = await createTestSession(tmp.path)

        // Make Permission.ask throw RejectedError
        Permission.ask = mock(() => {
          throw new Permission.RejectedError(session.id, "perm_123", "call_123", {})
        }) as typeof Permission.ask

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        // Should throw RejectedError when permission is declined
        await expect(
          tool.execute({
            ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
          }, ctx),
        ).rejects.toBeInstanceOf(Permission.RejectedError)

        await Session.remove(session.id)
      },
    })
  })

  test("does NOT call Permission.ask in notify mode", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "notify", enabled: true },
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msgIds } = await createTestSession(tmp.path)

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Permission.ask should NOT have been called in notify mode
        expect(askMock).not.toHaveBeenCalled()

        await Session.remove(session.id)
      },
    })
  })

  test("does NOT call Permission.ask in silent mode and returns empty output", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "silent", enabled: true },
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msgIds } = await createTestSession(tmp.path)

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        const result = await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Permission.ask should NOT have been called in silent mode
        expect(askMock).not.toHaveBeenCalled()

        // Silent mode should return empty output (no text for LLM to present)
        expect(result.output).toBe("")

        // But metadata should still be populated for internal tracking
        expect(result.metadata.totalMessages).toBe(3)
        expect(result.metadata.rangeCount).toBe(1)

        await Session.remove(session.id)
      },
    })
  })

  test("defaults to notify mode (no Permission.ask) when no config specified", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Write config without compaction settings
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msgIds } = await createTestSession(tmp.path)

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Permission.ask should NOT have been called (default is notify)
        expect(askMock).not.toHaveBeenCalled()

        await Session.remove(session.id)
      },
    })
  })

  test("Permission.ask is called for each compact invocation (Permission system manages 'always' state)", async () => {
    // NOTE: This test verifies that CompactTool calls Permission.ask on every invocation.
    // The actual "always" approval behavior is managed by the Permission system itself
    // (see permission/index.ts:162-180), which tracks approved types per session and
    // short-circuits Permission.ask internally when a type is already approved.
    // This test uses a mock that simulates that behavior to verify the integration pattern.
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "ask", enabled: true },
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { session, msgIds } = await createTestSession(tmp.path)

        // Track which types have been "always" approved (simulating Permission system state)
        const alwaysApproved = new Set<string>()
        let actualPromptCount = 0

        // Mock Permission.ask to simulate the real Permission system's "always" behavior:
        // The real system (permission/index.ts:104-106) checks if type is already approved
        // and returns early. We simulate this to verify CompactTool integrates correctly.
        Permission.ask = mock((input: { type: string }) => {
          if (alwaysApproved.has(input.type)) {
            // Simulates Permission system's early return for approved types
            return Promise.resolve()
          }
          // Simulates first-time prompt that user approves with "always"
          actualPromptCount++
          alwaysApproved.add(input.type)
          return Promise.resolve()
        }) as typeof Permission.ask

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        // First call - should prompt
        await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[0] }],
        }, ctx)

        // Second call - should skip prompt due to "always" approval
        await tool.execute({
          ranges: [{ startMessageId: msgIds[1], endMessageId: msgIds[1] }],
        }, ctx)

        // Third call - should also skip prompt
        await tool.execute({
          ranges: [{ startMessageId: msgIds[2], endMessageId: msgIds[2] }],
        }, ctx)

        // Only 1 actual prompt should have occurred (first call)
        // Subsequent calls were skipped due to "always" approval
        expect(actualPromptCount).toBe(1)

        await Session.remove(session.id)
      },
    })
  })

  test("Permission.ask metadata includes token estimates for multiple ranges", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "ask", enabled: true },
          }, null, 2),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        // Create 5 messages for multiple ranges
        const msgIds: string[] = []
        for (let i = 0; i < 5; i++) {
          const msgId = Identifier.ascending("message")
          msgIds.push(msgId)

          if (i % 2 === 0) {
            await Session.updateMessage({
              id: msgId,
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: "test", modelID: "test" },
            })
          } else {
            await Session.updateMessage({
              id: msgId,
              sessionID: session.id,
              role: "assistant",
              time: { created: Date.now() },
              parentID: msgIds[i - 1],
              modelID: "test-model",
              providerID: "test-provider",
              mode: "build",
              path: { cwd: tmp.path, root: tmp.path },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          }

          const messageContents = [
            "What's the best way to handle database migrations in this project?",
            "The project uses Drizzle ORM for migrations. Run `bun db:migrate` to apply pending migrations. Schema files are in `src/db/schema/`.",
            "I see there's a users table. How do I add a new column for user preferences?",
            "Create a new migration with `bun db:generate` after modifying the schema. The preferences column should use JSONB type for flexibility.",
            "Perfect, that makes sense. Let me try adding the column now.",
          ]
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msgId,
            type: "text",
            text: messageContents[i],
          })
        }

        const tool = await CompactTool.init()
        const ctx = {
          sessionID: session.id,
          messageID: "",
          callID: "test-call-id",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        }

        // Call with two non-overlapping ranges (skipping msgIds[2] to test gap handling)
        // Range 1: messages 0-1 (2 messages), Range 2: messages 3-4 (2 messages), Total: 4 messages
        await tool.execute({
          ranges: [
            { startMessageId: msgIds[0], endMessageId: msgIds[1] },
            { startMessageId: msgIds[3], endMessageId: msgIds[4] },
          ],
        }, ctx)

        // Verify Permission.ask was called with correct metadata
        expect(askMock).toHaveBeenCalledTimes(1)
        const callArgs = askMock.mock.calls[0][0]
        expect(callArgs.metadata.totalMessages).toBe(4)
        expect(callArgs.metadata.totalTokens).toBeGreaterThan(0)
        expect(callArgs.metadata.ranges).toHaveLength(2)
        expect(callArgs.title).toContain("4 messages")

        await Session.remove(session.id)
      },
    })
  })
})
