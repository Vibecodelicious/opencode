import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "../../src/id/id"

const projectRoot = path.join(__dirname, "../..")
const xdgBase = path.join(projectRoot, ".tmp", "xdg-retrieve")

async function loadModules() {
  const { Instance } = await import("../../src/project/instance")
  const { Session } = await import("../../src/session")
  const { RetrieveTool } = await import("../../src/tool/retrieve")
  const { storeArchiveMetadata } = await import("../../src/tool/compact")
  const { MessageV2 } = await import("../../src/session/message-v2")
  const { Storage } = await import("../../src/storage/storage")
  const pluginModule = await import("../../src/plugin")

  return { Instance, Session, RetrieveTool, storeArchiveMetadata, MessageV2, Storage, pluginModule }
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
    await fn({
      Instance: mods.Instance,
      Session: mods.Session,
      RetrieveTool: mods.RetrieveTool,
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
 * Helper to create a RetrieveTool execution context.
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
 * Helper to set up archive metadata on messages using the real storeArchiveMetadata.
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
 * Test context passed to withTestSession callbacks.
 */
interface TestContext {
  session: { id: string }
  Session: Modules["Session"]
  MessageV2: Modules["MessageV2"]
  Storage: Modules["Storage"]
  RetrieveTool: Modules["RetrieveTool"]
  storeArchiveMetadata: Modules["storeArchiveMetadata"]
}

/**
 * Helper to wrap test logic with session creation/removal boilerplate.
 */
async function withTestSession(fn: (ctx: TestContext) => Promise<void>) {
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
            RetrieveTool: mods.RetrieveTool,
            storeArchiveMetadata: mods.storeArchiveMetadata,
          })
        } finally {
          await mods.Session.remove(session.id)
        }
      },
    })
  })
}

describe("retrieve tool - successful retrieval", () => {
  test("retrieves single-message archive successfully", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "This is the original message content")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Single message test",
        indexTerms: ["test", "single"],
      })

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Retrieved archived content")
      expect(result.output).toContain(`Retrieved content from archive ${msg1Id}:`)
      expect(result.output).toContain("This is the original message content")
      expect(result.output).toContain(`[${msg1Id}]`)
      expect(result.output).toContain("User message")

      expect(result.metadata.archiveId).toBe(msg1Id)
      expect(result.metadata.rangeEnd).toBe(msg1Id)
      expect(result.metadata.messageCount).toBe(1)
      expect(result.metadata.tokenEstimate).toBeGreaterThan(0)
      expect(result.metadata.summary).toBe("Single message test")
      expect(result.metadata.indexTerms).toEqual(["test", "single"])
    })
  })

  test("retrieves multi-message archive range successfully", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First user question")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Assistant response here")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Follow-up question")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Multi-message discussion",
        indexTerms: ["discussion", "qa"],
      })

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Retrieved archived content")
      expect(result.output).toContain(`Retrieved content from archive ${msg1Id} to ${msg3Id}:`)
      expect(result.output).toContain("First user question")
      expect(result.output).toContain("Assistant response here")
      expect(result.output).toContain("Follow-up question")
      expect(result.output).toContain(`[${msg1Id}]`)
      expect(result.output).toContain(`[${msg2Id}]`)
      expect(result.output).toContain(`[${msg3Id}]`)

      expect(result.metadata.archiveId).toBe(msg1Id)
      expect(result.metadata.rangeEnd).toBe(msg3Id)
      expect(result.metadata.messageCount).toBe(3)
    })
  })

  test("formats user and assistant messages correctly", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "User says hello")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Assistant responds")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Greeting exchange",
        indexTerms: ["greeting"],
      })

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.output).toContain("User message:")
      expect(result.output).toContain("User says hello")
      expect(result.output).toContain("Assistant message:")
      expect(result.output).toContain("Assistant responds")
    })
  })
})

