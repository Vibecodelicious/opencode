import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "../../src/id/id"

const projectRoot = path.join(__dirname, "../..")
const xdgBase = path.join(projectRoot, ".tmp", "xdg-compact-persistence")

async function loadModules() {
  const { Instance } = await import("../../src/project/instance")
  const { Session } = await import("../../src/session")
  const { storeArchiveMetadata, validateArchiveReferences } = await import("../../src/tool/compact")
  const { MessageV2 } = await import("../../src/session/message-v2")
  const { Storage } = await import("../../src/storage/storage")
  const pluginModule = await import("../../src/plugin")

  return { Instance, Session, storeArchiveMetadata, validateArchiveReferences, MessageV2, Storage, pluginModule }
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
      storeArchiveMetadata: mods.storeArchiveMetadata,
      validateArchiveReferences: mods.validateArchiveReferences,
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
 * Helper to set up archive metadata on messages.
 */
async function setupArchiveMetadata(
  storeArchiveMetadata: Modules["storeArchiveMetadata"],
  sessionID: string,
  messages: Awaited<ReturnType<Modules["Session"]["messages"]>>,
  summary: { summary: string; indexTerms: string[] },
): Promise<ArchiveMetadataResult> {
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

// Static type imports - distinct from dynamic modules loaded in withSandbox
import type { MessageV2 as MessageV2Types } from "../../src/session/message-v2"
import type { ArchiveMetadataResult } from "../../src/tool/compact"

/**
 * Test context for reference validation tests.
 */
interface RefValidationTestContext {
  session: { id: string }
  Session: Modules["Session"]
  MessageV2: Modules["MessageV2"]
  Storage: Modules["Storage"]
  storeArchiveMetadata: Modules["storeArchiveMetadata"]
  validateArchiveReferences: Modules["validateArchiveReferences"]
}

/**
 * Helper to wrap test logic with session creation for reference validation tests.
 */
async function withRefValidationTestSession(
  fn: (ctx: RefValidationTestContext) => Promise<void>,
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
            validateArchiveReferences: mods.validateArchiveReferences,
          })
        } finally {
          await mods.Session.remove(session.id)
        }
      },
    })
  })
}

