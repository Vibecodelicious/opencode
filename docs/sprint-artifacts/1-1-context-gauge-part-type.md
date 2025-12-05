# Story 1.1: Context Gauge Part Type

**Status:** done

## Story

As a developer,
I want to define a new ContextGaugePart schema,
So that token utilization checkpoints can be stored as permanent message parts.

## Acceptance Criteria

1. **Given** the MessageV2 schema in `session/message-v2.ts`
   **When** I add the ContextGaugePart type
   **Then** the schema includes:
   ```typescript
   export const ContextGaugePart = PartBase.extend({
     type: z.literal("context-gauge"),
     tokenCount: z.number(),
     contextLimit: z.number(),
     percentage: z.number(),
   }).meta({ ref: "ContextGaugePart" })
   ```

2. **And** ContextGaugePart is added to the Part discriminated union

3. **And** the part can be serialized/deserialized correctly

4. **And** existing message loading continues to work (backwards compatible)

## Tasks / Subtasks

- [x] **Task 1: Define ContextGaugePart schema** (AC: #1)
  - [x] 1.1: Add `ContextGaugePart` constant extending `PartBase` with required fields
  - [x] 1.2: Export the TypeScript type `ContextGaugePart`
  - [x] 1.3: Add `.meta({ ref: "ContextGaugePart" })` for schema reference

- [x] **Task 2: Register in Part discriminated union** (AC: #2)
  - [x] 2.1: Add `ContextGaugePart` to the `Part = z.discriminatedUnion("type", [...])` array
  - [x] 2.2: Verify union type compiles correctly

- [x] **Task 3: Handle in toModelMessage()** (AC: #3, #4)
  - [x] 3.1: Add context-gauge handling in `toModelMessage()` assistant block
  - [x] 3.2: Render gauge as text: `[CONTEXT GAUGE: {tokenCount} / {contextLimit} tokens ({percentage}%)]`

- [x] **Task 4: Verify backwards compatibility** (AC: #4)
  - [x] 4.1: Verify existing messages without context-gauge load correctly
  - [x] 4.2: Verify no runtime errors on old session files
  - [x] 4.3: Run existing tests to confirm no regressions

## Dev Notes

### Primary File Location

`packages/opencode/src/session/message-v2.ts`

This is the ONLY file that needs modification for this story.

### Schema Definition Pattern

Follow the existing part type patterns exactly. Looking at the current codebase:

```typescript
// Existing pattern example (CompactionPart at lines 149-155):
export const CompactionPart = PartBase.extend({
  type: z.literal("compaction"),
  auto: z.boolean(),
}).meta({
  ref: "CompactionPart",
})
export type CompactionPart = z.infer<typeof CompactionPart>
```

**Your implementation should follow this exact pattern:**

```typescript
// Add after CompactionPart (around line 155):
export const ContextGaugePart = PartBase.extend({
  type: z.literal("context-gauge"),
  tokenCount: z.number(),
  contextLimit: z.number(),
  percentage: z.number(),
}).meta({
  ref: "ContextGaugePart",
})
export type ContextGaugePart = z.infer<typeof ContextGaugePart>
```

**CRITICAL - Export both const AND type:**
- `export const ContextGaugePart` - The Zod schema object (for runtime validation)
- `export type ContextGaugePart` - The TypeScript type (for compile-time type checking)

Both exports are required. The type export uses `z.infer<typeof ContextGaugePart>` to derive the TS type from the Zod schema. This pattern is used by ALL part types in the file.

### PartBase Fields (Inherited)

Every part inherits these fields from `PartBase` (lines 37-41):
```typescript
const PartBase = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
})
```

So your `ContextGaugePart` automatically has: `id`, `sessionID`, `messageID`, plus the new fields.

### Registering in Part Union

The `Part` discriminated union is at lines 312-330. You need to add `ContextGaugePart` to this array:

```typescript
export const Part = z
  .discriminatedUnion("type", [
    TextPart,
    SubtaskPart,
    ReasoningPart,
    FilePart,
    ToolPart,
    StepStartPart,
    StepFinishPart,
    SnapshotPart,
    PatchPart,
    AgentPart,
    RetryPart,
    CompactionPart,
    ContextGaugePart,  // <-- ADD HERE
  ])
  .meta({
    ref: "Part",
  })
```

### toModelMessage() Handling

The `toModelMessage()` function (lines 555-672) converts parts to model messages. Add context-gauge handling in the assistant message block (lines 603-667):

```typescript
// In the `if (msg.info.role === "assistant")` block, add after reasoning handling:
if (part.type === "context-gauge") {
  assistantMessage.parts.push({
    type: "text",
    text: `[CONTEXT GAUGE: ${part.tokenCount.toLocaleString()} / ${part.contextLimit.toLocaleString()} tokens (${part.percentage}%)]`,
  })
}
```

**User message handling:** Context gauges will ONLY appear in assistant messages (injected by Story 1.2 after response completion). No handling is needed in the user message block. If a context-gauge somehow appears in a user message, it will be silently ignored (this is correct behavior - unhandled part types are simply skipped).

### Format String

Per Architecture spec (Placeholder Formats section):
```
[CONTEXT GAUGE: 45,000 / 100,000 tokens (45%)]
```

Use `toLocaleString()` for number formatting with comma separators.

### Backwards Compatibility

Zod's `.optional()` is NOT needed on the Part union - the discriminated union already handles this. Old messages simply won't have `context-gauge` parts, and that's fine. The storage layer loads whatever parts exist.

Key verification:
1. Load an existing session
2. Confirm all messages load without errors
3. Confirm no `context-gauge` parts appear (as expected - none created yet)

### Testing Approach

OpenCode uses `bun:test` framework. Tests live in `packages/opencode/test/`.

**Test file location:** `packages/opencode/test/session/context-gauge.test.ts` (NEW)

**Example test implementation:**

```typescript
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
})
```

**Run tests:**
```bash
cd packages/opencode && bun test
# Or run specific test file:
cd packages/opencode && bun test test/session/context-gauge.test.ts
```

**Note:** These tests don't require `Instance.provide()` since they test pure schema validation and function output, not storage or project context.

### Project Structure Notes

- **Source change**: `packages/opencode/src/session/message-v2.ts` (MODIFY)
- **Test file**: `packages/opencode/test/session/context-gauge.test.ts` (NEW)
- **Follows existing patterns**: Exactly matches CompactionPart, RetryPart, etc.

### References

- [Source: docs/architecture.md#Context-Gauge-Part-Type] - Schema definition
- [Source: docs/architecture.md#Placeholder-Formats] - Display format `[CONTEXT GAUGE: ...]`
- [Source: docs/epics.md#Story-1.1] - Original story requirements
- [Source: packages/opencode/src/session/message-v2.ts:149-155] - CompactionPart pattern to follow
- [Source: packages/opencode/src/session/message-v2.ts:312-330] - Part union to extend
- [Source: packages/opencode/src/session/message-v2.ts:555-672] - toModelMessage() to update

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

<!-- To be filled by dev agent -->

### Debug Log References

<!-- To be added during implementation -->

### Completion Notes List

- ✅ ContextGaugePart schema defined: `packages/opencode/src/session/message-v2.ts:157-165`
- ✅ Registered in Part union: `packages/opencode/src/session/message-v2.ts:336`
- ✅ toModelMessage() handling implemented: `packages/opencode/src/session/message-v2.ts:678-683`
- ✅ Backwards compatibility verified: All 199 tests pass, no regressions
- ✅ Test suite created: `packages/opencode/test/session/context-gauge.test.ts` with 6 tests
- ✅ Code review fixes applied:
  - Added edge case test for zero percentage (0 tokens)
  - Added explicit toLocaleString() format verification test with large numbers (1,234,567)
  - Fixed toModelMessage formatting validation with regex extraction

### File List

- `packages/opencode/src/session/message-v2.ts` (MODIFY - added ContextGaugePart schema, union registration, toModelMessage handling)
- `packages/opencode/test/session/context-gauge.test.ts` (NEW - test file with 4 tests)
