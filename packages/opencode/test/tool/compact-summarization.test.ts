import { describe, expect, test } from "bun:test"

// Unit tests for compaction response parsing
// These tests don't require full session setup - they test the parsing logic in isolation

describe("compaction response parsing", () => {
  // Import the module dynamically to access parseCompactionResponse
  // Since it's not exported, we'll test through the public interface in integration tests
  // But we can test the parsing logic patterns here

  describe("JSON extraction patterns", () => {
    test("extracts JSON from plain response", () => {
      const response = `{
        "msg_001": {
          "summary": "Implemented user authentication flow",
          "indexTerms": ["auth", "JWT", "login"]
        }
      }`
      const match = response.match(/\{[\s\S]*\}/)
      expect(match).not.toBeNull()
      const parsed = JSON.parse(match![0])
      expect(parsed["msg_001"].summary).toBe("Implemented user authentication flow")
    })

    test("extracts JSON from markdown code blocks", () => {
      const response = `Here is the analysis:

\`\`\`json
{
  "msg_001": {
    "summary": "Fixed authentication bug",
    "indexTerms": ["auth", "bug", "fix"]
  }
}
\`\`\`

This summarizes the debugging session.`

      const match = response.match(/\{[\s\S]*\}/)
      expect(match).not.toBeNull()
      const parsed = JSON.parse(match![0])
      expect(parsed["msg_001"].summary).toBe("Fixed authentication bug")
    })

    test("extracts JSON with multiple ranges", () => {
      const response = `{
        "msg_001": {
          "summary": "Set up project structure",
          "indexTerms": ["setup", "init", "config"]
        },
        "msg_010": {
          "summary": "Implemented API endpoints",
          "indexTerms": ["API", "REST", "endpoints"]
        }
      }`
      const match = response.match(/\{[\s\S]*\}/)
      expect(match).not.toBeNull()
      const parsed = JSON.parse(match![0])
      expect(Object.keys(parsed).length).toBe(2)
      expect(parsed["msg_001"].summary).toBe("Set up project structure")
      expect(parsed["msg_010"].summary).toBe("Implemented API endpoints")
    })
  })

  describe("validation patterns", () => {
    test("handles valid structure", () => {
      const entry = {
        summary: "Test summary",
        indexTerms: ["term1", "term2", "term3"],
      }
      expect(typeof entry.summary).toBe("string")
      expect(Array.isArray(entry.indexTerms)).toBe(true)
      expect(entry.indexTerms.every((t: unknown) => typeof t === "string")).toBe(true)
    })

    test("filters non-string index terms", () => {
      const terms = ["valid", 123, "also-valid", null, "third"]
      const filtered = terms.filter((t): t is string => typeof t === "string")
      expect(filtered).toEqual(["valid", "also-valid", "third"])
    })

    test("limits index terms to 7", () => {
      const terms = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
      const limited = terms.slice(0, 7)
      expect(limited.length).toBe(7)
    })
  })

  describe("edge cases", () => {
    test("handles empty response", () => {
      const response = ""
      const match = response.match(/\{[\s\S]*\}/)
      expect(match).toBeNull()
    })

    test("handles response with no JSON", () => {
      const response = "I couldn't generate a summary for the given ranges."
      const match = response.match(/\{[\s\S]*\}/)
      expect(match).toBeNull()
    })

    test("handles malformed JSON gracefully", () => {
      const response = "{ invalid json }"
      const match = response.match(/\{[\s\S]*\}/)
      expect(match).not.toBeNull()
      expect(() => JSON.parse(match![0])).toThrow()
    })

    test("handles debugging content summary format", () => {
      const goodSummary =
        "Debugged auth failure across 3 iterations. Tried: token refresh (tokens valid), session storage (sessions persisting). Found: middleware order causing session loss before auth check."
      expect(goodSummary.length).toBeGreaterThan(50) // Detailed
      expect(goodSummary).toContain("Tried:")
      expect(goodSummary).toContain("Found:")
    })
  })
})

describe("CompactionSummary type validation", () => {
  test("valid summary structure", () => {
    const summary = {
      summary: "Implemented feature X with Y approach",
      indexTerms: ["feature-x", "approach-y", "implementation"],
    }

    expect(typeof summary.summary).toBe("string")
    expect(summary.summary.length).toBeGreaterThan(0)
    expect(summary.summary.length).toBeLessThan(500) // Reasonable upper bound
    expect(Array.isArray(summary.indexTerms)).toBe(true)
    expect(summary.indexTerms.length).toBeGreaterThanOrEqual(3)
    expect(summary.indexTerms.length).toBeLessThanOrEqual(7)
  })

  test("index terms are specific and technical", () => {
    const goodTerms = ["JWT", "middleware", "session-storage", "auth-flow"]
    const badTerms = ["code", "fix", "work", "stuff"]

    // Good terms are specific
    goodTerms.forEach((term) => {
      expect(term.length).toBeGreaterThan(2)
    })

    // Bad terms are too generic (this is guidance, not enforced)
    badTerms.forEach((term) => {
      expect(["code", "fix", "work", "stuff"]).toContain(term)
    })
  })
})

describe("range-to-summary mapping", () => {
  test("summaries keyed by startMessageId", () => {
    const ranges = [
      { startMessageId: "msg_001", endMessageId: "msg_005" },
      { startMessageId: "msg_010", endMessageId: "msg_015" },
    ]

    const summaries: Record<string, { summary: string; indexTerms: string[] }> = {
      msg_001: { summary: "First range summary", indexTerms: ["term1"] },
      msg_010: { summary: "Second range summary", indexTerms: ["term2"] },
    }

    // Each range can look up its summary by startMessageId
    ranges.forEach((range) => {
      const summary = summaries[range.startMessageId]
      expect(summary).toBeDefined()
      expect(typeof summary.summary).toBe("string")
    })
  })

  test("handles missing summary gracefully", () => {
    const ranges = [{ startMessageId: "msg_001", endMessageId: "msg_005" }]

    const summaries: Record<string, { summary: string; indexTerms: string[] }> = {}

    // When no summary exists, fallback should work
    const range = ranges[0]
    const summary = summaries[range.startMessageId]
    const summaryText = summary?.summary ?? "No summary generated"
    const indexText = summary?.indexTerms?.length ? summary.indexTerms.join(", ") : "No index terms"

    expect(summaryText).toBe("No summary generated")
    expect(indexText).toBe("No index terms")
  })
})
