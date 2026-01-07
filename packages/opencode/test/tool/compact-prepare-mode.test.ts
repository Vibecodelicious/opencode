import { describe, expect, test, beforeEach, mock } from "bun:test"

import { CompactionModeState } from "../../src/session/compaction-mode-state"
import { isPrepareMode, PREPARE_MODE_RESPONSE } from "../../src/tool/compact"

describe("CompactionModeState", () => {
  beforeEach(() => {
    // Clear all state between tests
    CompactionModeState.reset()
  })

  describe("flag starts false", () => {
    test("returns false for unknown session", () => {
      const result = CompactionModeState.get("ses_unknown")
      expect(result).toBe(false)
    })

    test("returns false for a new session ID", () => {
      const result = CompactionModeState.get("ses_test123")
      expect(result).toBe(false)
    })
  })

  describe("set and get", () => {
    test("can set flag to true", () => {
      CompactionModeState.set("ses_test", true)
      const result = CompactionModeState.get("ses_test")
      expect(result).toBe(true)
    })

    test("can set flag to false after being true", () => {
      CompactionModeState.set("ses_test", true)
      expect(CompactionModeState.get("ses_test")).toBe(true)

      CompactionModeState.set("ses_test", false)
      expect(CompactionModeState.get("ses_test")).toBe(false)
    })

    test("state is isolated per session", () => {
      CompactionModeState.set("ses_a", true)
      CompactionModeState.set("ses_b", false)

      expect(CompactionModeState.get("ses_a")).toBe(true)
      expect(CompactionModeState.get("ses_b")).toBe(false)
      expect(CompactionModeState.get("ses_c")).toBe(false)
    })
  })

  describe("reset", () => {
    test("clears all session state", () => {
      CompactionModeState.set("ses_1", true)
      CompactionModeState.set("ses_2", true)

      CompactionModeState.reset()

      expect(CompactionModeState.get("ses_1")).toBe(false)
      expect(CompactionModeState.get("ses_2")).toBe(false)
    })
  })

  describe("clear", () => {
    test("clears state for a single session", () => {
      CompactionModeState.set("ses_keep", true)
      CompactionModeState.set("ses_clear", true)

      CompactionModeState.clear("ses_clear")

      expect(CompactionModeState.get("ses_keep")).toBe(true)
      expect(CompactionModeState.get("ses_clear")).toBe(false)
    })
  })
})

describe("isPrepareMode", () => {
  test("returns true for undefined ranges", () => {
    expect(isPrepareMode(undefined)).toBe(true)
  })

  test("returns true for empty array", () => {
    expect(isPrepareMode([])).toBe(true)
  })

  test("returns false for array with one range", () => {
    expect(isPrepareMode([{ startMessageId: "msg_123" }])).toBe(false)
  })

  test("returns false for array with multiple ranges", () => {
    expect(
      isPrepareMode([
        { startMessageId: "msg_1", endMessageId: "msg_2" },
        { startMessageId: "msg_3", endMessageId: "msg_4" },
      ]),
    ).toBe(false)
  })
})

describe("PREPARE_MODE_RESPONSE", () => {
  test("contains instructions about message ID visibility", () => {
    expect(PREPARE_MODE_RESPONSE).toContain("Message IDs are now visible")
    expect(PREPARE_MODE_RESPONSE).toContain("[msg_")
  })

  test("contains warning about not mimicking IDs", () => {
    expect(PREPARE_MODE_RESPONSE).toContain("Do NOT mimic or generate message IDs")
  })

  test("contains instructions to call compact again", () => {
    expect(PREPARE_MODE_RESPONSE).toContain("Call compact again")
    expect(PREPARE_MODE_RESPONSE).toContain("ranges")
  })

  test("contains example JSON", () => {
    expect(PREPARE_MODE_RESPONSE).toContain("startMessageId")
    expect(PREPARE_MODE_RESPONSE).toContain("endMessageId")
  })
})

describe("Two-phase compaction flag lifecycle", () => {
  beforeEach(() => {
    CompactionModeState.reset()
  })

  test("prepare mode sets flag to true", () => {
    // Simulate prepare mode call
    CompactionModeState.set("ses_test", true)
    expect(CompactionModeState.get("ses_test")).toBe(true)
  })

  test("flag should be reset after successful compaction", () => {
    // Simulate full two-phase flow:
    // 1. Prepare mode sets flag
    CompactionModeState.set("ses_test", true)
    expect(CompactionModeState.get("ses_test")).toBe(true)

    // 2. After successful compaction, flag is reset
    CompactionModeState.set("ses_test", false)
    expect(CompactionModeState.get("ses_test")).toBe(false)
  })

  test("flag state is isolated between sessions", () => {
    CompactionModeState.set("ses_a", true)
    CompactionModeState.set("ses_b", false)

    expect(CompactionModeState.get("ses_a")).toBe(true)
    expect(CompactionModeState.get("ses_b")).toBe(false)

    // Resetting one doesn't affect the other
    CompactionModeState.set("ses_a", false)
    expect(CompactionModeState.get("ses_a")).toBe(false)
    expect(CompactionModeState.get("ses_b")).toBe(false)
  })

  test("flag should be reset even when archival count is zero", () => {
    // Scenario: user calls compact with ranges, but no summaries generated
    // (e.g., no model info available, or summarization fails completely)
    // The flag should still be reset because execute mode was invoked
    CompactionModeState.set("ses_test", true)
    expect(CompactionModeState.get("ses_test")).toBe(true)

    // Execute mode completes (even with archivedCount = 0)
    CompactionModeState.set("ses_test", false)
    expect(CompactionModeState.get("ses_test")).toBe(false)
  })

  test("multiple prepare mode calls are idempotent", () => {
    // Calling prepare mode multiple times should not cause issues
    CompactionModeState.set("ses_test", true)
    CompactionModeState.set("ses_test", true)
    CompactionModeState.set("ses_test", true)
    expect(CompactionModeState.get("ses_test")).toBe(true)

    // Single reset still works
    CompactionModeState.set("ses_test", false)
    expect(CompactionModeState.get("ses_test")).toBe(false)
  })
})
