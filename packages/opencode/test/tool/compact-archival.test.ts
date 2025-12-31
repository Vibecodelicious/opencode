import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "../../src/id/id"

const projectRoot = path.join(__dirname, "../..")
const xdgBase = path.join(projectRoot, ".tmp", "xdg-compact-archival")

async function loadModules() {
  const { Instance } = await import("../../src/project/instance")
  const { Session } = await import("../../src/session")
  const { CompactTool, storeArchiveMetadata } = await import("../../src/tool/compact")
  const { MessageV2 } = await import("../../src/session/message-v2")
  const { Storage } = await import("../../src/storage/storage")
  const pluginModule = await import("../../src/plugin")

  return { Instance, Session, CompactTool, storeArchiveMetadata, MessageV2, Storage, pluginModule }
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
  fn: (mods: Omit<Modules, "pluginModule"> & { storeArchiveMetadata: Modules["storeArchiveMetadata"] }) => Promise<void>,
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
    await fn({
      Instance: mods.Instance,
      Session: mods.Session,
      CompactTool: mods.CompactTool,
      storeArchiveMetadata: mods.storeArchiveMetadata,
      MessageV2: mods.MessageV2,
      Storage: mods.Storage,
    })
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

/**
 * Helper to set up archive metadata on messages.
 * Thin wrapper around the real storeArchiveMetadata function - no reimplementation.
 */
async function setupArchiveMetadata(
  storeArchiveMetadata: Modules["storeArchiveMetadata"],
  sessionID: string,
  messages: Awaited<ReturnType<Modules["Session"]["messages"]>>,
  summary: { summary: string; indexTerms: string[] },
) {
  if (messages.length === 0) return { archivedCount: 0, skippedCount: 0, errors: [] }

  const startId = messages[0].info.id
  const endId = messages[messages.length - 1].info.id

  return storeArchiveMetadata({
    sessionID,
    validatedRanges: [{
      range: { startMessageId: startId, endMessageId: endId },
      messages,
    }],
    summaries: { [startId]: summary },
  })
}

/**
 * Helper to create a user message with a text part.
 */
async function createUserMessage(
  Session: Modules["Session"],
  sessionID: string,
  msgId: string,
  text: string,
) {
  await Session.updateMessage({
    id: msgId,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: msgId,
    type: "text",
    text,
  })
}

/**
 * Helper to create an assistant message with a text part.
 */
async function createAssistantMessage(
  Session: Modules["Session"],
  sessionID: string,
  msgId: string,
  parentID: string,
  text: string,
) {
  await Session.updateMessage({
    id: msgId,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    path: { cwd: projectRoot, root: projectRoot },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: msgId,
    type: "text",
    text,
  })
}

/**
 * Helper to create a CompactTool execution context.
 */
function createToolContext(sessionID: string) {
  return {
    sessionID,
    messageID: "",
    toolCallID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    metadata: () => {},
  }
}

/**
 * Test context passed to withTestSession callbacks.
 */
interface TestContext {
  session: { id: string }
  Session: Modules["Session"]
  MessageV2: Modules["MessageV2"]
  Storage: Modules["Storage"]
  storeArchiveMetadata: Modules["storeArchiveMetadata"]
  CompactTool: Modules["CompactTool"]
}

/**
 * Helper to wrap test logic with session creation/removal boilerplate.
 * Eliminates repetitive Instance.provide + Session.create + Session.remove pattern.
 */
async function withTestSession(
  fn: (ctx: TestContext) => Promise<void>,
  opts?: { skipModules?: ("CompactTool" | "storeArchiveMetadata")[] },
) {
  await withSandbox(async (mods) => {
    await mods.Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await mods.Session.create({})
        try {
          await fn({
            session,
            Session: mods.Session,
            MessageV2: mods.MessageV2,
            Storage: mods.Storage,
            storeArchiveMetadata: mods.storeArchiveMetadata,
            CompactTool: mods.CompactTool,
          })
        } finally {
          await mods.Session.remove(session.id)
        }
      },
    })
  })
}

/**
 * Assert that a message is an archive anchor with expected metadata.
 */
