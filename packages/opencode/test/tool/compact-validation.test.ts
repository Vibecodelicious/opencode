import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "../../src/id/id"

const projectRoot = path.join(__dirname, "../..")
const xdgBase = path.join(projectRoot, ".tmp", "xdg-compact-validation")

async function loadModules() {
  const { Instance } = await import("../../src/project/instance")
  const { Session } = await import("../../src/session")
  const { CompactTool, isExecuteMetadata } = await import("../../src/tool/compact")
  const pluginModule = await import("../../src/plugin")

  return { Instance, Session, CompactTool, isExecuteMetadata, pluginModule }
}

type Modules = Awaited<ReturnType<typeof loadModules>>

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}

async function ensureXdgDirs() {
  const bases = ["cache", "data", "config", "state"]
  await Promise.all(
    bases.flatMap((dir) => [
      fs.mkdir(path.join(xdgBase, dir), { recursive: true }),
      fs.mkdir(path.join(xdgBase, dir, "opencode"), { recursive: true }),
    ]),
  )
}

async function withSandbox(
  fn: (mods: Omit<Modules, "pluginModule">) => Promise<void>,
) {
  const previousEnv = snapshotEnv([
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_CONFIG_CONTENT",
  ])

  process.env.XDG_CACHE_HOME = path.join(xdgBase, "cache")
  process.env.XDG_DATA_HOME = path.join(xdgBase, "data")
  process.env.XDG_CONFIG_HOME = path.join(xdgBase, "config")
  process.env.XDG_STATE_HOME = path.join(xdgBase, "state")
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

  await ensureXdgDirs()

  const mods = await loadModules()
  const previousPluginList = mods.pluginModule.Plugin.list

  ;(mods.pluginModule as any).Plugin.list = async () => []
  await mods.Instance.disposeAll()

  try {
    await fn({ Instance: mods.Instance, Session: mods.Session, CompactTool: mods.CompactTool, isExecuteMetadata: mods.isExecuteMetadata })
  } finally {
    mods.pluginModule.Plugin.list = previousPluginList
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await mods.Instance.disposeAll()
    await fs.rm(xdgBase, { recursive: true, force: true })
  }
}

describe("compact tool validation with real sessions", () => {
  test("validates messages exist and returns success for valid ranges", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          // Create a session
          const session = await Session.create({})

          // Create test messages with sequential IDs
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
            text: "First message",
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
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg2Id,
            type: "text",
            text: "Second message",
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
            text: "Third message",
          })

          // Test compact tool with valid range
          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          const result = await tool.execute({
            ranges: [{ startMessageId: msg1Id, endMessageId: msg3Id }],
          }, ctx)

          expect(result.output).toContain("Generated summaries for 1 range")
          expect(result.output).toContain("3 messages")
          expect(result.output).toContain("ready for archival")
          expect(isExecuteMetadata(result.metadata)).toBe(true)
          if (isExecuteMetadata(result.metadata)) {
            expect(result.metadata.rangeCount).toBe(1)
            expect(result.metadata.totalMessages).toBe(3)
          }

          // Cleanup
          await Session.remove(session.id)
        },
      })
    })
  })

  test("validates multiple non-overlapping ranges", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          // Create 5 messages
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
                path: { cwd: projectRoot, root: projectRoot },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              })
            }

            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: msgId,
              type: "text",
              text: `Message ${i + 1}`,
            })
          }

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          // Two non-overlapping ranges: [0-1] and [3-4]
          const result = await tool.execute({
            ranges: [
              { startMessageId: msgIds[0], endMessageId: msgIds[1] },
              { startMessageId: msgIds[3], endMessageId: msgIds[4] },
            ],
          }, ctx)

          expect(result.output).toContain("Generated summaries for 2 range")
          expect(result.output).toContain("4 messages")
          expect(isExecuteMetadata(result.metadata)).toBe(true)
          if (isExecuteMetadata(result.metadata)) {
            expect(result.metadata.rangeCount).toBe(2)
            expect(result.metadata.totalMessages).toBe(4)
          }

          await Session.remove(session.id)
        },
      })
    })
  })

  test("rejects messages in wrong chronological order", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msg1Id = Identifier.ascending("message")
          // Small delay to ensure different timestamps in IDs
          await new Promise((resolve) => setTimeout(resolve, 10))
          const msg2Id = Identifier.ascending("message")

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
            text: "First",
          })

          await Session.updateMessage({
            id: msg2Id,
            sessionID: session.id,
            role: "assistant",
            time: { created: Date.now() },
            parentID: msg1Id,
            modelID: "test-model",
            providerID: "test-provider",
            mode: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg2Id,
            type: "text",
            text: "Second",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          // Wrong order: msg2Id comes after msg1Id, so using msg2Id as start is wrong
          const promise = tool.execute({
            ranges: [{ startMessageId: msg2Id, endMessageId: msg1Id }],
          }, ctx)

          await expect(promise).rejects.toThrow(/Start message must come before end message:/)

          await Session.remove(session.id)
        },
      })
    })
  })

  test("rejects archived start message", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msg1Id = Identifier.ascending("message")
          const msg2Id = Identifier.ascending("message")

          // Create archived anchor message
          await Session.updateMessage({
            id: msg1Id,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            archive: {
              summary: "Already archived content",
              indexTerms: ["test"],
              rangeEnd: msg1Id,
            },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg1Id,
            type: "text",
            text: "Archived message",
          })

          // Create non-archived message
          await Session.updateMessage({
            id: msg2Id,
            sessionID: session.id,
            role: "assistant",
            time: { created: Date.now() },
            parentID: msg1Id,
            modelID: "test-model",
            providerID: "test-provider",
            mode: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg2Id,
            type: "text",
            text: "Normal message",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          // Try to compact starting from archived message
          const promise = tool.execute({
            ranges: [{ startMessageId: msg1Id, endMessageId: msg2Id }],
          }, ctx)

          await expect(promise).rejects.toThrow(/is already archived \(anchor of archive ending at/)

          await Session.remove(session.id)
        },
      })
    })
  })

  test("rejects archived end message", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msg1Id = Identifier.ascending("message")
          const msg2Id = Identifier.ascending("message")

          // Create non-archived message
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
            text: "Normal message",
          })

          // Create message that is archivedBy another message
          await Session.updateMessage({
            id: msg2Id,
            sessionID: session.id,
            role: "assistant",
            time: { created: Date.now() },
            parentID: msg1Id,
            modelID: "test-model",
            providerID: "test-provider",
            mode: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            archivedBy: "msg_some_other_archive",
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg2Id,
            type: "text",
            text: "Archived follower message",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          // Try to compact ending at archivedBy message
          const promise = tool.execute({
            ranges: [{ startMessageId: msg1Id, endMessageId: msg2Id }],
          }, ctx)

          await expect(promise).rejects.toThrow(/is already archived \(part of archive/)

          await Session.remove(session.id)
        },
      })
    })
  })

  test("allows archived messages in middle of range (edge case per spec)", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msg1Id = Identifier.ascending("message")
          const msg2Id = Identifier.ascending("message")
          const msg3Id = Identifier.ascending("message")

          // Non-archived start
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
            text: "First message",
          })

          // Archived message in the middle (has archivedBy)
          await Session.updateMessage({
            id: msg2Id,
            sessionID: session.id,
            role: "assistant",
            time: { created: Date.now() },
            parentID: msg1Id,
            modelID: "test-model",
            providerID: "test-provider",
            mode: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            archivedBy: "msg_existing_archive",
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg2Id,
            type: "text",
            text: "Middle archived message",
          })

          // Non-archived end
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
            text: "Last message",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          // Range includes archived message in middle - should succeed per spec
          const result = await tool.execute({
            ranges: [{ startMessageId: msg1Id, endMessageId: msg3Id }],
          }, ctx)

          // Should succeed because only start/end archive status matters
          expect(result.output).toContain("Generated summaries for 1 range")
          expect(result.output).toContain("3 messages")
          expect(isExecuteMetadata(result.metadata)).toBe(true)
          if (isExecuteMetadata(result.metadata)) {
            expect(result.metadata.totalMessages).toBe(3)
          }

          await Session.remove(session.id)
        },
      })
    })
  })

  test("handles single-message range (no endMessageId)", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msgId = Identifier.ascending("message")

          await Session.updateMessage({
            id: msgId,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msgId,
            type: "text",
            text: "Only message",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          // Single message range (no endMessageId provided)
          const result = await tool.execute({
            ranges: [{ startMessageId: msgId }],
          }, ctx)

          expect(result.output).toContain("1 message")
          expect(isExecuteMetadata(result.metadata)).toBe(true)
          if (isExecuteMetadata(result.metadata)) {
            expect(result.metadata.totalMessages).toBe(1)
          }

          await Session.remove(session.id)
        },
      })
    })
  })

})