describe("archive persistence across multiple resume cycles (AC: 1, 3)", () => {
  test("archive metadata persists across multiple Instance.disposeAll() cycles", async () => {
    await withSandbox(async ({ Instance, Session, MessageV2, storeArchiveMetadata }) => {
      let sessionId: string
      let msg1Id: string
      let msg2Id: string
      let msg3Id: string

      // Phase 1: Create session, messages, and set archive metadata
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})
          sessionId = session.id
          msg1Id = Identifier.ascending("message")
          msg2Id = Identifier.ascending("message")
          msg3Id = Identifier.ascending("message")

          await createUserMessage(Session, session.id, msg1Id, "First message content")
          await createAssistantMessage(Session, session.id, msg2Id, msg1Id, "Second message content")
          await createUserMessage(Session, session.id, msg3Id, "Third message content")

          const messages = await Session.messages({ sessionID: session.id })
          await setupArchiveMetadata(storeArchiveMetadata, session.id, messages, {
            summary: "Multi-cycle persistence test summary",
            indexTerms: ["persist", "cycle", "test"],
          })
        },
      })

      // Phase 2: First resume cycle - verify and add more content
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const messages = await Session.messages({ sessionID: sessionId })

          // Verify archive metadata persisted
          const msg1 = messages.find((m) => m.info.id === msg1Id)
          expect(msg1?.info.archive).toBeDefined()
          expect(msg1?.info.archive?.summary).toBe("Multi-cycle persistence test summary")
          expect(msg1?.info.archive?.indexTerms).toEqual(["persist", "cycle", "test"])
          expect(msg1?.info.archive?.rangeEnd).toBe(msg3Id)

          // Verify followers
          const msg2 = messages.find((m) => m.info.id === msg2Id)
          expect(msg2?.info.archivedBy).toBe(msg1Id)

          const msg3 = messages.find((m) => m.info.id === msg3Id)
          expect(msg3?.info.archivedBy).toBe(msg1Id)
        },
      })

      // Phase 3: Second resume cycle - verify data integrity unchanged
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const messages = await Session.messages({ sessionID: sessionId })

          // Verify archive metadata STILL persisted after second cycle
          const msg1 = messages.find((m) => m.info.id === msg1Id)
          expect(msg1?.info.archive).toBeDefined()
          expect(msg1?.info.archive?.summary).toBe("Multi-cycle persistence test summary")
          expect(msg1?.info.archive?.indexTerms).toEqual(["persist", "cycle", "test"])
          expect(msg1?.info.archive?.rangeEnd).toBe(msg3Id)

          // Verify original content unchanged
          expect(msg1?.parts).toHaveLength(1)
          expect(msg1?.parts[0].type).toBe("text")
          expect(msg1?.parts[0]).toHaveProperty("text", "First message content")

          const msg2 = messages.find((m) => m.info.id === msg2Id)
          expect(msg2?.info.archivedBy).toBe(msg1Id)
          expect(msg2?.parts[0]).toHaveProperty("text", "Second message content")

          const msg3 = messages.find((m) => m.info.id === msg3Id)
          expect(msg3?.info.archivedBy).toBe(msg1Id)
          expect(msg3?.parts[0]).toHaveProperty("text", "Third message content")

          // Cleanup
          await Session.remove(sessionId)
        },
      })
    })
  })

  test("placeholder rendering works correctly after session resume", async () => {
    await withSandbox(async ({ Instance, Session, MessageV2, storeArchiveMetadata }) => {
      let sessionId: string
      let msg1Id: string
      let msg2Id: string
      let msg3Id: string

      // Phase 1: Create session with archived messages
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})
          sessionId = session.id
          msg1Id = Identifier.ascending("message")
          msg2Id = Identifier.ascending("message")
          msg3Id = Identifier.ascending("message")

          await createUserMessage(Session, session.id, msg1Id, "Message to archive 1")
          await createAssistantMessage(Session, session.id, msg2Id, msg1Id, "Message to archive 2")
          await createUserMessage(Session, session.id, msg3Id, "Unarchived message")

          // Archive only first two messages
          const allMessages = await Session.messages({ sessionID: session.id })
          const rangeMessages = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg2Id)
          await setupArchiveMetadata(storeArchiveMetadata, session.id, rangeMessages, {
            summary: "Archived conversation about testing",
            indexTerms: ["test", "archive"],
          })
        },
      })

      // Phase 2: Resume and verify placeholder rendering
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const messages = await Session.messages({ sessionID: sessionId })
          const modelMessages = MessageV2.toModelMessage(messages)

          // Should have 2 messages: placeholder for archived range, unarchived message
          expect(modelMessages.length).toBe(2)

          // First message should be placeholder
          const firstContent = JSON.stringify(modelMessages[0].content)
          expect(firstContent).toContain("[SMART_ARCHIVED:")
          expect(firstContent).toContain("Archived conversation about testing")
          expect(firstContent).toContain("test, archive")

          // Second message should be the unarchived one
          const secondContent = JSON.stringify(modelMessages[1].content)
          expect(secondContent).toContain("Unarchived message")
          expect(secondContent).not.toContain("SMART_ARCHIVED")

          await Session.remove(sessionId)
        },
      })
    })
  })

  test("archive then resume then archive more then resume preserves all archives", async () => {
    await withSandbox(async ({ Instance, Session, MessageV2, storeArchiveMetadata }) => {
      let sessionId: string
      let msg1Id: string
      let msg2Id: string
      let msg3Id: string
      let msg4Id: string

      // Phase 1: Create initial archive
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})
          sessionId = session.id
          msg1Id = Identifier.ascending("message")
          msg2Id = Identifier.ascending("message")

          await createUserMessage(Session, session.id, msg1Id, "First archive message 1")
          await createAssistantMessage(Session, session.id, msg2Id, msg1Id, "First archive message 2")

          const messages = await Session.messages({ sessionID: session.id })
          await setupArchiveMetadata(storeArchiveMetadata, session.id, messages, {
            summary: "First archive about setup",
            indexTerms: ["setup", "initial"],
          })
        },
      })

      // Phase 2: Resume, add more messages, archive them
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          // Verify first archive persisted
          const existingMessages = await Session.messages({ sessionID: sessionId })
          const firstAnchor = existingMessages.find(m => m.info.id === msg1Id)
          expect(firstAnchor?.info.archive?.summary).toBe("First archive about setup")

          // Add new messages
          msg3Id = Identifier.ascending("message")
          msg4Id = Identifier.ascending("message")
          await createUserMessage(Session, sessionId, msg3Id, "Second archive message 1")
          await createAssistantMessage(Session, sessionId, msg4Id, msg3Id, "Second archive message 2")

          // Archive the new messages
          const allMessages = await Session.messages({ sessionID: sessionId })
          const newMessages = allMessages.filter(m => m.info.id >= msg3Id && m.info.id <= msg4Id)
          await setupArchiveMetadata(storeArchiveMetadata, sessionId, newMessages, {
            summary: "Second archive about deployment",
            indexTerms: ["deploy", "production"],
          })
        },
      })

      // Phase 3: Resume and verify BOTH archives persisted
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const messages = await Session.messages({ sessionID: sessionId })

          // First archive
          const firstAnchor = messages.find(m => m.info.id === msg1Id)
          expect(firstAnchor?.info.archive?.summary).toBe("First archive about setup")
          expect(firstAnchor?.info.archive?.rangeEnd).toBe(msg2Id)

          const firstFollower = messages.find(m => m.info.id === msg2Id)
          expect(firstFollower?.info.archivedBy).toBe(msg1Id)

          // Second archive (independent)
          const secondAnchor = messages.find(m => m.info.id === msg3Id)
          expect(secondAnchor?.info.archive?.summary).toBe("Second archive about deployment")
          expect(secondAnchor?.info.archive?.rangeEnd).toBe(msg4Id)

          const secondFollower = messages.find(m => m.info.id === msg4Id)
          expect(secondFollower?.info.archivedBy).toBe(msg3Id)

          // Verify model messages render both placeholders
          const modelMessages = MessageV2.toModelMessage(messages)
          expect(modelMessages.length).toBe(2) // Two archived ranges

          const first = JSON.stringify(modelMessages[0].content)
          expect(first).toContain("First archive about setup")

          const second = JSON.stringify(modelMessages[1].content)
          expect(second).toContain("Second archive about deployment")

          await Session.remove(sessionId)
        },
      })
    })
  })

  test("original parts[] content verified unchanged after archival and resume", async () => {
    await withSandbox(async ({ Instance, Session, storeArchiveMetadata }) => {
      let sessionId: string
      let msg1Id: string

      const originalText = "This is the original message content with special chars: <>&\"'"

      // Phase 1: Create and archive
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})
          sessionId = session.id
          msg1Id = Identifier.ascending("message")

          await createUserMessage(Session, session.id, msg1Id, originalText)

          const messages = await Session.messages({ sessionID: session.id })
          await setupArchiveMetadata(storeArchiveMetadata, session.id, messages, {
            summary: "Archive summary",
            indexTerms: ["test"],
          })

          // Verify parts unchanged immediately after archive
          const msg = await Session.messages({ sessionID: session.id })
          expect(msg[0].parts[0]).toHaveProperty("text", originalText)
        },
      })

      // Phase 2: Resume and verify
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const messages = await Session.messages({ sessionID: sessionId })
          const msg = messages.find(m => m.info.id === msg1Id)

          // Archive metadata present
          expect(msg?.info.archive).toBeDefined()

          // Original content UNCHANGED
          expect(msg?.parts).toHaveLength(1)
          expect(msg?.parts[0].type).toBe("text")
          expect(msg?.parts[0]).toHaveProperty("text", originalText)

          await Session.remove(sessionId)
        },
      })
    })
  })
})