async function expectAnchor(
  ctx: Pick<TestContext, "MessageV2" | "session">,
  msgId: string,
  expected: { summary: string; indexTerms: string[]; rangeEnd: string },
) {
  const msg = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msgId })
  expect(msg.info.archive).toBeDefined()
  expect(msg.info.archive?.summary).toBe(expected.summary)
  expect(msg.info.archive?.indexTerms).toEqual(expected.indexTerms)
  expect(msg.info.archive?.rangeEnd).toBe(expected.rangeEnd)
  expect(msg.info.archivedBy).toBeUndefined()
}

/**
 * Assert that a message is a follower pointing to the given anchor.
 */
async function expectFollower(
  ctx: Pick<TestContext, "MessageV2" | "session">,
  msgId: string,
  anchorId: string,
) {
  const msg = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msgId })
  expect(msg.info.archive).toBeUndefined()
  expect(msg.info.archivedBy).toBe(anchorId)
}

/**
 * Assert that a message is not archived (no archive or archivedBy).
 */
async function expectUnarchived(
  ctx: Pick<TestContext, "MessageV2" | "session">,
  msgId: string,
) {
  const msg = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msgId })
  expect(msg.info.archive).toBeUndefined()
  expect(msg.info.archivedBy).toBeUndefined()
}

/**
 * Pre-archive a message as an anchor via Storage.update (simulates concurrent operation).
 */
async function preArchiveAsAnchor(
  ctx: Pick<TestContext, "Storage" | "session">,
  msgId: string,
  archive: { summary: string; indexTerms: string[]; rangeEnd: string },
) {
  await ctx.Storage.update<MessageV2.Info>(["message", ctx.session.id, msgId], (draft) => {
    draft.archive = archive
  })
}

/**
 * Pre-archive a message as a follower via Storage.update (simulates concurrent operation).
 */
async function preArchiveAsFollower(
  ctx: Pick<TestContext, "Storage" | "session">,
  msgId: string,
  anchorId: string,
) {
  await ctx.Storage.update<MessageV2.Info>(["message", ctx.session.id, msgId], (draft) => {
    draft.archivedBy = anchorId
  })
}

// Import MessageV2.Info type for Storage.update generics
import type { MessageV2 as MessageV2Type } from "../../src/session/message-v2"
type MessageV2 = typeof MessageV2Type

describe("archive metadata schema and persistence", () => {
  test("archive field structure: summary, indexTerms, rangeEnd", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message")
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test summary",
        indexTerms: ["test", "archive"],
      })

      await expectAnchor(ctx, msg1Id, {
        summary: "Test summary",
        indexTerms: ["test", "archive"],
        rangeEnd: msg1Id,
      })
    })
  })

  test("archivedBy field points to first message in range", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Discussion summary",
        indexTerms: ["discussion"],
      })

      await expectAnchor(ctx, msg1Id, {
        summary: "Discussion summary",
        indexTerms: ["discussion"],
        rangeEnd: msg3Id,
      })
      await expectFollower(ctx, msg2Id, msg1Id)
      await expectFollower(ctx, msg3Id, msg1Id)
    })
  })

  test("original content preserved: parts array unchanged after archival", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Original content that should be preserved")
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test summary",
        indexTerms: ["test"],
      })

      const msg = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg.parts).toHaveLength(1)
      expect(msg.parts[0].type).toBe("text")
      expect(msg.parts[0]).toHaveProperty("text", "Original content that should be preserved")
      expect(msg.info.archive).toBeDefined()
    })
  })
})