describe("compact tool summarization error handling", () => {
  test("gracefully handles model lookup failure with error in output", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msg1Id = Identifier.ascending("message")
          const msg2Id = Identifier.ascending("message")

          // Create user message
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
            text: "Test message for error handling",
          })

          // Create assistant message with test-provider (will fail Provider.getModel lookup)
          await Session.updateMessage({
            id: msg2Id,
            sessionID: session.id,
            role: "assistant",
            time: { created: Date.now() },
            parentID: msg1Id,
            modelID: "test-model",
            providerID: "test-provider",
            mode: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msg2Id,
            type: "text",
            text: "Assistant response",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          const result = await tool.execute({
            ranges: [{ startMessageId: msg1Id, endMessageId: msg2Id }],
          }, ctx)

          // Tool should succeed with graceful degradation
          expect(result.output).toContain("Generated summaries for 1 range")
          expect(result.output).toContain("0/1 successful") // No summaries generated due to model lookup failure
          expect(result.output).toContain("No summary generated") // Fallback text
          expect(result.output).toContain("Note:") // Error note present

          // Metadata should contain error info
          expect(isExecuteMetadata(result.metadata)).toBe(true)
          if (isExecuteMetadata(result.metadata)) {
            expect(result.metadata.error).toBeDefined()
            expect(result.metadata.summaries).toEqual({}) // Empty due to failure
          }

          await Session.remove(session.id)
        },
      })
    })
  })

  test("reports no model info when session has no assistant messages", async () => {
    await withSandbox(async ({ Instance, Session, CompactTool, isExecuteMetadata }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const msgId = Identifier.ascending("message")

          // Create only user message (no assistant = no model info)
          await Session.updateMessage({
            id: msgId,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test" },
          })

          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: msgId,
            type: "text",
            text: "User only message",
          })

          const tool = await CompactTool.init()
          const ctx = {
            sessionID: session.id,
            messageID: "",
            toolCallID: "",
            agent: "build",
            abort: AbortSignal.any([]),
            metadata: () => {},
          }

          const result = await tool.execute({
            ranges: [{ startMessageId: msgId }],
          }, ctx)

          // Should succeed but note missing model info
          expect(result.output).toContain("Generated summaries for 1 range")
          expect(result.output).toContain("No model information available")
          expect(isExecuteMetadata(result.metadata)).toBe(true)
          if (isExecuteMetadata(result.metadata)) {
            expect(result.metadata.error).toContain("No model information available")
          }

          await Session.remove(session.id)
        },
      })
    })
  })
})