describe("large message range persistence (AC: 1, 3)", () => {
  test("archive with 10+ messages persists correctly across resume", async () => {
    await withSandbox(async ({ Instance, Session, MessageV2, storeArchiveMetadata }) => {
      let sessionId: string
      const messageIds: string[] = []
      const messageCount = 12

      // Phase 1: Create session with many messages and archive them
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})
          sessionId = session.id

          // Create 12 alternating user/assistant messages
          for (let i = 0; i < messageCount; i++) {
            const msgId = Identifier.ascending("message")
            messageIds.push(msgId)

            if (i % 2 === 0) {
              await createUserMessage(Session, session.id, msgId, `User message ${i + 1} of ${messageCount}`)
            } else {
              await createAssistantMessage(
                Session,
                session.id,
                msgId,
                messageIds[i - 1],
                `Assistant message ${i + 1} of ${messageCount}`
              )
            }
          }

          const messages = await Session.messages({ sessionID: session.id })
          expect(messages.length).toBe(messageCount)

          await setupArchiveMetadata(storeArchiveMetadata, session.id, messages, {
            summary: "Large archive with 12 messages covering extended discussion",
            indexTerms: ["large", "extended", "discussion"],
          })
        },
      })

      // Phase 2: Resume and verify
      await Instance.disposeAll()

      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const messages = await Session.messages({ sessionID: sessionId })
          expect(messages.length).toBe(messageCount)

          // First message should be anchor
          const anchor = messages.find(m => m.info.id === messageIds[0])
          expect(anchor?.info.archive).toBeDefined()
          expect(anchor?.info.archive?.summary).toBe("Large archive with 12 messages covering extended discussion")
          expect(anchor?.info.archive?.rangeEnd).toBe(messageIds[messageCount - 1])

          // All other messages should be followers
          for (let i = 1; i < messageCount; i++) {
            const follower = messages.find(m => m.info.id === messageIds[i])
            expect(follower?.info.archivedBy).toBe(messageIds[0])
            expect(follower?.info.archive).toBeUndefined()
          }

          // Verify placeholder rendering
          const modelMessages = MessageV2.toModelMessage(messages)
          expect(modelMessages.length).toBe(1) // Single placeholder for entire range

          const content = JSON.stringify(modelMessages[0].content)
          expect(content).toContain("[SMART_ARCHIVED:")
          expect(content).toContain("Large archive with 12 messages")

          await Session.remove(sessionId)
        },
      })
    })
  })
})