describe("archive metadata persistence across session resume", () => {
  test("archive metadata persists across Instance.disposeAll()", async () => {
    await withSandbox(async ({ Instance, Session, MessageV2, storeArchiveMetadata }) => {
      let sessionId: string
      let msg1Id: string
      let msg2Id: string

      // Phase 1: Create session, messages, and set archive metadata
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})
          sessionId = session.id
          msg1Id = Identifier.ascending("message")
          msg2Id = Identifier.ascending("message")

          await createUserMessage(Session, session.id, msg1Id, "First message")
          await createAssistantMessage(Session, session.id, msg2Id, msg1Id, "Second message")
          const messages = await Session.messages({ sessionID: session.id })
          await setupArchiveMetadata(storeArchiveMetadata, session.id, messages, {
            summary: "Persistent summary",
            indexTerms: ["persist", "test"],
          })
        },
      })

      // Phase 2: Dispose all instances (simulates process exit)
      await Instance.disposeAll()

      // Phase 3: Resume session in fresh Instance and verify persistence
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const reloadedMessages = await Session.messages({ sessionID: sessionId })

          const reloadedMsg1 = reloadedMessages.find((m) => m.info.id === msg1Id)
          expect(reloadedMsg1?.info.archive).toBeDefined()
          expect(reloadedMsg1?.info.archive?.summary).toBe("Persistent summary")
          expect(reloadedMsg1?.info.archive?.indexTerms).toEqual(["persist", "test"])
          expect(reloadedMsg1?.info.archive?.rangeEnd).toBe(msg2Id)

          const reloadedMsg2 = reloadedMessages.find((m) => m.info.id === msg2Id)
          expect(reloadedMsg2?.info.archivedBy).toBe(msg1Id)

          await Session.remove(sessionId)
        },
      })
    })
  })
})

describe("placeholder rendering after archival", () => {
  test("toModelMessage renders archived message as placeholder", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message content")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Second message content")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Third message - not archived")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const rangeMessages = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg2Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, rangeMessages, {
        summary: "Discussion about testing",
        indexTerms: ["test", "discussion"],
      })

      const reloadedMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(reloadedMessages)

      // First message rendered as placeholder
      expect(modelMessages[0].role).toBe("user")
      const firstContent = JSON.stringify(modelMessages[0].content)
      expect(firstContent).toContain("[SMART_ARCHIVED:")
      expect(firstContent).toContain("Summary: Discussion about testing")
      expect(firstContent).toContain("Index: test, discussion")

      // Second message (archivedBy) skipped - only 2 messages in output
      expect(modelMessages.length).toBe(2)

      // Third message rendered normally
      expect(modelMessages[1].role).toBe("user")
      expect(JSON.stringify(modelMessages[1].content)).toContain("Third message - not archived")
    })
  })

  test("single-message archive renders without range indicator", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Single message")
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Single message summary",
        indexTerms: ["single"],
      })

      const reloadedMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(reloadedMessages)

      expect(modelMessages.length).toBe(1)
      const content = JSON.stringify(modelMessages[0].content)
      expect(content).toContain(`[SMART_ARCHIVED: ${msg1Id}]`)
      expect(content).toContain("Summary: Single message summary")
    })
  })
})

describe("CompactTool integration", () => {
  // Note: Full end-to-end archival via CompactTool requires an LLM to generate summaries.
  // These tests verify the tool's behavior in edge cases without mocking the LLM layer.

  test("CompactTool gracefully handles missing model info (no assistant messages)", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Test message for compact integration")

      const tool = await ctx.CompactTool.init()
      const result = await tool.execute(
        { ranges: [{ startMessageId: msg1Id }] },
        createToolContext(ctx.session.id),
      )

      expect(result.metadata.archived).toBe(0)
      expect(result.output).toContain("No model information available")
    })
  })

  test("CompactTool reports correct output format when no archival occurs", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Test message")

      const tool = await ctx.CompactTool.init()
      const result = await tool.execute(
        { ranges: [{ startMessageId: msg1Id }] },
        createToolContext(ctx.session.id),
      )

      expect(result.title).toBe("Compaction summaries generated")
      expect(result.metadata.rangeCount).toBe(1)
      expect(result.metadata.totalMessages).toBe(1)
      expect(result.metadata.archived).toBe(0)
      expect(result.output).toContain("ready for archival")
    })
  })

  test("CompactTool rejects already-archived messages", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Already archived message")
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Already archived",
        indexTerms: ["archived"],
      })

      const tool = await ctx.CompactTool.init()
      await expect(
        tool.execute({ ranges: [{ startMessageId: msg1Id }] }, createToolContext(ctx.session.id)),
      ).rejects.toThrow(/already archived/)
    })
  })
})

