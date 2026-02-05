import { describe, expect, test, spyOn } from "bun:test"
import type { ModelsDev } from "../../src/provider/models"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { Identifier } from "../../src/id/id"

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

// Helper to create an assistant message with a context gauge at the given percentage
function createAssistantWithGauge(percent: number): MessageV2.WithParts {
  const msgId = Identifier.ascending("message")
  return {
    info: {
      id: msgId,
      role: "assistant",
      sessionID: "test-session",
      mode: "test",
      modelID: "test-model",
      providerID: "test-provider",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
      path: { cwd: "/test", root: "/test" },
    },
    parts: [
      {
        id: Identifier.ascending("part"),
        type: "context-gauge",
        percentage: percent,
        tokenCount: Math.round(percent * 1000),
        contextLimit: 100000,
        sessionID: "test-session",
        messageID: msgId,
      },
    ],
  }
}

// Helper to create a compaction summary message with a gauge (for post-compaction reset)
function createSummaryWithGauge(percent: number): MessageV2.WithParts {
  const msgId = Identifier.ascending("message")
  return {
    info: {
      id: msgId,
      role: "assistant",
      summary: true, // This marks it as a compaction summary
      sessionID: "test-session",
      mode: "test",
      modelID: "test-model",
      providerID: "test-provider",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
      path: { cwd: "/test", root: "/test" },
    },
    parts: [
      {
        id: Identifier.ascending("part"),
        type: "context-gauge",
        percentage: percent,
        tokenCount: Math.round(percent * 1000),
        contextLimit: 100000,
        sessionID: "test-session",
        messageID: msgId,
      },
    ],
  }
}

describe("Gauge metadata helpers", () => {
  test("returns last gauge percent from messages", () => {
    const messages = [
      createAssistantWithGauge(20),
      createAssistantWithGauge(45),
      createAssistantWithGauge(30), // Last but not highest
    ]
    // Now returns 0.30 (last), not 0.45 (highest)
    expect(SessionCompaction.getLastGaugePercent(messages)).toBe(0.3)
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

describe("getLastGaugePercent", () => {
  test("returns last gauge, not highest", () => {
    const messages = [
      createAssistantWithGauge(60), // Old high
      createAssistantWithGauge(15), // Post-compaction (most recent)
    ]
    expect(SessionCompaction.getLastGaugePercent(messages)).toBe(0.15)
  })

  test("returns highest during normal growth (last == highest)", () => {
    const messages = [
      createAssistantWithGauge(20),
      createAssistantWithGauge(35),
      createAssistantWithGauge(50),
    ]
    // During normal growth, last == highest
    expect(SessionCompaction.getLastGaugePercent(messages)).toBe(0.5)
  })

  test("returns 0 when no gauges exist", () => {
    const messages = [
      createAssistantMessage([], {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      }),
    ]
    expect(SessionCompaction.getLastGaugePercent(messages)).toBe(0)
  })
})

describe("gauge tracking after compaction (integration)", () => {
  test("post-compaction 0% gauge resets baseline", () => {
    // Full integration scenario:
    // 1. Session grows, gauge at 60%
    // 2. Compaction happens, gauge injected at 0%
    // 3. getLastGaugePercent should return 0, not 60
    const messages = [
      createAssistantWithGauge(60), // Pre-compaction high
      createSummaryWithGauge(0), // Post-compaction reset
    ]

    const lastCheckpoint = SessionCompaction.getLastGaugePercent(messages)
    expect(lastCheckpoint).toBe(0)

    // Next threshold after 0% is 12%
    expect(SessionCompaction.shouldTriggerContextGauge(0.1, lastCheckpoint)).toBe(false)
    expect(SessionCompaction.shouldTriggerContextGauge(0.13, lastCheckpoint)).toBe(true)
  })

  test("without post-compaction gauge, old baseline persists (documents the bug)", () => {
    // This test documents the OLD buggy behavior that would occur
    // if Task 3 (inject gauge after compaction) was not implemented
    const messages = [
      createAssistantWithGauge(60), // Pre-compaction high, no reset gauge
    ]

    const lastCheckpoint = SessionCompaction.getLastGaugePercent(messages)
    expect(lastCheckpoint).toBe(0.6) // Still 60%!

    // Can't trigger at 50% because next threshold is 70%
    expect(SessionCompaction.shouldTriggerContextGauge(0.5, lastCheckpoint)).toBe(false)
  })
})

describe("injectContextGauge", () => {
  const model = {
    limit: { context: 1000, output: 0 },
  } as unknown as ModelsDev.Model

  // Helper to create a prior assistant message for history (with different ID)
  function createPriorAssistantMessage(): MessageV2.WithParts {
    return {
      info: {
        id: "msg-prior-assistant", // Different ID from current assistant
        sessionID: baseSession.id,
        role: "assistant",
        parentID: "msg-user",
        modelID: "test-model",
        providerID: "opencode",
        mode: "build",
        path: { cwd: "/tmp", root: "/" },
        time: {
          created: baseSession.created - 1000,
          completed: baseSession.created - 500,
        },
        cost: 0,
        tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    } satisfies MessageV2.WithParts
  }

  test("does not trigger on first assistant turn (no prior assistant messages)", async () => {
    const calls: MessageV2.Part[] = []
    const spy = spyOn(Session, "updatePart")
    spy.mockImplementation(((input: MessageV2.Part | { part: MessageV2.TextPart | MessageV2.ReasoningPart; delta: string }) => {
      const part = "delta" in input ? input.part : input
      calls.push(part)
      return Promise.resolve(part)
    }) as typeof Session.updatePart)

    // Even with 30% usage, should not trigger on first turn
    const assistantMessage = createAssistantMessage([], {
      input: 300,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })

    const inserted = await SessionCompaction.injectContextGauge({
      sessionID: baseSession.id,
      message: assistantMessage.info as MessageV2.Assistant,
      model,
      messages: [], // No prior messages
    })

    expect(inserted).toBe(false)
    expect(calls).toHaveLength(0)

    spy.mockRestore()
  })

  test("triggers when current usage crosses threshold using full token sum", async () => {
    const calls: MessageV2.Part[] = []
    const spy = spyOn(Session, "updatePart")
    spy.mockImplementation(((input: MessageV2.Part | { part: MessageV2.TextPart | MessageV2.ReasoningPart; delta: string }) => {
      const part = "delta" in input ? input.part : input
      calls.push(part)
      return Promise.resolve(part)
    }) as typeof Session.updatePart)

    // Total = 80 + 30 + 10 = 120 tokens = 12% of 1000 limit (should trigger first threshold)
    const assistantMessage = createAssistantMessage([], {
      input: 80,
      output: 30,
      reasoning: 10,
      cache: { read: 0, write: 0 },
    })

    const inserted = await SessionCompaction.injectContextGauge({
      sessionID: baseSession.id,
      message: assistantMessage.info as MessageV2.Assistant,
      model,
      messages: [createPriorAssistantMessage()], // Has prior assistant message
    })

    expect(inserted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe("context-gauge")
    // tokenCount should be the sum of all token fields
    expect((calls[0] as MessageV2.ContextGaugePart).tokenCount).toBe(120)
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

    // History has 450 tokens, but we only count current message tokens
    const history = [createPriorAssistantMessage()]

    // Current message: 50 + 50 = 100 tokens = 10% (below 12% threshold)
    // If we incorrectly counted history (450 + 100 = 550 = 55%), it would trigger
    const assistantMessage = createAssistantMessage([], {
      input: 50,
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