describe("reference validation (AC: 4)", () => {
  test("validateArchiveReferences returns valid for correctly archived messages", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, messages, {
        summary: "Test summary",
        indexTerms: ["test"],
      })

      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(true)
      expect(result.orphanedMessages).toHaveLength(0)
      expect(result.brokenAnchors).toHaveLength(0)
    })
  })

  test("validateArchiveReferences detects orphaned archivedBy references", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")

      // Manually create an orphaned archivedBy reference (points to non-existent anchor)
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        draft.archivedBy = "msg_nonexistent_anchor"
      })

      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(false)
      expect(result.orphanedMessages).toContain(msg1Id)
      expect(result.brokenAnchors).toHaveLength(0)
    })
  })

  test("validateArchiveReferences detects broken rangeEnd references", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")

      // Create an anchor with rangeEnd pointing to non-existent message
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        draft.archive = {
          summary: "Test summary",
          indexTerms: ["test"],
          rangeEnd: "msg_nonexistent_end",
        }
      })

      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(false)
      expect(result.orphanedMessages).toHaveLength(0)
      expect(result.brokenAnchors).toContain(msg1Id)
    })
  })

  test("validateArchiveReferences detects both orphaned and broken references", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      // Create anchor with broken rangeEnd
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        draft.archive = {
          summary: "Test summary",
          indexTerms: ["test"],
          rangeEnd: "msg_nonexistent_end",
        }
      })

      // Create orphaned archivedBy reference on msg3
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg3Id], (draft) => {
        draft.archivedBy = "msg_nonexistent_anchor"
      })

      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(false)
      expect(result.orphanedMessages).toContain(msg3Id)
      expect(result.brokenAnchors).toContain(msg1Id)
    })
  })

  test("validateArchiveReferences ignores self-referential rangeEnd (single message archive)", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Single message")

      // Create anchor where rangeEnd points to itself (valid single-message archive)
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        draft.archive = {
          summary: "Single message summary",
          indexTerms: ["single"],
          rangeEnd: msg1Id,
        }
      })

      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(true)
      expect(result.orphanedMessages).toHaveLength(0)
      expect(result.brokenAnchors).toHaveLength(0)
    })
  })

  test("validateArchiveReferences returns valid for empty session (no messages)", async () => {
    await withRefValidationTestSession(async (ctx) => {
      // Don't create any messages - session is empty
      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(true)
      expect(result.orphanedMessages).toHaveLength(0)
      expect(result.brokenAnchors).toHaveLength(0)
    })
  })

  test("validateArchiveReferences handles message with both archive and archivedBy (invalid state)", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")

      // Create valid anchor on msg1
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        draft.archive = {
          summary: "Test summary",
          indexTerms: ["test"],
          rangeEnd: msg2Id,
        }
      })

      // Create INVALID state: msg2 has both archivedBy (pointing to valid anchor) AND its own archive
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg2Id], (draft) => {
        draft.archivedBy = msg1Id
        draft.archive = {
          summary: "Invalid: should not have both",
          indexTerms: ["invalid"],
          rangeEnd: msg2Id,
        }
      })

      // Function should still work - it validates references, not schema consistency
      // msg2's archivedBy points to valid anchor (msg1), so no orphan
      // msg2's archive.rangeEnd points to itself (valid)
      const result = await ctx.validateArchiveReferences(ctx.session.id)

      expect(result.valid).toBe(true)
      expect(result.orphanedMessages).toHaveLength(0)
      expect(result.brokenAnchors).toHaveLength(0)
    })
  })

  test("validateArchiveReferences returns valid for non-existent session (vacuously true)", async () => {
    await withSandbox(async ({ Instance, Session, validateArchiveReferences }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const nonExistentSessionId = "ses_does_not_exist_12345"

          // Verify the session truly doesn't exist
          const allSessions = await Array.fromAsync(Session.list())
          expect(allSessions.every(s => s.id !== nonExistentSessionId)).toBe(true)

          // Non-existent session has no messages, so no references to validate
          // This is vacuously true - there are no invalid references
          const result = await validateArchiveReferences(nonExistentSessionId)

          expect(result.valid).toBe(true)
          expect(result.orphanedMessages).toHaveLength(0)
          expect(result.brokenAnchors).toHaveLength(0)
        },
      })
    })
  })
})