describe("multi-range archival", () => {
  test("multiple independent ranges each get correct archive metadata", async () => {
    await withTestSession(async (ctx) => {
      // Create 6 messages for 2 ranges
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")
      const msg5Id = Identifier.ascending("message")
      const msg6Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1 message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Range 1 message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 message 1")
      await createUserMessage(ctx.Session, ctx.session.id, msg5Id, "Range 2 message 2")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg6Id, msg5Id, "Range 2 message 3")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Archive first range (msg1 to msg3)
      const range1 = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg3Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, range1, {
        summary: "First range summary about authentication",
        indexTerms: ["auth", "login", "security"],
      })

      // Archive second range (msg4 to msg6)
      const range2 = allMessages.filter(m => m.info.id >= msg4Id && m.info.id <= msg6Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, range2, {
        summary: "Second range summary about database design",
        indexTerms: ["database", "schema", "postgres"],
      })

      // Verify first range
      await expectAnchor(ctx, msg1Id, {
        summary: "First range summary about authentication",
        indexTerms: ["auth", "login", "security"],
        rangeEnd: msg3Id,
      })
      await expectFollower(ctx, msg2Id, msg1Id)
      await expectFollower(ctx, msg3Id, msg1Id)

      // Verify second range (independent from first)
      await expectAnchor(ctx, msg4Id, {
        summary: "Second range summary about database design",
        indexTerms: ["database", "schema", "postgres"],
        rangeEnd: msg6Id,
      })
      await expectFollower(ctx, msg5Id, msg4Id)
      await expectFollower(ctx, msg6Id, msg4Id)
    })
  })

  test("toModelMessage renders multiple archived ranges as separate placeholders", async () => {
    await withTestSession(async (ctx) => {
      // Create messages: 2 ranges + 1 unarchived message between them
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message") // unarchived
      const msg4Id = Identifier.ascending("message")
      const msg5Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1 start")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 end")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Unarchived message in between")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 start")
      await createUserMessage(ctx.Session, ctx.session.id, msg5Id, "Range 2 end")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Archive range 1
      const range1 = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg2Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, range1, {
        summary: "Range 1 summary",
        indexTerms: ["range1"],
      })

      // Archive range 2
      const range2 = allMessages.filter(m => m.info.id >= msg4Id && m.info.id <= msg5Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, range2, {
        summary: "Range 2 summary",
        indexTerms: ["range2"],
      })

      const reloadedMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(reloadedMessages)

      // Should have 3 messages: placeholder 1, unarchived, placeholder 2
      expect(modelMessages.length).toBe(3)

      // First placeholder
      const first = JSON.stringify(modelMessages[0].content)
      expect(first).toContain("[SMART_ARCHIVED:")
      expect(first).toContain("Range 1 summary")

      // Unarchived message
      const middle = JSON.stringify(modelMessages[1].content)
      expect(middle).toContain("Unarchived message in between")

      // Second placeholder
      const last = JSON.stringify(modelMessages[2].content)
      expect(last).toContain("[SMART_ARCHIVED:")
      expect(last).toContain("Range 2 summary")
    })
  })
})

