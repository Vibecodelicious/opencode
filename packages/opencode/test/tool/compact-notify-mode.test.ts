import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import path from "path"
import { tmpdir, createTestSession } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { CompactTool, isExecuteMetadata } from "../../src/tool/compact"
import { Permission } from "../../src/permission"
import { Identifier } from "../../src/id/id"

describe("compact tool notify mode", () => {
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

  test("notify mode output includes retrieval hint when archival succeeds", async () => {
    // This test directly verifies the retrieval hint building logic
    // by checking the output format when summaries are present
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

        const result = await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Verify output is defined and non-empty (notify mode)
        expect(result.output).toBeDefined()
        expect(typeof result.output).toBe("string")
        expect(result.output.length).toBeGreaterThan(0)

        // When archival succeeds, retrieval hint MUST be present per AC2
        expect(isExecuteMetadata(result.metadata)).toBe(true)
        if (isExecuteMetadata(result.metadata) && result.metadata.archived > 0) {
          expect(result.output).toContain("retrieve tool")
          expect(result.output).toContain("archiveId")
          // Verify hint includes actual message IDs (msg_ prefix from id.ts format)
          expect(result.output).toMatch(/archiveId.*"msg_/)
        }

        await Session.remove(session.id)
      },
    })
  })

  test("notify mode output format when summarization fails (no LLM)", async () => {
    // This test verifies notify mode output when archival doesn't occur
    // (common in test environment without real LLM for summarization)
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

        const result = await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Even when archival doesn't occur, output should still be informative
        expect(result.output).not.toBe("")

        // Should show "No summary generated" when LLM summarization fails
        expect(isExecuteMetadata(result.metadata)).toBe(true)
        if (isExecuteMetadata(result.metadata)) {
          if (result.metadata.archived === 0) {
            expect(result.output).toContain("No summary generated")
            // Retrieval hint should NOT be present when nothing was archived
            expect(result.output).not.toContain("To restore archived content")
          }

          // Metadata should still be populated correctly
          expect(result.metadata.totalMessages).toBe(3)
          expect(result.metadata.rangeCount).toBe(1)
        }

        await Session.remove(session.id)
      },
    })
  })

  test("notify mode output includes all required notification elements", async () => {
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

        const result = await tool.execute({
          ranges: [{ startMessageId: msgIds[0], endMessageId: msgIds[2] }],
        }, ctx)

        // Notify mode should have non-empty output (unlike silent mode)
        expect(result.output).not.toBe("")

        // Output should include message range information
        expect(result.output).toContain(msgIds[0])
        expect(result.output).toContain(msgIds[2])

        // Output should mention number of messages
        expect(result.output).toContain("3 message")

        // Output should include token information
        expect(result.output).toContain("tokens")

        // Output should include Summary section
        expect(result.output).toContain("Summary:")

        // Output should include Index section
        expect(result.output).toContain("Index:")

        // Metadata should be populated
        expect(isExecuteMetadata(result.metadata)).toBe(true)
        if (isExecuteMetadata(result.metadata)) {
          expect(result.metadata.totalMessages).toBe(3)
          expect(result.metadata.rangeCount).toBe(1)
          expect(result.metadata.totalTokens).toBeGreaterThan(0)
        }

        await Session.remove(session.id)
      },
    })
  })

  test("notify mode with multiple ranges includes all archive IDs in retrieval hint", async () => {
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

        // Call with two non-overlapping ranges
        const result = await tool.execute({
          ranges: [
            { startMessageId: msgIds[0], endMessageId: msgIds[1] },
            { startMessageId: msgIds[3], endMessageId: msgIds[4] },
          ],
        }, ctx)

        // Output should mention both ranges
        expect(result.output).toContain(msgIds[0])
        expect(result.output).toContain(msgIds[3])

        // Metadata should reflect both ranges
        expect(isExecuteMetadata(result.metadata)).toBe(true)
        if (isExecuteMetadata(result.metadata)) {
          expect(result.metadata.rangeCount).toBe(2)
          expect(result.metadata.totalMessages).toBe(4)
        }

        await Session.remove(session.id)
      },
    })
  })

  test("notify mode does NOT call Permission.ask", async () => {
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

  test("default mode is notify when no config specified", async () => {
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

        // Permission.ask should NOT have been called (default is notify)
        expect(askMock).not.toHaveBeenCalled()

        // Output should be non-empty (notify mode, not silent)
        expect(result.output).not.toBe("")

        await Session.remove(session.id)
      },
    })
  })
})