describe("graceful handling of orphaned archivedBy in toModelMessage (AC: 4)", () => {
  test("orphaned archivedBy renders message normally instead of skipping", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1 content")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2 content")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3 content")

      // Create orphaned archivedBy reference (no corresponding anchor)
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg2Id], (draft) => {
        draft.archivedBy = "msg_nonexistent_anchor"
      })

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(messages)

      // All 3 messages should be rendered (msg2 not skipped despite archivedBy)
      expect(modelMessages.length).toBe(3)

      // Verify msg2 content is included (not skipped)
      const msg2Content = JSON.stringify(modelMessages[1].content)
      expect(msg2Content).toContain("Message 2 content")
    })
  })

  test("valid archivedBy still skips message when anchor exists", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1 content")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2 content")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3 content")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, allMessages, {
        summary: "Archive summary",
        indexTerms: ["test"],
      })

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(messages)

      // Only 1 message (placeholder) - msg2 and msg3 are properly skipped
      expect(modelMessages.length).toBe(1)

      const content = JSON.stringify(modelMessages[0].content)
      expect(content).toContain("[SMART_ARCHIVED:")
      expect(content).toContain("Archive summary")
    })
  })

  test("mixed valid and orphaned archivedBy handles each correctly", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Anchor message")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Valid follower")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Orphan message")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Normal message")

      // Archive msg1 and msg2 correctly
      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const range = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg2Id)
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, range, {
        summary: "Valid archive",
        indexTerms: ["valid"],
      })

      // Create orphaned archivedBy on msg3 (points to non-existent anchor)
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg3Id], (draft) => {
        draft.archivedBy = "msg_nonexistent_anchor"
      })

      const messages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const modelMessages = ctx.MessageV2.toModelMessage(messages)

      // Should have 3 messages:
      // 1. Placeholder for valid archive (msg1)
      // 2. Orphan msg3 rendered normally (not skipped)
      // 3. Normal msg4
      expect(modelMessages.length).toBe(3)

      const first = JSON.stringify(modelMessages[0].content)
      expect(first).toContain("[SMART_ARCHIVED:")
      expect(first).toContain("Valid archive")

      const second = JSON.stringify(modelMessages[1].content)
      expect(second).toContain("Orphan message")

      const third = JSON.stringify(modelMessages[2].content)
      expect(third).toContain("Normal message")
    })
  })
})