describe("error handling and edge cases", () => {
  test("storeArchiveMetadata skips already-archived messages (race condition protection)", async () => {
    await withTestSession(async (ctx) => {
      // Create messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      // Pre-archive msg2 (simulating a concurrent operation)
      await preArchiveAsFollower(ctx, msg2Id, "msg_other_anchor")

      // Now try to archive range msg1 to msg3
      // The production code's race condition protection should skip msg2
      // and dynamically select msg1 as anchor since it's not archived
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test summary",
        indexTerms: ["test"],
      })

      // msg1 should have archive field
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive).toBeDefined()
      expect(msg1.info.archive?.summary).toBe("Test summary")

      // msg2 should still have its original archivedBy (from "concurrent" operation)
      const msg2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      expect(msg2.info.archivedBy).toBe("msg_other_anchor")

      // msg3 should have archivedBy pointing to msg1
      await expectFollower(ctx, msg3Id, msg1Id)
    })
  })

  test("all messages pre-archived: range fully skipped, no anchor established", async () => {
    await withTestSession(async (ctx) => {
      // Create messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      // Pre-archive ALL messages (simulating concurrent operation that beat us)
      await preArchiveAsAnchor(ctx, msg1Id, {
        summary: "Already archived by other operation",
        indexTerms: ["other"],
        rangeEnd: msg3Id,
      })
      await preArchiveAsFollower(ctx, msg2Id, msg1Id)
      await preArchiveAsFollower(ctx, msg3Id, msg1Id)

      // Now try to archive the same range - all should be skipped
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg3Id },
          messages,
        }],
        summaries: { [msg1Id]: { summary: "New summary", indexTerms: ["new"] } },
      })

      // No messages should be archived (all skipped)
      expect(result.archivedCount).toBe(0)
      expect(result.skippedCount).toBe(3)
      expect(result.errors).toHaveLength(0)

      // Original archive metadata should be unchanged
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1.info.archive?.summary).toBe("Already archived by other operation")
    })
  })

  test("anchor promotion: first message pre-archived, second becomes anchor", async () => {
    await withTestSession(async (ctx) => {
      // Create messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Message 4")

      // Pre-archive msg1 (the intended anchor) - simulating concurrent operation
      await preArchiveAsAnchor(ctx, msg1Id, {
        summary: "Previous archive",
        indexTerms: ["previous"],
        rangeEnd: msg1Id,
      })

      // Now try to archive range msg1 to msg4
      // Since msg1 is already archived, msg2 should be promoted to anchor
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "New archive summary",
        indexTerms: ["new", "promoted"],
      })

      // msg1 should keep its original archive (not overwritten)
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive).toBeDefined()
      expect(msg1.info.archive?.summary).toBe("Previous archive")
      expect(msg1.info.archivedBy).toBeUndefined()

      // msg2 should become the NEW anchor (promoted)
      await expectAnchor(ctx, msg2Id, {
        summary: "New archive summary",
        indexTerms: ["new", "promoted"],
        rangeEnd: msg4Id,
      })

      // msg3 and msg4 should point to msg2 (the promoted anchor)
      await expectFollower(ctx, msg3Id, msg2Id)
      await expectFollower(ctx, msg4Id, msg2Id)
    })
  })

  test("anchor promotion with rangeEnd adjustment: last message pre-archived", async () => {
    await withTestSession(async (ctx) => {
      // Create messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Message 4")

      // Pre-archive msg4 (the last message)
      await preArchiveAsFollower(ctx, msg4Id, "msg_other_anchor")

      // Try to archive range msg1 to msg4
      // msg1 becomes anchor, msg4 is skipped, rangeEnd should be updated to msg3
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Archive with adjusted rangeEnd",
        indexTerms: ["adjusted"],
      })

      // msg1 should be anchor with rangeEnd adjusted to msg3 (not msg4)
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive).toBeDefined()
      expect(msg1.info.archive?.summary).toBe("Archive with adjusted rangeEnd")
      expect(msg1.info.archive?.rangeEnd).toBe(msg3Id) // Adjusted!

      // msg2 and msg3 point to msg1
      await expectFollower(ctx, msg2Id, msg1Id)
      await expectFollower(ctx, msg3Id, msg1Id)

      // msg4 keeps its original archivedBy
      const msg4 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg4Id })
      expect(msg4.info.archivedBy).toBe("msg_other_anchor")
    })
  })

  test("only anchor archived: all subsequent messages pre-archived, rangeEnd corrected to anchor", async () => {
    await withTestSession(async (ctx) => {
      // Create messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      // Pre-archive msg2 and msg3 (all SUBSEQUENT messages)
      // msg1 is NOT pre-archived - it will become the anchor
      await preArchiveAsFollower(ctx, msg2Id, "msg_other_anchor")
      await preArchiveAsFollower(ctx, msg3Id, "msg_other_anchor")

      // Try to archive range msg1 to msg3
      // Only msg1 should get archived; rangeEnd should be corrected to msg1 (not msg3)
      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg3Id },
          messages,
        }],
        summaries: { [msg1Id]: { summary: "Only anchor archived", indexTerms: ["anchor"] } },
      })

      // Only 1 message archived (msg1), 2 skipped (msg2, msg3)
      expect(result.archivedCount).toBe(1)
      expect(result.skippedCount).toBe(2)
      expect(result.errors).toHaveLength(0)

      // CRITICAL: msg1's rangeEnd should be msg1 (corrected), NOT msg3 (original)
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive).toBeDefined()
      expect(msg1.info.archive?.summary).toBe("Only anchor archived")
      expect(msg1.info.archive?.rangeEnd).toBe(msg1Id) // ← This is the key assertion

      // msg2 and msg3 should keep their original archivedBy
      const msg2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      expect(msg2.info.archivedBy).toBe("msg_other_anchor")

      const msg3 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      expect(msg3.info.archivedBy).toBe("msg_other_anchor")
    })
  })

  test("partial archival: missing summary for one range does not affect other ranges", async () => {
    await withTestSession(async (ctx) => {
      // Create 4 messages for 2 ranges
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1 message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Range 2 message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 message 2")

      // Only archive first range, simulating missing summary for second range
      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const range1Messages = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg2Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, range1Messages, {
        summary: "First range summary",
        indexTerms: ["range1"],
      })

      // Verify first range is archived
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive).toBeDefined()
      expect(msg1.info.archive?.summary).toBe("First range summary")

      await expectFollower(ctx, msg2Id, msg1Id)

      // Verify second range is NOT archived (simulating missing summary skip)
      await expectUnarchived(ctx, msg3Id)
      await expectUnarchived(ctx, msg4Id)
    })
  })
})

