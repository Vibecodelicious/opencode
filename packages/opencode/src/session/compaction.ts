import { streamText, wrapLanguageModel, type ModelMessage } from "ai"
import { Session } from "."
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import { toModelMessageWithIDs } from "./archive-context"
import { SystemPrompt } from "./system"
import { Bus } from "../bus"
import z from "zod"
import type { ModelsDev } from "../provider/models"
import { SessionPrompt } from "./prompt"
import { Flag } from "../flag/flag"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { ProviderTransform } from "@/provider/transform"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { mergeDeep, pipe } from "remeda"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: Bus.event(
      "session.compacted",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  export function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: ModelsDev.Model }) {
    if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) return false
    const context = input.model.limit.context
    if (context === 0) return false
    const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
    const output = Math.min(input.model.limit.output, SessionPrompt.OUTPUT_TOKEN_MAX) || SessionPrompt.OUTPUT_TOKEN_MAX
    const usable = context - output
    return count > usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: string }) {
    if (Flag.OPENCODE_DISABLE_PRUNE) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  const DEFAULT_CONTEXT_LIMIT = 128_000
  const CONTEXT_GAUGE_THRESHOLDS = [
    { upper: 0.3, interval: 0.12 },
    { upper: 0.6, interval: 0.15 },
    { upper: 0.8, interval: 0.1 },
    { upper: 1.0, interval: 0.05 },
  ] as const

  export function getIntervalForPercent(percent: number) {
    for (const threshold of CONTEXT_GAUGE_THRESHOLDS) {
      if (percent < threshold.upper) {
        return threshold.interval
      }
    }
    return CONTEXT_GAUGE_THRESHOLDS[CONTEXT_GAUGE_THRESHOLDS.length - 1].interval
  }

  export function getNextCheckpointPercent(lastCheckpointPercent: number) {
    if (lastCheckpointPercent >= 1) return 1
    const interval = getIntervalForPercent(lastCheckpointPercent)
    return Math.min(1, lastCheckpointPercent + interval)
  }

  export function shouldTriggerContextGauge(currentPercent: number, lastCheckpointPercent: number) {
    if (lastCheckpointPercent >= 1) return false
    const nextCheckpoint = getNextCheckpointPercent(lastCheckpointPercent)
    return currentPercent >= nextCheckpoint
  }

  export function getHighestGaugePercent(messages: MessageV2.WithParts[]) {
    let highest = 0
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "context-gauge") {
          const decimal = Math.max(0, Math.min(1, part.percentage / 100))
          highest = Math.max(highest, decimal)
        }
      }
    }
    return highest
  }

  export function createContextGaugePart(input: {
    sessionID: string
    messageID: string
    tokenCount: number
    contextLimit: number
    percent: number
  }) {
    const contextLimit = input.contextLimit > 0 ? input.contextLimit : DEFAULT_CONTEXT_LIMIT
    const tokenCount = Math.max(0, Math.min(input.tokenCount, contextLimit))
    const percentage = Math.max(0, Math.min(100, Math.round(input.percent * 100)))
    return {
      id: Identifier.ascending("part"),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "context-gauge" as const,
      tokenCount,
      contextLimit,
      percentage,
    }
  }

  export async function injectContextGauge(input: {
    sessionID: string
    message: MessageV2.Assistant
    model: ModelsDev.Model
    messages: MessageV2.WithParts[]
  }) {
    // Don't inject gauge on first assistant turn - need at least one prior exchange
    const priorAssistantMessages = input.messages.filter(
      (m) => m.info.role === "assistant" && m.info.id !== input.message.id,
    )
    if (priorAssistantMessages.length === 0) return false

    const contextLimit = input.model.limit.context || DEFAULT_CONTEXT_LIMIT
    if (contextLimit <= 0) return false

    const tokens = input.message.tokens
    // Sum all token fields to match TUI display (sidebar.tsx, header.tsx, desktop/session.tsx)
    const tokenCount = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

    const currentPercent = Math.min(1, tokenCount / contextLimit)
    const lastCheckpoint = getHighestGaugePercent(input.messages)

    log.debug("gauge check", {
      tokenCount,
      contextLimit,
      currentPercent: Math.round(currentPercent * 100),
      lastCheckpoint: Math.round(lastCheckpoint * 100),
      shouldTrigger: shouldTriggerContextGauge(currentPercent, lastCheckpoint),
    })

    if (!shouldTriggerContextGauge(currentPercent, lastCheckpoint)) return false
    const part = createContextGaugePart({
      sessionID: input.sessionID,
      messageID: input.message.id,
      tokenCount: Math.min(tokenCount, contextLimit),
      contextLimit,
      percent: currentPercent,
    })
    await Session.updatePart(part)
    return true
  }

  export async function process(input: {
    parentID: string
    messages: MessageV2.WithParts[]
    sessionID: string
    model: {
      providerID: string
      modelID: string
    }
    agent: string
    abort: AbortSignal
    auto: boolean
    mode?: "ask" | "notify" | "silent"
  }) {
    log.info("compaction start", { sessionID: input.sessionID, auto: input.auto, mode: input.mode })
    const model = await Provider.getModel(input.model.providerID, input.model.modelID)
    const system = [...SystemPrompt.compaction(model.providerID)]
    const msg = (await Session.updateMessage({
      id: Identifier.ascending("message"),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: input.agent,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: input.model.modelID,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      providerID: input.model.providerID,
      model: model.info,
      abort: input.abort,
    })
    const result = await processor.process(() =>
      streamText({
        onError(error) {
          log.error("stream error", {
            error,
          })
        },
        // set to 0, we handle loop
        maxRetries: 0,
        providerOptions: ProviderTransform.providerOptions(
          model.npm,
          model.providerID,
          pipe(
            {},
            mergeDeep(ProviderTransform.options(model.providerID, model.modelID, model.npm ?? "", input.sessionID)),
            mergeDeep(model.info.options),
          ),
        ),
        headers: model.info.headers,
        abortSignal: input.abort,
        tools: model.info.tool_call ? {} : undefined,
        messages: [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          // Filter out step-start and step-finish parts to avoid breaking Anthropic's
          // API validation. These metadata parts can appear after tool_use blocks,
          // which Anthropic rejects (tool_use must be followed by tool_result).
          ...toModelMessageWithIDs(
            input.messages
              .filter((m) => {
                if (m.info.role !== "assistant" || m.info.error === undefined) {
                  return true
                }
                if (
                  MessageV2.AbortedError.isInstance(m.info.error) &&
                  m.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
                ) {
                  return true
                }

                return false
              })
              .map((msg) => ({
                ...msg,
                parts: msg.parts.filter((p) => p.type !== "step-start" && p.type !== "step-finish"),
              })),
          ),
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Summarize our conversation above. This summary will be the only context available when the conversation continues, so preserve critical information including: what was accomplished, current work in progress, files involved, next steps, and any key user requests or constraints. Be concise but detailed enough that work can continue seamlessly.",
              },
            ],
          },
        ],
        model: wrapLanguageModel({
          model: model.language,
          middleware: [
            {
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, model.providerID, model.modelID)
                }
                return args.params
              },
            },
          ],
        }),
      }),
    )
    if (result === "continue" && input.auto) {
      const continueMsg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        sessionID: input.sessionID,
        time: {
          created: Date.now(),
        },
        agent: input.agent,
        model: input.model,
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: continueMsg.id,
        sessionID: input.sessionID,
        type: "text",
        synthetic: true,
        text: "Continue if you have next steps",
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      agent: z.string(),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
      auto: z.boolean(),
      mode: z.enum(["ask", "notify", "silent"]).optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: Identifier.ascending("message"),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        mode: input.mode,
      })
    },
  )
}