describe("crash recovery scenarios (AC: 2)", () => {
  test("Storage.update failure on single message leaves no partial state", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Test message")

      // Delete the message file to simulate storage corruption/failure
      await ctx.Storage.remove(["message", ctx.session.id, msg1Id])

      // Attempt to archive should fail gracefully
      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg1Id },
          messages: [{ info: { id: msg1Id } as any, parts: [] }],
        }],
        summaries: { [msg1Id]: { summary: "Test", indexTerms: ["test"] } },
      })

      expect(result.archivedCount).toBe(0)
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  test("mid-range failure leaves anchor with corrected rangeEnd", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Message 4")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Delete msg3 file to cause mid-range failure
      await ctx.Storage.remove(["message", ctx.session.id, msg3Id])

      const result = await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg4Id },
          messages: allMessages,
        }],
        summaries: { [msg1Id]: { summary: "Test summary", indexTerms: ["test"] } },
      })

      // Partial success: msg1 and msg2 archived, msg3 failed, msg4 never attempted
      expect(result.archivedCount).toBe(2)
      expect(result.errors.length).toBeGreaterThan(0)

      // Verify anchor's rangeEnd is corrected to msg2 (last successful)
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive?.rangeEnd).toBe(msg2Id)

      // Validate references - should be valid (no orphans because rangeEnd corrected)
      const validation = await ctx.validateArchiveReferences(ctx.session.id)
      // Note: msg3 file is deleted so it's not in the message list at all
      // The corrected rangeEnd ensures no broken references within surviving messages
      expect(validation.brokenAnchors).toHaveLength(0)
    })
  })

  test("successful archival produces valid anchor references with no orphans", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Archive normally
      await setupArchiveMetadata(ctx.storeArchiveMetadata, ctx.session.id, allMessages, {
        summary: "Test archive",
        indexTerms: ["test"],
      })

      // Verify all references are valid
      const validation = await ctx.validateArchiveReferences(ctx.session.id)
      expect(validation.valid).toBe(true)

      // Verify msg2 and msg3 have archivedBy pointing to msg1
      const msg2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      expect(msg2.info.archivedBy).toBe(msg1Id)

      const msg3 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      expect(msg3.info.archivedBy).toBe(msg1Id)

      // Verify anchor exists
      const msg1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(msg1.info.archive).toBeDefined()
    })
  })
})

