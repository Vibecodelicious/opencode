# Story 2.1: Compact Tool Basic Structure

Status: Done (Code Review Passed)

## Story

As a developer,
I want the Compact tool to accept message range parameters and validate them thoroughly,
So that users and the LLM can specify what content to compact with confidence that invalid requests are caught early.

## Acceptance Criteria

1. **Parameter Schema (Already Defined)**
   - The existing schema in `compact.ts` accepts `ranges` array with `{ startMessageId: string; endMessageId?: string }`
   - Schema validation via Zod already handles empty arrays and missing startMessageId
   - **No schema changes needed** - focus is on runtime validation

2. **Message Existence Validation**
   - Look up each message ID in the current session's storage
   - Use `MessageV2.get({ sessionID, messageID })` pattern from `session/message-v2.ts:747`
   - Return clear error: `"Message not found: {id}"`

3. **Chronological Order Validation**
   - Message IDs are lexicographically sortable (ascending timestamp format)
   - Verify `startMessageId <= endMessageId` (string comparison works because IDs are `msg_[HEX_TIMESTAMP][RANDOM_BASE62]`)
   - Return error: `"Start message must come before end message: {startId} > {endId}"`

4. **Archive Status Validation**
   - Check `message.info.archive` field (first message of an existing archive)
   - Check `message.info.archivedBy` field (subsequent message in an existing archive)
   - Return error: `"Message {id} is already archived (part of archive {archivedBy})"`
   - **Edge case from Epic 2.1 spec**: A range that *includes* previously-archived messages in the middle is acceptable; only reject if the range *starts or ends* with archived messages

5. **Overlap Detection (Multi-Range)**
   - When multiple ranges provided, check no ranges overlap
   - Two ranges overlap if their message ID intervals intersect
   - Return error: `"Ranges overlap: ({start1} to {end1}) and ({start2} to {end2})"`

6. **Tool Output (This Story)**
   - On validation success: return description of what will be compacted
   - Format: `"Validated {n} range(s) for compaction: [msg_abc to msg_xyz (k messages)], ... Total: N messages. Ready for summarization."`
   - **Do NOT perform actual compaction** - that's Story 2.2
   - **Do NOT call compaction LLM** - that's Story 2.2

## Tasks / Subtasks

- [x] Task 1 (AC: 2): Implement message lookup helper
  - [x] Subtask 1.1: Create function to fetch message by ID using `MessageV2.get()` pattern
  - [x] Subtask 1.2: Handle "not found" case gracefully with clear error message
  - [x] Subtask 1.3: Return both message info and parts for archive status checking

- [x] Task 2 (AC: 3, 4, 5): Implement range validation functions
  - [x] Subtask 2.1: `normalizeRange()` - fill in missing endMessageId with startMessageId
  - [x] Subtask 2.2: `validateSingleRange()` - check order and archive status for one range
  - [x] Subtask 2.3: `validateRangeOverlaps()` - check all pairs for overlapping intervals
  - [x] Subtask 2.4: `collectMessagesInRange()` - get all messages between start and end IDs

- [x] Task 3 (AC: 6): Update CompactTool.execute()
  - [x] Subtask 3.1: Accept Tool.Context to get sessionID for message lookup
  - [x] Subtask 3.2: Call validation functions and handle errors
  - [x] Subtask 3.3: Return success output with range details and message counts

- [x] Task 4: Add comprehensive tests
  - [x] Subtask 4.1: Test valid single-range (messages exist, correct order, not archived)
  - [x] Subtask 4.2: Test valid multi-range (multiple non-overlapping ranges)
  - [x] Subtask 4.3: Test error: message not found
  - [x] Subtask 4.4: Test error: messages in wrong chronological order
  - [x] Subtask 4.5: Test error: message already archived (has `archive` or `archivedBy`)
  - [x] Subtask 4.6: Test error: ranges overlap
  - [x] Subtask 4.7: Test edge case: range with archived messages in middle (should succeed)

## Technical Deep Dive

### Current Compact Tool Implementation (compact.ts:1-35)

```typescript
// Current stub - needs enhancement
export const CompactTool = Tool.define("compact", {
  description: DESCRIPTION,
  parameters: Parameters,  // Already has ranges array schema
  async execute(params) {
    const rangeCount = params.ranges.length
    return {
      title: "Compaction placeholder",
      output: `Not yet implemented: compaction stub received ${rangeCount} range(s).`,
      metadata: {},
    }
  },
  // ...
})
```

**Key insight**: The `execute` function receives a `Tool.Context` as second argument (from `tool.ts:10-17`):
```typescript
export type Context<M extends Metadata = Metadata> = {
  sessionID: string     // <-- Need this for message lookup
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  metadata(input: { title?: string; metadata?: M }): void
}
```