describe("retrieve tool - error handling", () => {
  test("returns error for non-existent message ID", async () => {
    await withTestSession(async (ctx) => {
      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: "msg_nonexistent" }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Archive retrieval failed")
      expect(result.output).toContain("Error:")
      expect(result.output).toContain("msg_nonexistent")
      expect(result.output).toContain("does not exist")
      expect(result.metadata.error).toBe("not_found")
      expect(result.metadata.archiveId).toBe("msg_nonexistent")
    })
  })

  test("returns error for message without archive field (not an anchor)", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message - will be anchor")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Second message - will be follower")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test archive",
        indexTerms: ["test"],
      })

      // Try to retrieve using the FOLLOWER message ID (which has archivedBy, not archive)
      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg2Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Archive retrieval failed")
      expect(result.output).toContain("Error:")
      expect(result.output).toContain(msg2Id)
      expect(result.output).toContain("not an archive anchor")
      expect(result.metadata.error).toBe("not_anchor")
    })
  })

  test("returns error for regular message (neither anchor nor follower)", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      // Create a message but don't archive it
      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Regular unarchived message")

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Archive retrieval failed")
      expect(result.output).toContain("Error:")
      expect(result.output).toContain("not an archive anchor")
      expect(result.metadata.error).toBe("not_anchor")
    })
  })

  test("validates archiveId is required", async () => {
    await withTestSession(async (ctx) => {
      const tool = await ctx.RetrieveTool.init()

      // The tool throws a validation error for empty archiveId
      let errorThrown = false
      try {
        await tool.execute({ archiveId: "" }, createToolContext(ctx.session.id))
      } catch (error) {
        errorThrown = true
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("archiveId")
      }
      expect(errorThrown).toBe(true)
    })
  })

  test("returns error for broken rangeEnd reference", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Second message")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test archive",
        indexTerms: ["test"],
      })

      // Manually corrupt the archive by deleting the rangeEnd message
      await ctx.Storage.remove(["message", ctx.session.id, msg2Id])

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Archive retrieval failed")
      expect(result.output).toContain("Error:")
      expect(result.output).toContain("broken reference")
      expect(result.output).toContain(msg2Id)
      expect(result.metadata.error).toBe("broken_range_end")
    })
  })

  test("returns error for empty range (corrupted archive with inverted range)", async () => {
    await withTestSession(async (ctx) => {
      // Create two messages with predictable ordering
      const msg1Id = Identifier.ascending("message") // Earlier ID
      const msg2Id = Identifier.ascending("message") // Later ID

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Earlier message")
      await createUserMessage(ctx.Session, ctx.session.id, msg2Id, "Later message")

      // Manually corrupt: set archive on msg2 (later) with rangeEnd pointing to msg1 (earlier)
      // This creates an impossible range where anchor > rangeEnd lexicographically
      await ctx.Storage.update<import("../../src/session/message-v2").MessageV2.Info>(
        ["message", ctx.session.id, msg2Id],
        (draft) => {
          draft.archive = {
            summary: "Corrupted archive with inverted range",
            indexTerms: ["test"],
            rangeEnd: msg1Id, // Points to earlier message - creates impossible range
          }
        },
      )

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg2Id }, createToolContext(ctx.session.id))

      // The filter (id >= msg2Id && id <= msg1Id) returns empty since msg2Id > msg1Id
      expect(result.title).toBe("Archive retrieval failed")
      expect(result.output).toContain("Error:")
      expect(result.output).toContain("No messages found")
      expect(result.output).toContain("data inconsistency")
      expect(result.metadata.error).toBe("empty_range")
      expect(result.metadata.archiveId).toBe(msg2Id)
      expect(result.metadata.rangeEnd).toBe(msg1Id)
    })
  })
})