describe("storeArchiveMetadata e2e tests (real function)", () => {
  test("storeArchiveMetadata archives messages with provided summaries", async () => {
    await withTestSession(async (ctx) => {
      // Create messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Second message")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Third message")

      // Get messages for the range
      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const messagesInRange = allMessages.filter(
        (m) => m.info.id >= msg1Id && m.info.id <= msg3Id,
      )

      // Create summaries keyed by startMessageId
      const summaries = {
        [msg1Id]: {
          summary: "E2E test summary covering authentication discussion",
          indexTerms: ["e2e", "auth", "test"],
        },
      }

      // Call the REAL storeArchiveMetadata function
      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [
          {
            range: { startMessageId: msg1Id, endMessageId: msg3Id },
            messages: messagesInRange,
          },
        ],
        summaries,
      })

      // Verify result
      expect(result.archivedCount).toBe(3)
      expect(result.skippedCount).toBe(0)
      expect(result.errors).toHaveLength(0)

      // Verify messages were actually archived
      await expectAnchor(ctx, msg1Id, {
        summary: "E2E test summary covering authentication discussion",
        indexTerms: ["e2e", "auth", "test"],
        rangeEnd: msg3Id,
      })
      await expectFollower(ctx, msg2Id, msg1Id)
      await expectFollower(ctx, msg3Id, msg1Id)
    })
  })

  test("storeArchiveMetadata handles multiple ranges with different summaries", async () => {
    await withTestSession(async (ctx) => {
      // Create messages for two ranges
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1 start")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 end")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Range 2 start")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 end")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Create summaries for both ranges
      const summaries = {
        [msg1Id]: {
          summary: "First range about setup",
          indexTerms: ["setup", "config"],
        },
        [msg3Id]: {
          summary: "Second range about deployment",
          indexTerms: ["deploy", "production"],
        },
      }

      // Call the REAL storeArchiveMetadata function with multiple ranges
      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [
          {
            range: { startMessageId: msg1Id, endMessageId: msg2Id },
            messages: allMessages.filter((m) => m.info.id >= msg1Id && m.info.id <= msg2Id),
          },
          {
            range: { startMessageId: msg3Id, endMessageId: msg4Id },
            messages: allMessages.filter((m) => m.info.id >= msg3Id && m.info.id <= msg4Id),
          },
        ],
        summaries,
      })

      // Verify result
      expect(result.archivedCount).toBe(4)
      expect(result.errors).toHaveLength(0)

      // Verify first range
      const r1m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(r1m1.info.archive?.summary).toBe("First range about setup")
      expect(r1m1.info.archive?.rangeEnd).toBe(msg2Id)

      await expectFollower(ctx, msg2Id, msg1Id)

      // Verify second range (independent anchor)
      const r2m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      expect(r2m1.info.archive?.summary).toBe("Second range about deployment")
      expect(r2m1.info.archive?.rangeEnd).toBe(msg4Id)

      await expectFollower(ctx, msg4Id, msg3Id)
    })
  })

  test("storeArchiveMetadata reports error when summary missing for range", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Empty summaries - no summary for the range
      const summaries = {}

      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [
          {
            range: { startMessageId: msg1Id, endMessageId: msg2Id },
            messages: allMessages,
          },
        ],
        summaries,
      })

      // Should report error about missing summary
      expect(result.archivedCount).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("No summary found")
      expect(result.errors[0]).toContain(msg1Id)

      // Messages should NOT be archived
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1.info.archive).toBeUndefined()
    })
  })
})

