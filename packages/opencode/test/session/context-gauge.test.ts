import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

describe("ContextGaugePart", () => {
  test("validates correct schema", () => {
    const part = {
      id: "prt_test123",
      sessionID: "ses_test123",
      messageID: "msg_test123",
      type: "context-gauge",
      tokenCount: 50000,
      contextLimit: 100000,
      percentage: 50,
    }
    const result = MessageV2.ContextGaugePart.parse(part)
    expect(result.type).toBe("context-gauge")
    expect(result.tokenCount).toBe(50000)
  })

  test("rejects invalid schema - missing required field", () => {
    const part = {
      id: "prt_test123",
      sessionID: "ses_test123",
      messageID: "msg_test123",
      type: "context-gauge",
      tokenCount: 50000,
      // missing contextLimit and percentage
    }
    expect(() => MessageV2.ContextGaugePart.parse(part)).toThrow()
  })

  test("Part union accepts context-gauge type", () => {
    const part = {
      id: "prt_test123",
      sessionID: "ses_test123",
      messageID: "msg_test123",
      type: "context-gauge",
      tokenCount: 50000,
      contextLimit: 100000,
      percentage: 50,
    }
    const result = MessageV2.Part.parse(part)
    expect(result.type).toBe("context-gauge")
  })
})

describe("toModelMessage with ContextGaugePart", () => {
  test("renders context-gauge as text in assistant message", () => {
    const input = [{
      info: {
        id: "msg_test",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: Date.now() },
        parentID: "msg_parent",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{
        id: "prt_gauge",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "context-gauge" as const,
        tokenCount: 45000,
        contextLimit: 100000,
        percentage: 45,
      }],
    }]

    const result = MessageV2.toModelMessage(input)
    const content = JSON.stringify(result)
    expect(content).toContain("CONTEXT GAUGE")
    expect(content).toContain("45,000")
    expect(content).toContain("100,000")
    expect(content).toContain("45%")
  })

  test("renders context-gauge with zero percentage", () => {
    const input = [{
      info: {
        id: "msg_test",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: Date.now() },
        parentID: "msg_parent",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{
        id: "prt_gauge",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "context-gauge" as const,
        tokenCount: 0,
        contextLimit: 100000,
        percentage: 0,
      }],
    }]

    const result = MessageV2.toModelMessage(input)
    const content = JSON.stringify(result)
    expect(content).toContain("CONTEXT GAUGE")
    expect(content).toContain("0")
    expect(content).toContain("100,000")
    expect(content).toContain("0%")
  })

  test("formats numbers with locale string separators", () => {
    const input = [{
      info: {
        id: "msg_test",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: Date.now() },
        parentID: "msg_parent",
        modelID: "test-model",
        providerID: "test-provider",
        mode: "build",
        path: { cwd: "/test", root: "/test" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{
        id: "prt_gauge",
        sessionID: "ses_test",
        messageID: "msg_test",
        type: "context-gauge" as const,
        tokenCount: 1234567,
        contextLimit: 9876543,
        percentage: 12,
      }],
    }]

    const result = MessageV2.toModelMessage(input)
    const resultStr = JSON.stringify(result)

    // Verify the formatted output contains locale-specific number formatting
    // toLocaleString() on 1234567 should include a thousands separator
    expect(resultStr).toContain("CONTEXT GAUGE")

    // Extract just the gauge text to verify formatting
    const gaugeText = resultStr.match(/CONTEXT GAUGE[^"]*/) || []
    expect(gaugeText[0]).toContain("1,234,567")
    expect(gaugeText[0]).toContain("9,876,543")
    expect(gaugeText[0]).toContain("12%")
  })
})