describe("retrieve tool - archive metadata preservation", () => {
  test("retrieval does not modify archive metadata on anchor", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Second message")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Original summary",
        indexTerms: ["original", "terms"],
      })

      // Get archive metadata before retrieval
      const beforeMsg = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      const beforeArchive = beforeMsg.info.archive

      // Perform retrieval
      const tool = await ctx.RetrieveTool.init()
      await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      // Verify archive metadata is unchanged
      const afterMsg = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(afterMsg.info.archive).toEqual(beforeArchive)
      expect(afterMsg.info.archive?.summary).toBe("Original summary")
      expect(afterMsg.info.archive?.indexTerms).toEqual(["original", "terms"])
      expect(afterMsg.info.archive?.rangeEnd).toBe(msg2Id)
    })
  })

  test("retrieval does not modify archivedBy metadata on followers", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "First message")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Second message")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Third message")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test archive",
        indexTerms: ["test"],
      })

      // Verify followers have archivedBy before retrieval
      const beforeMsg2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      const beforeMsg3 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      expect(beforeMsg2.info.archivedBy).toBe(msg1Id)
      expect(beforeMsg3.info.archivedBy).toBe(msg1Id)

      // Perform retrieval
      const tool = await ctx.RetrieveTool.init()
      await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      // Verify archivedBy is unchanged
      const afterMsg2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      const afterMsg3 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      expect(afterMsg2.info.archivedBy).toBe(msg1Id)
      expect(afterMsg3.info.archivedBy).toBe(msg1Id)
    })
  })

  test("archived messages still render as placeholders after retrieval", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Original content")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Response content")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test summary",
        indexTerms: ["test"],
      })

      // Perform retrieval
      const tool = await ctx.RetrieveTool.init()
      await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      // Verify toModelMessage still renders as placeholder
      const reloadedMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(reloadedMessages)

      expect(modelMessages.length).toBe(1) // Only 1 message (placeholder), follower is skipped
      const content = JSON.stringify(modelMessages[0].content)
      expect(content).toContain("[SMART_ARCHIVED:")
      expect(content).toContain("Summary: Test summary")
    })
  })
})

describe("retrieve tool - content formatting", () => {
  test("includes token estimate in metadata", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "This is some text content for token estimation")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Token test",
        indexTerms: ["tokens"],
      })

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.metadata.tokenEstimate).toBeDefined()
      expect(typeof result.metadata.tokenEstimate).toBe("number")
      expect(result.metadata.tokenEstimate).toBeGreaterThan(0)
    })
  })

  test("includes summary and indexTerms in metadata", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Test message")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "A detailed summary of the content",
        indexTerms: ["term1", "term2", "term3"],
      })

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.metadata.summary).toBe("A detailed summary of the content")
      expect(result.metadata.indexTerms).toEqual(["term1", "term2", "term3"])
    })
  })

  test("handles empty message parts gracefully", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      // Create message without text part (just the message metadata)
      await ctx.Session.updateMessage({
        id: msg1Id,
        sessionID: ctx.session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      })

      // Manually add archive metadata via Storage
      await ctx.Storage.update<import("../../src/session/message-v2").MessageV2.Info>(
        ["message", ctx.session.id, msg1Id],
        (draft) => {
          draft.archive = {
            summary: "Empty message test",
            indexTerms: ["empty"],
            rangeEnd: msg1Id,
          }
        },
      )

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Retrieved archived content")
      expect(result.output).toContain("(empty)")
      expect(result.metadata.messageCount).toBe(1)
    })
  })

  test("excludes ignored text parts from retrieval output and token count", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      // Create user message
      await ctx.Session.updateMessage({
        id: msg1Id,
        sessionID: ctx.session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      })

      // Add a normal text part
      await ctx.Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: ctx.session.id,
        messageID: msg1Id,
        type: "text",
        text: "This text should be included",
      })

      // Add an ignored text part (simulating system content that shouldn't be retrieved)
      await ctx.Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: ctx.session.id,
        messageID: msg1Id,
        type: "text",
        text: "SECRET_IGNORED_CONTENT_SHOULD_NOT_APPEAR",
        ignored: true,
      })

      // Manually add archive metadata via Storage
      await ctx.Storage.update<import("../../src/session/message-v2").MessageV2.Info>(
        ["message", ctx.session.id, msg1Id],
        (draft) => {
          draft.archive = {
            summary: "Ignored parts test",
            indexTerms: ["ignored"],
            rangeEnd: msg1Id,
          }
        },
      )

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Retrieved archived content")
      // Normal text should be included
      expect(result.output).toContain("This text should be included")
      // Ignored text should NOT be included
      expect(result.output).not.toContain("SECRET_IGNORED_CONTENT_SHOULD_NOT_APPEAR")
      // Token estimate should only count non-ignored content
      expect(result.metadata.tokenEstimate).toBeDefined()
      expect(result.metadata.tokenEstimate).toBeGreaterThan(0)
    })
  })
})