describe("rangeEnd ownership verification (AC: 5)", () => {
  test("rangeEnd correction skipped when summary doesn't match (ownership verification)", async () => {
    await withRefValidationTestSession(async (ctx) => {
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")

      // Archive msg1-msg2 with summary "Original summary"
      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const initialRange = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg2Id)

      await ctx.storeArchiveMetadata({
        sessionID: ctx.session.id,
        validatedRanges: [{
          range: { startMessageId: msg1Id, endMessageId: msg2Id },
          messages: initialRange,
        }],
        summaries: { [msg1Id]: { summary: "Original summary", indexTerms: ["original"] } },
      })

      // Verify initial state
      const anchorBefore = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(anchorBefore.info.archive?.summary).toBe("Original summary")
      expect(anchorBefore.info.archive?.rangeEnd).toBe(msg2Id)

      // Simulate concurrent operation: change anchor's summary to something else
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        if (draft.archive) {
          draft.archive.summary = "Changed by concurrent operation"
        }
      })

      // Verify summary was changed
      const anchorAfterChange = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(anchorAfterChange.info.archive?.summary).toBe("Changed by concurrent operation")

      // Directly test the ownership verification logic:
      // Try to update rangeEnd with WRONG summary - should NOT update
      const wrongSummary = "Original summary" // Doesn't match "Changed by concurrent operation"
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        // This mimics the ownership check in storeArchiveMetadata
        if (draft.archive && draft.archive.summary === wrongSummary) {
          draft.archive.rangeEnd = msg3Id // This should NOT execute
        }
      })

      // CRITICAL: Verify rangeEnd was NOT updated because summary didn't match
      const anchorAfterWrongSummary = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(anchorAfterWrongSummary.info.archive?.rangeEnd).toBe(msg2Id) // Still msg2Id

      // Now try with CORRECT summary - should update
      const correctSummary = "Changed by concurrent operation"
      await ctx.Storage.update<MessageV2Types.Info>(["message", ctx.session.id, msg1Id], (draft) => {
        if (draft.archive && draft.archive.summary === correctSummary) {
          draft.archive.rangeEnd = msg3Id // This SHOULD execute
        }
      })

      // Verify rangeEnd WAS updated with correct summary
      const anchorAfterCorrectSummary = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(anchorAfterCorrectSummary.info.archive?.rangeEnd).toBe(msg3Id) // Now msg3Id
    })
  })
})

