import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

const baseAssistant = {
  id: "msg_anchor",
  sessionID: "ses_anchor",
  role: "assistant" as const,
  time: { created: Date.now() },
  parentID: "msg_parent",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "build",
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

describe("MessageV2 archive schema", () => {
  test("accepts archive metadata on anchor message", () => {
    const parsed = MessageV2.Assistant.parse({
      ...baseAssistant,
      archive: {
        summary: "Archived range summary",
        indexTerms: ["auth", "jwt"],
        rangeEnd: "msg_end",
      },
    })

    expect(parsed.archive?.summary).toBe("Archived range summary")
    expect(parsed.archive?.indexTerms).toEqual(["auth", "jwt"])
    expect(parsed.archive?.rangeEnd).toBe("msg_end")
  })

  test("accepts archivedBy on follower message", () => {
    const parsed = MessageV2.Assistant.parse({
      ...baseAssistant,
      id: "msg_follower",
      archivedBy: "msg_anchor",
    })

    expect(parsed.archivedBy).toBe("msg_anchor")
  })
})

const basePart = {
  id: "prt_text",
  sessionID: "ses_anchor",
  messageID: "msg_anchor",
}

describe("toModelMessage archive rendering", () => {
  test("renders archive placeholder for anchor and omits original parts", () => {
    const input = [
      {
        info: {
          ...baseAssistant,
          archive: {
            summary: "Discussed auth architecture",
            indexTerms: ["auth", "jwt"],
            rangeEnd: "msg_end",
          },
        },
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Original archived content",
          },
        ],
      },
    ]

    const result = MessageV2.toModelMessage(input)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[SMART_ARCHIVED: msg_anchor to msg_end]")
    expect(serialized).toContain("Summary: Discussed auth architecture")
    expect(serialized).toContain("Index: auth, jwt")
    expect(serialized).not.toContain("Original archived content")
  })

  test("skips archivedBy follower messages entirely", () => {
    const input = [
      {
        info: {
          ...baseAssistant,
          archive: {
            summary: "Anchor summary",
            indexTerms: ["foo"],
            rangeEnd: "msg_follower",
          },
        },
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Anchor text",
          },
        ],
      },
      {
        info: {
          ...baseAssistant,
          id: "msg_follower",
          archivedBy: "msg_anchor",
        },
        parts: [
          {
            ...basePart,
            id: "prt_follower",
            messageID: "msg_follower",
            type: "text" as const,
            text: "Follower text should be skipped",
          },
        ],
      },
      {
        info: {
          ...baseAssistant,
          id: "msg_next",
          parentID: "msg_anchor",
        },
        parts: [
          {
            ...basePart,
            id: "prt_next",
            messageID: "msg_next",
            type: "text" as const,
            text: "Next message should render",
          },
        ],
      },
    ]

    const result = MessageV2.toModelMessage(input)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[SMART_ARCHIVED: msg_anchor to msg_follower]")
    expect(serialized).toContain("Next message should render")
    expect(serialized).not.toContain("Follower text should be skipped")
  })

  test("renders non-archived messages normally", () => {
    const input = [
      {
        info: {
          ...baseAssistant,
          id: "msg_plain",
        },
        parts: [
          {
            ...basePart,
            id: "prt_plain",
            messageID: "msg_plain",
            type: "text" as const,
            text: "Regular content",
          },
        ],
      },
    ]

    const result = MessageV2.toModelMessage(input)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("Regular content")
    expect(serialized).not.toContain("SMART_ARCHIVED")
  })

  test("dual-state message (archive + archivedBy) still renders as anchor placeholder", () => {
    const input = [
      {
        info: {
          ...baseAssistant,
          archivedBy: "msg_other",
          archive: {
            summary: "Dual state summary",
            indexTerms: ["dual"],
            rangeEnd: "msg_end",
          },
        },
        parts: [
          {
            ...basePart,
            type: "text" as const,
            text: "Dual state text",
          },
        ],
      },
    ]

    const result = MessageV2.toModelMessage(input)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain("[SMART_ARCHIVED: msg_anchor to msg_end]")
    expect(serialized).toContain("Dual state summary")
    expect(serialized).not.toContain("Dual state text")
  })
})

describe("partitionByArchive", () => {
  test("splits anchors, followers, and normal messages", () => {
    const messages = [
      {
        info: {
          ...baseAssistant,
          archive: {
            summary: "s",
            indexTerms: [],
            rangeEnd: "msg_b",
          },
        },
        parts: [],
      },
      {
        info: {
          ...baseAssistant,
          id: "msg_b",
          archivedBy: "msg_anchor",
        },
        parts: [],
      },
      {
        info: {
          ...baseAssistant,
          id: "msg_c",
          parentID: "msg_anchor",
        },
        parts: [],
      },
    ]

    const { anchors, followers, normal } = MessageV2.partitionByArchive(messages as any)

    expect(anchors.map((m) => m.info.id)).toEqual(["msg_anchor"])
    expect(followers.map((m) => m.info.id)).toEqual(["msg_b"])
    expect(normal.map((m) => m.info.id)).toEqual(["msg_c"])
  })
})