describe("retrieve tool - reasoning part handling", () => {
  test("includes reasoning parts in retrieved content", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      // Create assistant message with a reasoning part
      await ctx.Session.updateMessage({
        id: msg1Id,
        sessionID: ctx.session.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "msg_parent",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: projectRoot, root: projectRoot },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // Add a reasoning part
      await ctx.Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: ctx.session.id,
        messageID: msg1Id,
        type: "reasoning",
        text: "Let me think through this problem step by step...",
        time: { start: Date.now() - 500, end: Date.now() },
      })

      // Manually add archive metadata via Storage
      await ctx.Storage.update<import("../../src/session/message-v2").MessageV2.Info>(
        ["message", ctx.session.id, msg1Id],
        (draft) => {
          draft.archive = {
            summary: "Reasoning test",
            indexTerms: ["reasoning"],
            rangeEnd: msg1Id,
          }
        },
      )

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Retrieved archived content")
      expect(result.output).toContain("[Reasoning]")
      expect(result.output).toContain("Let me think through this problem step by step...")
    })
  })
})

describe("retrieve tool - tool part handling", () => {
  test("handles completed tool parts with empty output gracefully", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      // Create assistant message with a completed tool part that has empty output
      await ctx.Session.updateMessage({
        id: msg1Id,
        sessionID: ctx.session.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "msg_parent",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: projectRoot, root: projectRoot },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // Add a completed tool part with empty output
      await ctx.Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: ctx.session.id,
        messageID: msg1Id,
        type: "tool",
        callID: "call_empty",
        tool: "write",
        state: {
          status: "completed",
          input: { file_path: "/path/to/file.ts", content: "..." },
          output: "", // Empty output
          title: "Write file",
          metadata: {},
          time: { start: Date.now() - 1000, end: Date.now() },
        },
      })

      // Manually add archive metadata via Storage
      await ctx.Storage.update<import("../../src/session/message-v2").MessageV2.Info>(
        ["message", ctx.session.id, msg1Id],
        (draft) => {
          draft.archive = {
            summary: "Empty tool output test",
            indexTerms: ["tool", "empty"],
            rangeEnd: msg1Id,
          }
        },
      )

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      // Should succeed and show the message (tool with empty output is simply not included)
      expect(result.title).toBe("Retrieved archived content")
      expect(result.output).toContain(`[${msg1Id}]`)
      // Empty tool output is not included in content
      expect(result.output).not.toContain("[Tool: write]")
    })
  })

  test("includes completed tool outputs in retrieved content", async () => {
    await withTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      // Create assistant message with a completed tool part
      await ctx.Session.updateMessage({
        id: msg1Id,
        sessionID: ctx.session.id,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "msg_parent",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: projectRoot, root: projectRoot },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // Add a completed tool part
      await ctx.Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: ctx.session.id,
        messageID: msg1Id,
        type: "tool",
        callID: "call_123",
        tool: "read",
        state: {
          status: "completed",
          input: { file_path: "/path/to/file.ts" },
          output: "File content here:\n\nconst x = 1;",
          title: "Read file",
          metadata: {},
          time: { start: Date.now() - 1000, end: Date.now() },
        },
      })

      // Manually add archive metadata via Storage
      await ctx.Storage.update<import("../../src/session/message-v2").MessageV2.Info>(
        ["message", ctx.session.id, msg1Id],
        (draft) => {
          draft.archive = {
            summary: "Tool output test",
            indexTerms: ["tool"],
            rangeEnd: msg1Id,
          }
        },
      )

      const tool = await ctx.RetrieveTool.init()
      const result = await tool.execute({ archiveId: msg1Id }, createToolContext(ctx.session.id))

      expect(result.title).toBe("Retrieved archived content")
      expect(result.output).toContain("[Tool: read]")
      expect(result.output).toContain("File content here")
      expect(result.output).toContain("const x = 1")
    })
  })
})