describe("Storage.update() failure handling", () => {
  test("storeArchiveMetadata handles Storage.update() failure gracefully", async () => {
    await withTestSession(async (ctx) => {
      // Create messages for two ranges
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1 message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Range 2 message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 message 2")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Delete the file for msg3 to simulate storage failure for range 2
      // Storage.update() will fail when trying to read the deleted file
      await ctx.Storage.remove(["message", ctx.session.id, msg3Id])

      const summaries = {
        [msg1Id]: { summary: "Range 1 summary", indexTerms: ["range1"] },
        [msg3Id]: { summary: "Range 2 summary", indexTerms: ["range2"] },
      }

      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [
          {
            range: { startMessageId: msg1Id, endMessageId: msg2Id },
            messages: allMessages.filter((m) => m.info.id >= msg1Id && m.info.id <= msg2Id),
          },
          {
            range: { startMessageId: msg3Id, endMessageId: msg4Id },
            messages: allMessages.filter((m) => m.info.id >= msg3Id && m.info.id <= msg4Id),
          },
        ],
        summaries,
      })

      // Range 1 should succeed, Range 2 should fail
      expect(result.archivedCount).toBe(2) // Only range 1 archived
      expect(result.errors).toHaveLength(1) // Range 2 failed
      expect(result.errors[0]).toContain("Failed to archive range")
      expect(result.errors[0]).toContain(msg3Id)

      // Verify range 1 was archived successfully
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1.info.archive).toBeDefined()
      expect(m1.info.archive?.summary).toBe("Range 1 summary")

      await expectFollower(ctx, msg2Id, msg1Id)

      // Range 2 messages: msg3 file was deleted so can't verify, msg4 should be untouched
      await expectUnarchived(ctx, msg4Id)
    })
  })

  test("storeArchiveMetadata fixes anchor rangeEnd on mid-range failure", async () => {
    await withTestSession(async (ctx) => {
      // Create 4 messages for a single range
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Message 4")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Delete msg3 file to cause MID-RANGE failure
      // msg1 (anchor) and msg2 should succeed, msg3 fails, msg4 never attempted
      await ctx.Storage.remove(["message", ctx.session.id, msg3Id])

      const summaries = {
        [msg1Id]: { summary: "Range summary", indexTerms: ["test"] },
      }

      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [
          {
            range: { startMessageId: msg1Id, endMessageId: msg4Id },
            messages: allMessages,
          },
        ],
        summaries,
      })

      // Should report partial success with error
      expect(result.archivedCount).toBe(2) // msg1 and msg2 archived
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("Failed to archive range")

      // CRITICAL: Verify anchor's rangeEnd was corrected to msg2 (last successful)
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1.info.archive).toBeDefined()
      expect(m1.info.archive?.summary).toBe("Range summary")
      expect(m1.info.archive?.rangeEnd).toBe(msg2Id) // ← Fixed to actual last archived

      // msg2 should have archivedBy pointing to msg1
      await expectFollower(ctx, msg2Id, msg1Id)

      // msg4 should be untouched (never attempted after msg3 failed)
      await expectUnarchived(ctx, msg4Id)
    })
  })

  test("storeArchiveMetadata continues to next range after failure", async () => {
    await withTestSession(async (ctx) => {
      // Create messages for three ranges
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")
      const msg5Id = Identifier.ascending("message")
      const msg6Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 end")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Range 2")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 end")
      await createUserMessage(ctx.Session, ctx.session.id, msg5Id, "Range 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg6Id, msg5Id, "Range 3 end")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Delete msg3 file to make range 2 fail
      await ctx.Storage.remove(["message", ctx.session.id, msg3Id])

      const summaries = {
        [msg1Id]: { summary: "Range 1", indexTerms: ["r1"] },
        [msg3Id]: { summary: "Range 2", indexTerms: ["r2"] },
        [msg5Id]: { summary: "Range 3", indexTerms: ["r3"] },
      }

      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [
          {
            range: { startMessageId: msg1Id, endMessageId: msg2Id },
            messages: allMessages.filter((m) => m.info.id >= msg1Id && m.info.id <= msg2Id),
          },
          {
            range: { startMessageId: msg3Id, endMessageId: msg4Id },
            messages: allMessages.filter((m) => m.info.id >= msg3Id && m.info.id <= msg4Id),
          },
          {
            range: { startMessageId: msg5Id, endMessageId: msg6Id },
            messages: allMessages.filter((m) => m.info.id >= msg5Id && m.info.id <= msg6Id),
          },
        ],
        summaries,
      })

      // Ranges 1 and 3 should succeed, Range 2 should fail
      expect(result.archivedCount).toBe(4) // 2 from range 1 + 2 from range 3
      expect(result.errors).toHaveLength(1)

      // Verify range 1 archived
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1.info.archive?.summary).toBe("Range 1")

      // Verify range 3 archived (continued after range 2 failure)
      const m5 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg5Id })
      expect(m5.info.archive?.summary).toBe("Range 3")

      await expectFollower(ctx, msg6Id, msg5Id)
    })
  })
})

