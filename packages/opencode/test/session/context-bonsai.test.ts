import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"

Log.init({ print: false })

function user(input: { sessionID: string; metadata?: Record<string, any> }): MessageV2.User {
  return {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    role: "user",
    agent: "default",
    model: {
      providerID: "test",
      modelID: "test",
    },
    time: {
      created: Date.now(),
    },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

function assistant(input: {
  sessionID: string
  parentID: string
  metadata?: Record<string, any>
}): MessageV2.Assistant {
  return {
    id: Identifier.ascending("message"),
    sessionID: input.sessionID,
    role: "assistant",
    parentID: input.parentID,
    providerID: "test",
    modelID: "test",
    mode: "default",
    agent: "default",
    path: {
      cwd: "/",
      root: "/",
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created: Date.now(),
    },
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

describe("session context bonsai metadata", () => {
  test("Session.updateMessage preserves message metadata through storage reads", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const anchor = "anchor-storage-roundtrip"
        const archived = {
          context_bonsai: {
            archived: {
              anchor_id: anchor,
            },
          },
        }
        const restored = {
          context_bonsai: {
            restored: {
              anchor_id: anchor,
            },
          },
        }

        const userMsg = await Session.updateMessage(user({ sessionID: session.id, metadata: archived }))
        const assistantMsg = await Session.updateMessage(
          assistant({ sessionID: session.id, parentID: userMsg.id, metadata: restored }),
        )

        const loadedUser = await MessageV2.get({ sessionID: session.id, messageID: userMsg.id })
        const loadedAssistant = await MessageV2.get({ sessionID: session.id, messageID: assistantMsg.id })

        expect(loadedUser.info).toMatchObject({ metadata: archived })
        expect(loadedAssistant.info).toMatchObject({ metadata: restored })
      },
    })
  })

  test("Session.messages exposes archived anchor metadata for later-turn scans", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const anchor = "anchor-visible-to-retrieve"
        const userMsg = await Session.updateMessage(
          user({
            sessionID: session.id,
            metadata: {
              context_bonsai: {
                archived: {
                  anchor_id: anchor,
                  range: ["from", "to"],
                },
              },
            },
          }),
        )
        await Session.updateMessage(
          assistant({
            sessionID: session.id,
            parentID: userMsg.id,
            metadata: {
              context_bonsai: {
                restore_target: {
                  anchor_id: anchor,
                },
              },
            },
          }),
        )

        const messages = await Session.messages({ sessionID: session.id })
        const match = messages.find((item) => {
          return item.info.metadata?.context_bonsai?.archived?.anchor_id === anchor
        })

        expect(match?.info.id).toBe(userMsg.id)
        expect(messages.map((item) => item.info.metadata)).toContainEqual({
          context_bonsai: {
            archived: {
              anchor_id: anchor,
              range: ["from", "to"],
            },
          },
        })
      },
    })
  })
})