### Message Storage Pattern (message-v2.ts:747-758)

```typescript
export const get = fn(
  z.object({
    sessionID: Identifier.schema("session"),
    messageID: Identifier.schema("message"),
  }),
  async (input) => {
    return {
      info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
      parts: await parts(input.messageID),
    }
  },
)
```

**Usage**: `const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: "msg_xxx" })`

### Archive Schema (message-v2.ts:297-309)

```typescript
export const Archive = z.object({
  summary: z.string(),
  indexTerms: z.array(z.string()),
  rangeEnd: z.string(),
})

const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
  archive: Archive.optional(),      // First message of archive
  archivedBy: z.string().optional(),  // Subsequent messages point back
})
```

**Check archived status:**
```typescript
if (msg.info.archive) {
  // This message is the ANCHOR of an archive
  return `Message ${msg.info.id} is the start of archive ranging to ${msg.info.archive.rangeEnd}`
}
if (msg.info.archivedBy) {
  // This message is PART of another archive
  return `Message ${msg.info.id} is already archived by ${msg.info.archivedBy}`
}
```

### Message ID Format

From examining the codebase, message IDs use the `Identifier.ascending("message")` pattern producing IDs like:
- `msg_[HEX_TIMESTAMP][RANDOM_BASE62]`
- Example: `msg_01934abc12340xyz`

**Critical**: These IDs are lexicographically sortable by time, so string comparison works:
```typescript
startMessageId <= endMessageId  // Works because IDs are time-ordered
```

### Getting All Messages in Range

From `session/index.ts:287-301`:
```typescript
export const messages = fn(
  z.object({
    sessionID: Identifier.schema("session"),
    limit: z.number().optional(),
  }),
  async (input) => {
    const result = [] as MessageV2.WithParts[]
    for await (const msg of MessageV2.stream(input.sessionID)) {
      if (input.limit && result.length >= input.limit) break
      result.push(msg)
    }
    result.reverse()
    return result
  },
)
```

**To get messages in a range**: Load all messages, filter by ID comparison.

### Test Pattern (from compact-retrieve.test.ts)

```typescript
const ctx = {
  sessionID: "test",
  messageID: "",
  toolCallID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

await withSandbox(async ({ Instance, CompactTool }) => {
  await Instance.provide({
    directory: projectRoot,
    fn: async () => {
      const tool = await CompactTool.init()
      const result = await tool.execute({ ranges: [...] }, ctx)
      expect(result.output).toContain(...)
    },
  })
})
```

## Implementation Guide

### Step 1: Message Lookup Helper

Create in `compact.ts`:

```typescript
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"

async function getMessage(sessionID: string, messageID: string): Promise<MessageV2.WithParts> {
  try {
    return await MessageV2.get({ sessionID, messageID })
  } catch (e) {
    throw new Error(`Message not found: ${messageID}`)
  }
}
```

### Step 2: Validation Functions

```typescript
interface NormalizedRange {
  startMessageId: string
  endMessageId: string
}

function normalizeRanges(ranges: Array<{ startMessageId: string; endMessageId?: string }>): NormalizedRange[] {
  return ranges.map(r => ({
    startMessageId: r.startMessageId,
    endMessageId: r.endMessageId ?? r.startMessageId,
  }))
}

async function validateSingleRange(
  sessionID: string,
  range: NormalizedRange
): Promise<{ messages: MessageV2.WithParts[], start: MessageV2.WithParts, end: MessageV2.WithParts }> {
  const start = await getMessage(sessionID, range.startMessageId)
  const end = await getMessage(sessionID, range.endMessageId)

  // Check chronological order
  if (range.startMessageId > range.endMessageId) {
    throw new Error(`Start message must come before end message: ${range.startMessageId} > ${range.endMessageId}`)
  }

  // Check archive status of START message
  if (start.info.archive) {
    throw new Error(`Message ${start.info.id} is already the anchor of an archive`)
  }
  if (start.info.archivedBy) {
    throw new Error(`Message ${start.info.id} is already archived (part of archive ${start.info.archivedBy})`)
  }

  // Check archive status of END message
  if (end.info.archive) {
    throw new Error(`Message ${end.info.id} is already the anchor of an archive`)
  }
  if (end.info.archivedBy) {
    throw new Error(`Message ${end.info.id} is already archived (part of archive ${end.info.archivedBy})`)
  }

  // Collect all messages in range
  const allMessages = await Session.messages({ sessionID })
  const messagesInRange = allMessages.filter(
    m => m.info.id >= range.startMessageId && m.info.id <= range.endMessageId
  )

  if (messagesInRange.length === 0) {
    throw new Error(`Range contains no messages: ${range.startMessageId} to ${range.endMessageId}`)
  }

  return { messages: messagesInRange, start, end }
}

function validateNoOverlaps(ranges: NormalizedRange[]): void {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]
      const b = ranges[j]

      // Two ranges overlap if one starts before the other ends
      const overlaps =
        (a.startMessageId <= b.startMessageId && b.startMessageId <= a.endMessageId) ||
        (b.startMessageId <= a.startMessageId && a.startMessageId <= b.endMessageId)

      if (overlaps) {
        throw new Error(`Ranges overlap: (${a.startMessageId} to ${a.endMessageId}) and (${b.startMessageId} to ${b.endMessageId})`)
      }
    }
  }
}
```

