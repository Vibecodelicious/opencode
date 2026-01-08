import { describe, expect, test, spyOn } from "bun:test"
import type { ModelsDev } from "../../src/provider/models"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"

const baseSession = {
  id: "session-1",
  created: Date.now(),
}

function createUserMessage(text: string): MessageV2.WithParts {
  return {
    info: {
      id: "msg-user",
      sessionID: baseSession.id,
      role: "user",
      time: {
        created: baseSession.created,
      },
      agent: "build",
      model: {
        providerID: "opencode",
        modelID: "test-model",
      },
    },
    parts: [
      {
        id: "part-user-text",
        sessionID: baseSession.id,
        messageID: "msg-user",
        type: "text",
        text,
      },
    ],
  }
}

function createAssistantMessage(parts: MessageV2.Part[], tokens: MessageV2.Assistant["tokens"]) {
  return {
    info: {
      id: "msg-assistant",
      sessionID: baseSession.id,
      role: "assistant",
      parentID: "msg-user",
      modelID: "test-model",
      providerID: "opencode",
      mode: "build",
      path: { cwd: "/tmp", root: "/" },
      time: {
        created: baseSession.created,
        completed: baseSession.created + 1,
      },
      cost: 0,
      tokens,
    },
    parts,
  } satisfies MessageV2.WithParts
}

describe("Context gauge thresholds", () => {
  test("ramping intervals move forward with utilization", () => {
    // First threshold is at 12% (interval 0.12), then 24%, then 30%+ follows upper bounds
    expect(SessionCompaction.getNextCheckpointPercent(0)).toBeCloseTo(0.12)
    expect(SessionCompaction.getNextCheckpointPercent(0.12)).toBeCloseTo(0.24)
    expect(SessionCompaction.getNextCheckpointPercent(0.24)).toBeCloseTo(0.36) // 0.24 < 0.3, so +0.12
    expect(SessionCompaction.getNextCheckpointPercent(0.3)).toBeCloseTo(0.45) // 0.3 < 0.6, so +0.15
    expect(SessionCompaction.getNextCheckpointPercent(0.6)).toBeCloseTo(0.7)
    expect(SessionCompaction.getNextCheckpointPercent(0.8)).toBeCloseTo(0.85)
    expect(SessionCompaction.getNextCheckpointPercent(0.95)).toBe(1)
  })

  test("new gauge only fires on threshold crossing", () => {
    // First threshold is at 12%
    expect(SessionCompaction.shouldTriggerContextGauge(0.11, 0)).toBe(false)
    expect(SessionCompaction.shouldTriggerContextGauge(0.12, 0)).toBe(true)
    expect(SessionCompaction.shouldTriggerContextGauge(0.14, 0)).toBe(true) // Above 12%, should trigger
    expect(SessionCompaction.shouldTriggerContextGauge(0.5, 0.45)).toBe(false)
    expect(SessionCompaction.shouldTriggerContextGauge(0.6, 0.45)).toBe(true)
    expect(SessionCompaction.shouldTriggerContextGauge(0.5, 0.6)).toBe(false)
  })
})

describe("Gauge metadata helpers", () => {
  test("highest checkpoint percent reads the largest recorded gauge", () => {
    const gaugeLow = {
      id: "gauge-low",
      sessionID: baseSession.id,
      messageID: "msg-assistant",
      type: "context-gauge" as const,
      tokenCount: 20000,
      contextLimit: 100000,
      percentage: 25,
    }
    const gaugeHigh = {
      id: "gauge-high",
      sessionID: baseSession.id,
      messageID: "msg-assistant",
      type: "context-gauge" as const,
      tokenCount: 45000,
      contextLimit: 100000,
      percentage: 45,
    }
    const messages = [
      createAssistantMessage([gaugeLow], {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
      createAssistantMessage([gaugeHigh], {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ]
    const before = JSON.stringify(messages)
    expect(SessionCompaction.getHighestGaugePercent(messages)).toBe(0.45)
    expect(JSON.stringify(messages)).toBe(before)
  })

  test("context gauge part rounds percentage and caps at 100", () => {
    const part = SessionCompaction.createContextGaugePart({
      sessionID: baseSession.id,
      messageID: "msg-assistant",
      tokenCount: 999,
      contextLimit: 1000,
      percent: 0.999,
    })
    expect(part.percentage).toBe(100)
    expect(part.tokenCount).toBe(999)
    expect(part.contextLimit).toBe(1000)
  })
})

describe("injectContextGauge", () => {
  const model = {
    limit: { context: 1000, output: 0 },
  } as unknown as ModelsDev.Model

  test("triggers when current usage crosses threshold using per-turn tokens only", async () => {
    const calls: MessageV2.Part[] = []
    const spy = spyOn(Session, "updatePart")
    spy.mockImplementation(((input: MessageV2.Part | { part: MessageV2.TextPart | MessageV2.ReasoningPart; delta: string }) => {
      const part = "delta" in input ? input.part : input
      calls.push(part)
      return Promise.resolve(part)
    }) as typeof Session.updatePart)

    // Use 120 tokens out of 1000 = 12%, which should trigger first threshold
    const assistantMessage = createAssistantMessage([], {
      input: 120,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })

    const inserted = await SessionCompaction.injectContextGauge({
      sessionID: baseSession.id,
      message: assistantMessage.info as MessageV2.Assistant,
      model,
      messages: [],
    })

    expect(inserted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe("context-gauge")
    expect((calls[0] as MessageV2.ContextGaugePart).tokenCount).toBe(120) // uses provider-reported input tokens for this turn
    expect((calls[0] as MessageV2.ContextGaugePart).percentage).toBe(12)

    spy.mockRestore()
  })

  test("does not double count prior assistant usage", async () => {
    const calls: MessageV2.Part[] = []
    const spy = spyOn(Session, "updatePart")
    spy.mockImplementation(((input: MessageV2.Part | { part: MessageV2.TextPart | MessageV2.ReasoningPart; delta: string }) => {
      const part = "delta" in input ? input.part : input
      calls.push(part)
      return Promise.resolve(part)
    }) as typeof Session.updatePart)

    const history = [
      createAssistantMessage([], {
        input: 400,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ]

    const assistantMessage = createAssistantMessage([], {
      input: 100,
      output: 50,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })

    const inserted = await SessionCompaction.injectContextGauge({
      sessionID: baseSession.id,
      message: assistantMessage.info as MessageV2.Assistant,
      model,
      messages: history,
    })

    expect(inserted).toBe(false)
    expect(calls).toHaveLength(0)

    spy.mockRestore()
  })
})