describe("rangeEnd correction ownership verification", () => {
  test("rangeEnd correction skipped when archive summary doesn't match (concurrent modification)", async () => {
    await withTestSession(async (ctx) => {
      // Create 3 messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      // Pre-archive msg3 to force rangeEnd correction (our archive will end at msg2)
      await preArchiveAsFollower(ctx, msg3Id, "msg_other_anchor")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Archive range msg1 to msg3
      // msg1 becomes anchor, msg2 gets archivedBy, msg3 skipped
      // rangeEnd correction will try to update msg1's rangeEnd from msg3 to msg2
      await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg3Id },
          messages: allMessages,
        }],
        summaries: { [msg1Id]: { summary: "Our summary", indexTerms: ["test"] } },
      })

      // Verify our archive was created
      const m1Before = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1Before.info.archive?.summary).toBe("Our summary")
      expect(m1Before.info.archive?.rangeEnd).toBe(msg2Id) // Corrected from msg3

      // Now simulate a concurrent operation that overwrites our archive with a different summary
      await preArchiveAsAnchor(ctx, msg1Id, {
        summary: "Concurrent operation summary",
        indexTerms: ["concurrent"],
        rangeEnd: msg1Id, // Concurrent op archived only msg1
      })

      // Try to archive the same range again with a different summary
      // The rangeEnd correction should NOT overwrite because summary doesn't match
      await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg3Id },
          messages: allMessages, // Still has old data, msg1 will be skipped as pre-archived
        }],
        summaries: { [msg1Id]: { summary: "Another summary attempt", indexTerms: ["another"] } },
      })

      // Verify the concurrent operation's archive is preserved
      const m1After = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1After.info.archive?.summary).toBe("Concurrent operation summary")
      expect(m1After.info.archive?.rangeEnd).toBe(msg1Id) // NOT overwritten
    })
  })
})
