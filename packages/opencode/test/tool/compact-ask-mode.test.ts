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
    text: "First message with some content for testing compaction ask mode",
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
    text: "Second message with assistant response content for testing",
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
    text: "Third message with more content for ask mode testing",
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
    // @ts-expect-error - mocking namespace function
    Permission.ask = askMock
  })

  afterEach(() => {
    // @ts-expect-error - restoring original
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
        // @ts-expect-error - mocking
        Permission.ask = mock(() => {
          throw new Permission.RejectedError(session.id, "perm_123", "call_123", {})
        })

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

  test("does NOT call Permission.ask in silent mode", async () => {
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

        await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Permission.ask should NOT have been called in silent mode
        expect(askMock).not.toHaveBeenCalled()

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

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msgId,
            type: "text",
            text: `Message ${i + 1} with content for testing token estimation in ask mode`,
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

        // Call with two non-overlapping ranges
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