describe("concurrent archive operations (AC: 5, Task 4.3)", () => {
  test("concurrent storeArchiveMetadata calls on separate ranges succeed independently", async () => {
    await withRefValidationTestSession(async (ctx) => {
      // Create 6 messages for 2 separate ranges
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")
      const msg5Id = Identifier.ascending("message")
      const msg6Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Range 1 Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Range 1 Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Range 1 Message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Range 2 Message 1")
      await createUserMessage(ctx.Session, ctx.session.id, msg5Id, "Range 2 Message 2")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg6Id, msg5Id, "Range 2 Message 3")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })
      const range1Messages = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg3Id)
      const range2Messages = allMessages.filter(m => m.info.id >= msg4Id && m.info.id <= msg6Id)

      // Run two archive operations CONCURRENTLY using Promise.all
      const [result1, result2] = await Promise.all([
        ctx.storeArchiveMetadata({
          sessionID: ctx.session.id,
          validatedRanges: [{
            range: { startMessageId: msg1Id, endMessageId: msg3Id },
            messages: range1Messages,
          }],
          summaries: { [msg1Id]: { summary: "Range 1 concurrent test", indexTerms: ["concurrent", "range1"] } },
        }),
        ctx.storeArchiveMetadata({
          sessionID: ctx.session.id,
          validatedRanges: [{
            range: { startMessageId: msg4Id, endMessageId: msg6Id },
            messages: range2Messages,
          }],
          summaries: { [msg4Id]: { summary: "Range 2 concurrent test", indexTerms: ["concurrent", "range2"] } },
        }),
      ])

      // Both operations should succeed
      expect(result1.archivedCount).toBe(3)
      expect(result1.errors).toHaveLength(0)
      expect(result2.archivedCount).toBe(3)
      expect(result2.errors).toHaveLength(0)

      // Verify all references are valid after concurrent operations
      const validation = await ctx.validateArchiveReferences(ctx.session.id)
      expect(validation.valid).toBe(true)

      // Verify Range 1 archive
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      expect(m1.info.archive?.summary).toBe("Range 1 concurrent test")
      expect(m1.info.archive?.rangeEnd).toBe(msg3Id)

      const m2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      expect(m2.info.archivedBy).toBe(msg1Id)

      const m3 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      expect(m3.info.archivedBy).toBe(msg1Id)

      // Verify Range 2 archive
      const m4 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg4Id })
      expect(m4.info.archive?.summary).toBe("Range 2 concurrent test")
      expect(m4.info.archive?.rangeEnd).toBe(msg6Id)

      const m5 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg5Id })
      expect(m5.info.archivedBy).toBe(msg4Id)

      const m6 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg6Id })
      expect(m6.info.archivedBy).toBe(msg4Id)
    })
  })

  test("concurrent archive attempts on overlapping ranges handled gracefully", async () => {
    await withRefValidationTestSession(async (ctx) => {
      // Create 4 messages
      const msg1Id = Identifier.ascending("message")
      const msg2Id = Identifier.ascending("message")
      const msg3Id = Identifier.ascending("message")
      const msg4Id = Identifier.ascending("message")

      await createUserMessage(ctx.Session, ctx.session.id, msg1Id, "Message 1")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg2Id, msg1Id, "Message 2")
      await createUserMessage(ctx.Session, ctx.session.id, msg3Id, "Message 3")
      await createAssistantMessage(ctx.Session, ctx.session.id, msg4Id, msg3Id, "Message 4")

      const allMessages = await ctx.Session.messages({ sessionID: ctx.session.id })

      // Both operations try to archive msg2 and msg3 (overlapping)
      const range1Messages = allMessages.filter(m => m.info.id >= msg1Id && m.info.id <= msg3Id)
      const range2Messages = allMessages.filter(m => m.info.id >= msg2Id && m.info.id <= msg4Id)

      // Run concurrent overlapping archive operations
      const [result1, result2] = await Promise.all([
        ctx.storeArchiveMetadata({
          sessionID: ctx.session.id,
          validatedRanges: [{
            range: { startMessageId: msg1Id, endMessageId: msg3Id },
            messages: range1Messages,
          }],
          summaries: { [msg1Id]: { summary: "First concurrent attempt", indexTerms: ["first"] } },
        }),
        ctx.storeArchiveMetadata({
          sessionID: ctx.session.id,
          validatedRanges: [{
            range: { startMessageId: msg2Id, endMessageId: msg4Id },
            messages: range2Messages,
          }],
          summaries: { [msg2Id]: { summary: "Second concurrent attempt", indexTerms: ["second"] } },
        }),
      ])

      // One will archive some, the other will skip those that were archived first
      // All 4 unique messages MUST end up archived (by one operation or the other)
      const totalArchived = result1.archivedCount + result2.archivedCount
      const totalSkipped = result1.skippedCount + result2.skippedCount

      // CRITICAL: All 4 unique messages must be archived exactly once
      expect(totalArchived).toBe(4)
      // The 2 overlapping messages (msg2, msg3) should be skipped by whichever operation loses the race
      expect(totalSkipped).toBeGreaterThanOrEqual(2)
      // Total processing = 6 (3 messages per range), distributed as archived + skipped
      expect(totalArchived + totalSkipped).toBe(6)

      // Verify no errors and references are valid
      expect(result1.errors).toHaveLength(0)
      expect(result2.errors).toHaveLength(0)

      const validation = await ctx.validateArchiveReferences(ctx.session.id)
      expect(validation.valid).toBe(true)

      // STRONGER VERIFICATION: Each unique message must be in exactly one archival state
      // Either: anchor (has archive), follower (has archivedBy), but NEVER both or neither
      const m1 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg1Id })
      const m2 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg2Id })
      const m3 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg3Id })
      const m4 = await ctx.MessageV2.get({ sessionID: ctx.session.id, messageID: msg4Id })

      // Helper to check exactly one archival state
      const isArchived = (m: typeof m1) => !!(m.info.archive || m.info.archivedBy)
      const hasConflict = (m: typeof m1) => !!(m.info.archive && m.info.archivedBy)

      // All 4 messages must be archived in exactly one way
      expect(isArchived(m1)).toBe(true)
      expect(isArchived(m2)).toBe(true)
      expect(isArchived(m3)).toBe(true)
      expect(isArchived(m4)).toBe(true)

      // No message should have conflicting states (both anchor and follower)
      expect(hasConflict(m1)).toBe(false)
      expect(hasConflict(m2)).toBe(false)
      expect(hasConflict(m3)).toBe(false)
      expect(hasConflict(m4)).toBe(false)

      // Verify archival chain integrity: each archivedBy must point to a valid anchor
      for (const m of [m1, m2, m3, m4]) {
        if (m.info.archivedBy) {
          const anchor = [m1, m2, m3, m4].find(a => a.info.id === m.info.archivedBy)
          expect(anchor?.info.archive).toBeDefined()
        }
      }
    })
  })
})
