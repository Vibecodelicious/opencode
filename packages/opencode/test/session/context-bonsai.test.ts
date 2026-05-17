import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))

function user(sessionID: SessionID, metadata?: Record<string, unknown>): MessageV2.User {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "default",
    model: {
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    },
    time: {
      created: Date.now(),
    },
    ...(metadata ? { metadata } : {}),
  }
}

function assistant(sessionID: SessionID, parentID: MessageID, metadata?: Record<string, unknown>): MessageV2.Assistant {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID,
    providerID: ProviderID.make("test"),
    modelID: ModelID.make("test"),
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
    ...(metadata ? { metadata } : {}),
  }
}

describe("session context bonsai metadata", () => {
  it.live("Session.updateMessage preserves message metadata through storage reads", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
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

        const userMsg = yield* sessions.updateMessage(user(session.id, archived))
        const assistantMsg = yield* sessions.updateMessage(assistant(session.id, userMsg.id, restored))
        const messages = yield* sessions.messages({ sessionID: session.id })

        expect(messages.find((item) => item.info.id === userMsg.id)?.info).toMatchObject({ metadata: archived })
        expect(messages.find((item) => item.info.id === assistantMsg.id)?.info).toMatchObject({ metadata: restored })
      }),
    ),
  )

  it.live("Session.messages exposes archived anchor metadata for later-turn scans", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const anchor = "anchor-visible-to-retrieve"
        const userMsg = yield* sessions.updateMessage(
          user(session.id, {
            context_bonsai: {
              archived: {
                anchor_id: anchor,
                range: ["from", "to"],
              },
            },
          }),
        )
        yield* sessions.updateMessage(
          assistant(session.id, userMsg.id, {
            context_bonsai: {
              restore_target: {
                anchor_id: anchor,
              },
            },
          }),
        )

        const messages = yield* sessions.messages({ sessionID: session.id })
        const match = messages.find((item) => item.info.metadata?.context_bonsai?.archived?.anchor_id === anchor)

        expect(match?.info.id).toBe(userMsg.id)
        expect(messages.map((item) => item.info.metadata)).toContainEqual({
          context_bonsai: {
            archived: {
              anchor_id: anchor,
              range: ["from", "to"],
            },
          },
        })
      }),
    ),
  )
})