### Step 3: Updated execute()

```typescript
export const CompactTool = Tool.define("compact", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {  // Note: ctx is Tool.Context
    const normalized = normalizeRanges(params.ranges)

    // Check for overlaps first (cheaper than message lookups)
    validateNoOverlaps(normalized)

    // Validate each range and collect messages
    const validatedRanges: Array<{
      range: NormalizedRange
      messages: MessageV2.WithParts[]
    }> = []

    for (const range of normalized) {
      const { messages } = await validateSingleRange(ctx.sessionID, range)
      validatedRanges.push({ range, messages })
    }

    // Build success output
    const totalMessages = validatedRanges.reduce((sum, r) => sum + r.messages.length, 0)
    const rangeDescriptions = validatedRanges.map(
      r => `(${r.range.startMessageId} to ${r.range.endMessageId}, ${r.messages.length} message${r.messages.length === 1 ? '' : 's'})`
    ).join(", ")

    return {
      title: "Compaction validation",
      output: `Validated ${normalized.length} range(s) for compaction: ${rangeDescriptions}. Total: ${totalMessages} messages. Ready for summarization.`,
      metadata: {
        rangeCount: normalized.length,
        totalMessages,
      },
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid compact input: ${details}`
  },
})
```

## Testing Strategy

### Mock Session Data

For testing, create a session with known messages:

```typescript
// Create test messages with predictable IDs
const testMessages = [
  { id: "msg_0001_aaa", role: "user" },
  { id: "msg_0002_bbb", role: "assistant" },
  { id: "msg_0003_ccc", role: "user" },
  { id: "msg_0004_ddd", role: "assistant", archive: { summary: "test", indexTerms: [], rangeEnd: "msg_0005_eee" } },
  { id: "msg_0005_eee", role: "user", archivedBy: "msg_0004_ddd" },
  { id: "msg_0006_fff", role: "assistant" },
]
```

### Test Cases

1. **Valid single range**: `msg_0001_aaa` to `msg_0003_ccc` → Success
2. **Valid multi-range**: `[msg_0001_aaa to msg_0002_bbb, msg_0006_fff]` → Success
3. **Not found**: `msg_nonexistent` → Error
4. **Wrong order**: `msg_0003_ccc` to `msg_0001_aaa` → Error
5. **Start already archived**: `msg_0004_ddd` to `msg_0006_fff` → Error
6. **End already archived**: `msg_0001_aaa` to `msg_0005_eee` → Error
7. **Overlapping ranges**: `[msg_0001 to msg_0003, msg_0002 to msg_0004]` → Error
8. **Archived in middle (edge case)**: `msg_0001_aaa` to `msg_0006_fff` → **Should succeed** per Epic spec

## Previous Story Intelligence

**Story 1.6 (Tool Registration Setup) - Completed:**
- `CompactTool` already defined with Zod schema
- Parameters accept `ranges` array with optional `endMessageId`
- Tool returns "Not yet implemented" stub
- Tool description explains placeholder status

**Story 1.3 & 1.4 (Message Schema & Archive Context) - Completed:**
- `archive` and `archivedBy` fields exist on MessageV2.Info
- `toModelMessageWithIDs()` already handles archived messages
- Placeholder format defined: `[SMART_ARCHIVED: msg_xxx to msg_yyy]`

**Story 1.5 (Configuration) - Completed:**
- Compaction mode (ask/notify/silent) is configurable
- **NOT relevant to this story** - mode is checked when LLM autonomously compacts (Story 4.x)

## Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add validation logic, update execute() |
| `packages/opencode/src/tool/compact.txt` | Update description to explain validation |
| `packages/opencode/test/tool/compact.test.ts` | Add comprehensive validation tests |

## Definition of Done

- [x] All validation functions implemented and tested
- [x] Error messages are specific and actionable
- [x] Tool returns success output with range details
- [x] Existing tests continue to pass
- [x] New tests cover all error conditions
- [x] No regressions to existing tools
- [x] Code follows existing patterns (strict TypeScript, Zod validation)

## Risk Notes

1. **Session Context**: The `ctx.sessionID` must be valid for message lookups. The existing test fixtures use a "test" sessionID which may need actual session setup for integration tests.

2. **Performance**: Loading all messages to filter by range could be slow for very long conversations. Consider optimization if needed, but premature optimization is not required for MVP.

3. **ID Format Assumption**: Validation relies on lexicographic ordering of message IDs. Verify this assumption holds by examining actual message ID generation in `Identifier.ascending()`.

---

## Dev Agent Record

### Implementation Plan

Implemented the Compact tool validation logic following the story acceptance criteria:

1. **getMessage()** - Helper function that wraps `MessageV2.get()` and provides clear "Message not found" errors
2. **normalizeRanges()** - Fills in missing `endMessageId` with `startMessageId` for single-message ranges
3. **validateSingleRange()** - Validates a single range for:
   - Message existence (both start and end)
   - Chronological order (start <= end using lexicographic comparison)
   - Archive status (start and end must not be archived)
   - Returns all messages in the range
4. **validateNoOverlaps()** - Checks that multiple ranges don't overlap
5. **CompactTool.execute()** - Updated to accept `Tool.Context`, run all validations, and return success output

### Debug Log

- Initial implementation worked correctly
- Updated test context `sessionID` from "test" to "ses_test" to match Identifier schema requirements
- Review pass: Fixed output format to use square brackets `[msg to msg (k messages)]` per AC 6
- Review pass: Reordered archive checks to prioritize `archivedBy` over `archive` for clearer error messages
- All 244 tests pass with no regressions

### Completion Notes

✅ Story 2.1 implementation complete:
- All validation functions implemented in `compact.ts`
- Error messages match AC specifications exactly
- Success output includes range count, message counts, and "Ready for summarization" message
- Created comprehensive test suite with 7 new tests in `compact-validation.test.ts`
- Updated existing tests in `compact-retrieve.test.ts` to test validation behavior
- Tool description updated to explain validation rules
- No LLM calls or actual compaction performed (deferred to Story 2.2)

## File List

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Added validation logic: getMessage(), normalizeRanges(), validateSingleRange(), validateNoOverlaps(), updated execute() |
| `packages/opencode/src/tool/compact.txt` | Updated description to explain validation rules and behavior |
| `packages/opencode/test/tool/compact-retrieve.test.ts` | Updated sessionID to "ses_test", updated stub test to expect validation error, added 4 new validation tests |
| `packages/opencode/test/tool/compact-validation.test.ts` | New file: 8 comprehensive tests with real session data (added toolCallID to all ctx objects for consistency) |
| `docs/sprint-artifacts/sprint-status.yaml` | Updated story status: ready-for-dev → in-progress → review |
| `docs/sprint-artifacts/2-1-compact-tool-basic-structure.md` | Updated: marked tasks complete, added Dev Agent Record, File List, Change Log |

## Change Log

- 2025-12-14: Implemented compact tool validation (Story 2.1)
  - Added message lookup helper with clear error messages
  - Added range normalization for single-message ranges
  - Added chronological order validation
  - Added archive status validation (start/end only, per spec)
  - Added overlap detection for multi-range requests
  - Updated tool description
  - Added comprehensive test coverage (11 new tests total)
  - All tests pass (244 pass, 1 skip, 0 fail)

- 2025-12-14: Code review fixes applied
  - Fixed: Removed invalid Zod v4 `invalid_type_error` option from array schema (TypeScript error)
  - Fixed: Improved archive anchor error message to distinguish from archivedBy messages
  - Fixed: Simplified redundant overlap check logic (removed duplicate condition)
  - Fixed: Improved test error pattern matching to be more precise
  - Fixed: Renamed misleading test to accurately describe its behavior
  - All 20 compact tests pass

- 2025-12-14: Second code review fixes applied
  - Fixed: Staged untracked compact-validation.test.ts (was ?? in git status)
  - Fixed: Added toolCallID to all test context objects for consistency with compact-retrieve.test.ts
  - Added: New test "rejects range with no messages between start and end" for additional coverage
  - Updated: File List table to properly document compact-validation.test.ts
  - All 21 compact tests pass (245 total)

- 2025-12-15: Third code review fixes applied
  - Deleted: Misleading test "rejects range with no messages between start and end" - name didn't match behavior, actual behavior already covered by multi-range test
  - Fixed: Simplified getMessage() to use `.catch(() => null)` pattern instead of fragile string matching on error messages
  - Stashed: Unrelated AGENTS.md documentation changes
  - All 244 tests pass (244 total, 1 skip, 0 fail)

---

_Story created by: /bmad:bmm:workflows:create-story_
_Model: Claude Opus 4.5_
_Date: 2025-12-13_
_Analysis depth: Deep codebase examination with actual file reading_
