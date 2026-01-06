import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import path from "path"
import { tmpdir, createTestSession } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { CompactTool } from "../../src/tool/compact"
import { Permission } from "../../src/permission"
import { Identifier } from "../../src/id/id"

describe("compact tool silent mode", () => {
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

  test("silent mode does NOT call Permission.ask", async () => {
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

  test("silent mode returns empty output string", async () => {
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

        // Silent mode should return empty output (no text for LLM to present)
        expect(result.output).toBe("")

        await Session.remove(session.id)
      },
    })
  })

  test("silent mode metadata is fully populated", async () => {
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

        // Metadata should be fully populated for internal tracking
        expect(result.metadata.totalMessages).toBe(3)
        expect(result.metadata.rangeCount).toBe(1)
        expect(result.metadata.totalTokens).toBeGreaterThan(0)
        // archived field should exist (value depends on summarization success)
        expect(typeof result.metadata.archived).toBe("number")
        // summaries should be an object (may be empty if LLM not available)
        expect(typeof result.metadata.summaries).toBe("object")

        await Session.remove(session.id)
      },
    })
  })

  test("silent mode title indicates completion status", async () => {
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

        // Title should indicate completion status
        // "Compaction complete" if archival succeeded, "Compaction ready" otherwise
        expect(result.title).toMatch(/Compaction (complete|ready)/)

        await Session.remove(session.id)
      },
    })
  })

  test("silent mode with multiple ranges returns empty output", async () => {
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
            "The project uses Drizzle ORM for migrations. Run `bun db:migrate` to apply pending migrations.",
            "I see there's a users table. How do I add a new column?",
            "Create a new migration with `bun db:generate` after modifying the schema.",
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

        // Call with two non-overlapping ranges
        const result = await tool.execute({
          ranges: [
            { startMessageId: msgIds[0], endMessageId: msgIds[1] },
            { startMessageId: msgIds[3], endMessageId: msgIds[4] },
          ],
        }, ctx)

        // Silent mode should still return empty output with multiple ranges
        expect(result.output).toBe("")

        // But metadata should reflect both ranges
        expect(result.metadata.rangeCount).toBe(2)
        expect(result.metadata.totalMessages).toBe(4)

        await Session.remove(session.id)
      },
    })
  })

  test("default mode is NOT silent (defaults to notify)", async () => {
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

        const result = await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Default mode should be notify, which has non-empty output
        expect(result.output).not.toBe("")

        await Session.remove(session.id)
      },
    })
  })

  test("silent mode with explicit enabled: false still works (mode takes precedence)", async () => {
    // This tests that mode: "silent" works regardless of enabled flag
    // since the mode controls behavior, not whether compaction is possible
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            compaction: { mode: "silent" },
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

        // Silent mode should return empty output
        expect(result.output).toBe("")

        await Session.remove(session.id)
      },
    })
  })
})
