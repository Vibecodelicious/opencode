import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// v1.15.7 exercised metadata persistence against the old message-v2 monolith via
// `Session.defaultLayer`, which no longer exists. Express the same round-trip
// against v1.17.13's event-sourced Session + SessionProjector node graph: an
// updateMessage publish flows through the projector into MessageTable and back
// out through Session.messages, carrying the optional metadata field.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

function user(sessionID: SessionID, metadata?: Record<string, unknown>): SessionV1.User {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "default",
    model: {
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("test"),
    },
    time: {
      created: Date.now(),
    },
    ...(metadata ? { metadata } : {}),
  } as unknown as SessionV1.User
}

function assistant(
  sessionID: SessionID,
  parentID: SessionV1.MessageID,
  metadata?: Record<string, unknown>,
): SessionV1.Assistant {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID,
    providerID: ProviderV2.ID.make("test"),
    modelID: ModelV2.ID.make("test"),
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
  } as unknown as SessionV1.Assistant
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
        const match = messages.find(
          (item) => (item.info.metadata as any)?.context_bonsai?.archived?.anchor_id === anchor,
        )

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
