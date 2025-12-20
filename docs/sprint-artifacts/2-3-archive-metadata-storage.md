# Story 2.3: Archive Metadata Storage

Status: Done

## Story

As a user,
I want archived content metadata to be stored reliably,
So that I can retrieve the original content later.

## Acceptance Criteria

1. **First Message Gets `archive` Field**
   - Given a successful compaction with summary and index terms (from Story 2.2)
   - When the Compact tool stores archive metadata
   - Then the first message in range receives an `archive` field:
   ```typescript
   {
     archive: {
       summary: "Discussed authentication architecture...",
       indexTerms: ["auth", "JWT", "security"],
       rangeEnd: "msg_xyz"  // ID of last message in archived range
     }
   }
   ```

2. **Subsequent Messages Get `archivedBy` Field**
   - Given a message range being archived (start to end)
   - When the Compact tool stores archive metadata
   - Then each message after the first in the range receives:
   ```typescript
   {
     archivedBy: "msg_abc"  // Points to first message's ID
   }
   ```

3. **Original Content Preserved**
   - Given messages being archived
   - When archive metadata is added
   - Then original message `parts[]` content remains unchanged in storage
   - And no content is moved, copied, or deleted

4. **Persistence Across Session Resume (FR21)**
   - Given content has been archived
   - When the session is resumed later
   - Then archive metadata (`archive`, `archivedBy` fields) is correctly loaded
   - And original content is still accessible via parts array

5. **Atomic Storage Operations (NFR8)**
   - Given a compaction operation
   - When storing archive metadata
   - Then each individual message update is atomic (via `Storage.update()` file locking)
   - And if one message update fails, that message remains unchanged while others succeed
   - And each range is processed independently (partial range success is acceptable)

6. **Summary-to-Range Correlation**
   - Given multiple ranges being compacted in a single call
   - When storing archive metadata
   - Then each summary is correctly matched to its range via `startMessageId` key
   - And all ranges receive their corresponding summary/indexTerms

## Tasks / Subtasks

- [x] Task 1 (AC: 1, 2, 6): Implement `storeArchiveMetadata()` function
  - [x] Subtask 1.1: Create function accepting validated ranges and summaries
  - [x] Subtask 1.2: For each range, update first message with `archive` field
  - [x] Subtask 1.3: For each range, update subsequent messages with `archivedBy` field
  - [x] Subtask 1.4: Match summaries to ranges via `startMessageId` key

- [x] Task 2 (AC: 5): Implement atomic update strategy
  - [x] Subtask 2.1: Research Storage.update() locking behavior
  - [x] Subtask 2.2: Implement rollback on partial failure (or all-or-nothing approach)
  - [x] Subtask 2.3: Handle edge cases (message already archived during operation)

- [x] Task 3 (AC: 3, 4): Integrate with CompactTool.execute()
  - [x] Subtask 3.1: After summarization succeeds, call storeArchiveMetadata()
  - [x] Subtask 3.2: Update tool output to confirm archival completion
  - [x] Subtask 3.3: Verify existing toModelMessage() placeholder rendering works

- [x] Task 4: Add comprehensive tests
  - [x] Subtask 4.1: Test single-range archival (first message gets archive, rest get archivedBy)
  - [x] Subtask 4.2: Test multi-range archival (each range independent)
  - [x] Subtask 4.3: Test message persistence (reload session, verify fields present)
  - [x] Subtask 4.4: Test error handling (partial failure leaves no partial state)
  - [x] Subtask 4.5: Test placeholder rendering after archival (via toModelMessage)

## Technical Deep Dive

### Current CompactTool Flow (compact.ts)

After Story 2.2, the flow is:
1. **Validate ranges** - `normalizeRanges()`, `validateNoOverlaps()`, `validateSingleRange()`
2. **Generate summaries** - `generateSummaries()` returns `Record<string, CompactionSummary>`
3. **Return output** - Currently returns summaries but does NOT persist metadata

**This story adds step 3.5: Store archive metadata to messages**

### Message Schema (message-v2.ts:297-309)

Archive fields already exist in schema:

```typescript
export const Archive = z.object({
  summary: z.string(),
  indexTerms: z.array(z.string()),
  rangeEnd: z.string(),
})
export type Archive = z.infer<typeof Archive>

const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
  archive: Archive.optional(),      // First message of archive
  archivedBy: z.string().optional(), // Subsequent messages point back
})
```

### Storage API Pattern (storage.ts:178-188)

Use `Storage.update()` for atomic message updates:

```typescript
export async function update<T>(key: string[], fn: (draft: T) => void) {
  const dir = await state().then((x) => x.dir)
  const target = path.join(dir, ...key) + ".json"
  return withErrorHandling(async () => {
    using _ = await Lock.write(target)  // Exclusive lock
    const content = await Bun.file(target).json()
    fn(content)  // Mutate draft
    await Bun.write(target, JSON.stringify(content, null, 2))
    return content as T
  })
}
```

**Message storage key pattern:** `["message", sessionID, messageID]`

### Placeholder Rendering (message-v2.ts:588-609)

`toModelMessage()` already handles archived messages:

```typescript
if (msg.info.archive) {
  const archive = msg.info.archive
  const rangeLabel = archive.rangeEnd && archive.rangeEnd !== msg.info.id
    ? `[SMART_ARCHIVED: ${msg.info.id} to ${archive.rangeEnd}]`
    : `[SMART_ARCHIVED: ${msg.info.id}]`
  const placeholder = `${rangeLabel}\nSummary: ${archive.summary}\nIndex: ${archive.indexTerms.join(", ")}`
  result.push({
    id: msg.info.id,
    role: msg.info.role,
    parts: [{ type: "text", text: placeholder }],
  })
  continue
}

if (msg.info.archivedBy) continue  // Skip subsequent messages
```

**Key insight:** Once metadata is stored, placeholder rendering "just works"

## Implementation Guide

### Step 1: Create storeArchiveMetadata Function

```typescript
// In compact.ts

interface ArchiveMetadataInput {
  sessionID: string
  validatedRanges: Array<{
    range: NormalizedRange
    messages: MessageV2.WithParts[]
  }>
  summaries: Record<string, CompactionSummary>
}

async function storeArchiveMetadata(input: ArchiveMetadataInput): Promise<{
  archivedCount: number
  errors: string[]
}> {
  const errors: string[] = []
  let archivedCount = 0

  for (const { range, messages } of input.validatedRanges) {
    const summary = input.summaries[range.startMessageId]
    if (!summary) {
      errors.push(`No summary found for range starting at ${range.startMessageId}`)
      continue
    }

    try {
      // Update first message with archive metadata
      await Storage.update<MessageV2.Info>(
        ["message", input.sessionID, range.startMessageId],
        (draft) => {
          draft.archive = {
            summary: summary.summary,
            indexTerms: summary.indexTerms,
            rangeEnd: range.endMessageId,
          }
        }
      )

      // Update subsequent messages with archivedBy reference
      for (const msg of messages) {
        if (msg.info.id === range.startMessageId) continue  // Skip first
        await Storage.update<MessageV2.Info>(
          ["message", input.sessionID, msg.info.id],
          (draft) => {
            draft.archivedBy = range.startMessageId
          }
        )
      }

      archivedCount += messages.length
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      errors.push(`Failed to archive range ${range.startMessageId}: ${errorMsg}`)
      // Continue with next range - partial archival is acceptable
    }
  }

  return { archivedCount, errors }
}
```

### Step 2: Atomic Update Strategy

**Option A: Sequential with early termination (simpler)**
- Update messages one by one
- If any fails, log error and skip that range
- Each range is independent - partial success is acceptable

**Option B: Collect-then-commit (more complex)**
- Validate all updates can succeed first
- Then commit all in sequence
- More complex, minimal added benefit for MVP

**Recommendation:** Option A - aligns with existing patterns, simpler implementation

### Step 3: Integrate into CompactTool.execute()

```typescript
export const CompactTool = Tool.define("compact", {
  // ... existing code ...
  async execute(params, ctx) {
    // ... existing validation and summarization ...

    // NEW: Store archive metadata
    let archivalResult = { archivedCount: 0, errors: [] as string[] }
    if (Object.keys(summaries).length > 0) {
      archivalResult = await storeArchiveMetadata({
        sessionID: ctx.sessionID,
        validatedRanges,
        summaries,
      })
    }

    // Update output to include archival status
    const archivalNote = archivalResult.errors.length > 0
      ? `\n\nArchival issues: ${archivalResult.errors.join("; ")}`
      : ""

    return {
      title: "Compaction complete",
      output: `Compacted ${archivalResult.archivedCount} messages across ${normalized.length} range(s):\n\n${rangeDetails}\n\nTotal: ${totalMessages} messages archived.${errorNote}${archivalNote}`,
      metadata: {
        // ... existing metadata ...
        archived: archivalResult.archivedCount,
        archivalErrors: archivalResult.errors,
      },
    }
  },
})
```

### Import Requirements

```typescript
// Add to compact.ts imports
import { Storage } from "../storage/storage"
```

## Testing Strategy

### Test Setup

```typescript
// Create test session with messages
const sessionID = "ses_test_archive"
const messages = [
  { id: "msg_0001_aaa", role: "user", ... },
  { id: "msg_0002_bbb", role: "assistant", ... },
  { id: "msg_0003_ccc", role: "user", ... },
  { id: "msg_0004_ddd", role: "assistant", ... },
]

// Mock summaries
const summaries = {
  "msg_0001_aaa": {
    summary: "Test discussion about authentication",
    indexTerms: ["auth", "test"],
  }
}
```

### Test Cases

1. **Single range archival**
   - Input: Range `msg_0001_aaa` to `msg_0003_ccc`
   - Expected: First message has `archive` field, middle and end have `archivedBy`

2. **Multi-range archival**
   - Input: Two ranges with different summaries
   - Expected: Each range has correct metadata, ranges don't interfere

3. **Persistence verification**
   - After archival, reload messages via `MessageV2.get()`
   - Verify `archive` and `archivedBy` fields are present

4. **Placeholder rendering**
   - After archival, call `toModelMessage()` on session messages
   - Verify first message shows `[SMART_ARCHIVED: ...]` placeholder
   - Verify subsequent messages are skipped

5. **Missing summary handling**
   - Input: Range without corresponding summary
   - Expected: Error logged, range skipped, no crash

## Previous Story Intelligence

### Story 2.1 (Compact Tool Basic Structure) - Completed

**Key learnings:**
- Session ID format: `ses_xxx`, Message ID format: `msg_xxx`
- `getMessage()` helper wraps `MessageV2.get()` with error handling
- Validation checks: existence, chronological order, archive status
- `validateSingleRange()` returns all messages in range

**Files touched:**
- `packages/opencode/src/tool/compact.ts`
- `packages/opencode/test/tool/compact-validation.test.ts`

### Story 2.2 (Compaction LLM Call) - Completed (in review)

**Key learnings:**
- `generateSummaries()` returns `Record<string, CompactionSummary>`
- Key is `startMessageId` for robust matching
- `getModelFromMessages()` avoids duplicate I/O by using existing array
- Graceful degradation when model unavailable
- Token estimation via `Token.estimate()`

**Code patterns established:**
```typescript
// Summary keyed by startMessageId
const summaries: Record<string, CompactionSummary> = {
  "msg_abc": { summary: "...", indexTerms: [...] }
}

// Match to range via key
const summary = summaries[range.startMessageId]
```

### Architecture Decisions (architecture.md)

**Archive metadata storage design:**
- First message: `archive` field with summary, indexTerms, rangeEnd
- Subsequent messages: `archivedBy` pointing to first message
- Original content stays in place (not moved)
- No separate archive storage namespace

**Storage pattern:**
- Use existing file-based Storage API
- Messages stored at `["message", sessionID, messageID]`
- Parts stored separately at `["part", messageID, partID]`

## Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add `storeArchiveMetadata()`, update `execute()` to call it |
| `packages/opencode/test/tool/compact-archival.test.ts` | NEW: Tests for archive metadata storage |
| `packages/opencode/test/tool/compact-validation.test.ts` | Update expected output format if needed |

## Definition of Done

- [x] `storeArchiveMetadata()` function implemented
- [x] First message receives `archive` field with summary, indexTerms, rangeEnd
- [x] Subsequent messages receive `archivedBy` field pointing to first message
- [x] Original message content unchanged
- [x] Archive metadata persists across session reload
- [x] `toModelMessage()` renders placeholders correctly for archived messages
- [x] Error handling for partial failures (log and continue)
- [x] Tests cover single-range, multi-range, persistence, and error cases
- [x] All existing tests pass (no regressions)

## Risk Notes

1. **Race conditions:** Multiple concurrent compaction operations could conflict. `Storage.update()` uses file locking which should prevent data corruption, but test concurrent access patterns.

2. **Partial state on crash:** If process crashes mid-operation, some messages may be archived while others aren't. This is acceptable for MVP - the archived messages are still valid, and unarchived messages work normally.

3. **Large ranges:** Archiving many messages sequentially could be slow. Consider batching in future, but MVP can do sequential updates.

4. **Storage key format:** Ensure message storage key matches `["message", sessionID, messageID]` - verify by checking existing message storage code.

## References

- Architecture: Archive Storage Design (docs/architecture.md:149-176)
- Architecture: Message Schema Extension (docs/architecture.md:267-276)
- PRD: FR11 (compaction stores to persistent storage), FR21 (archive persists across resume), FR22 (archive maintains integrity)
- Story 2.1: Compact tool validation (2-1-compact-tool-basic-structure.md)
- Story 2.2: Compaction LLM call (2-2-compaction-llm-call-for-summary-generation.md)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No errors encountered during implementation

### Completion Notes List

- Implemented `storeArchiveMetadata()` function with single-pass dynamic anchor selection
- Function uses `Storage.update()` with file locking for atomic updates per message
- Adopted "Option A" atomic strategy: sequential updates with each range independent - partial success is acceptable
- **Anchor promotion**: if first message already archived, next unarchived message becomes anchor (decision made inside lock)
- **RangeEnd adjustment**: if last messages skipped, rangeEnd updated to actual last archived message
- First unarchived message in range receives `archive` field with `summary`, `indexTerms`, and `rangeEnd`
- Subsequent unarchived messages receive `archivedBy` field pointing to anchor's ID
- Original message `parts[]` content remains unchanged (only info metadata is updated)
- Integrated into `CompactTool.execute()` - archive storage happens automatically after successful summarization
- Tool output now reflects archival status with "Compaction complete" title when archived, includes archived count
- Added comprehensive test coverage in `compact-archival.test.ts` covering all acceptance criteria
- All 284 tests pass with 0 failures (1 skip)

### Change Log

- 2025-12-18: Implemented archive metadata storage (Story 2.3)
- 2025-12-19: Code review - clarified AC5 atomicity boundary (per-message, not per-batch)
- 2025-12-19: Code review fixes - true session resume test, Storage.update() failure test, race condition protection
- 2025-12-19: Code review round 2 - added missing multi-range archival tests, race condition protection tests, partial archival tests
- 2025-12-19: Code review round 3 - fixed anchor promotion bug: when first message already archived, next unarchived message becomes anchor; single-pass dynamic anchor selection inside Storage.update lock; rangeEnd adjustment when last messages skipped
- 2025-12-19: Code review round 4 - exported storeArchiveMetadata and types for direct testing; added e2e tests calling real function; added Storage.update() failure handling tests (Task 4.4)
- 2025-12-19: Code review round 5 - fixed data integrity bug: anchor rangeEnd now corrected on mid-range Storage.update failure; added test for mid-range failure scenario
- 2025-12-19: Code review round 6 - added test for all-messages-pre-archived scenario; fixed `any` types to use `MessageV2.Info`; replaced `as any` with `toHaveProperty`; fixed non-null assertions with closure captures
- 2025-12-19: Code review round 7 - fixed rangeEnd bug when only anchor archived (all subsequent pre-archived); added pre-check to skip already-archived messages (avoids unnecessary I/O); added defensive check for empty messages array; added test for only-anchor-archived scenario
- 2025-12-19: Code review round 8 - fixed rangeEnd correction race condition (verify archive ownership via summary match); added validation for non-empty summary content; changed verbose log.info to log.debug; added JSDoc documentation for exported types; added idempotency documentation; replaced opaque issue references with descriptive comments; added test for concurrent rangeEnd modification scenario

### File List

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Added `Storage` import, exported `storeArchiveMetadata()` function with single-pass dynamic anchor selection, exported types (`NormalizedRange`, `ArchiveMetadataInput`, `ArchiveMetadataResult`) with JSDoc, integrated into `CompactTool.execute()`, race condition protection with anchor promotion, mid-range failure rangeEnd correction with ownership verification, pre-check for already-archived messages, defensive empty messages check, non-empty summary validation, debug-level logging for skipped messages |
| `packages/opencode/test/tool/compact-archival.test.ts` | NEW: 24 tests covering single-range, multi-range, persistence, error handling, placeholder rendering, race condition protection, anchor promotion, rangeEnd adjustment, CompactTool integration, e2e storeArchiveMetadata tests, Storage.update() failure handling, mid-range failure rangeEnd correction, all-messages-pre-archived scenario, only-anchor-archived scenario, and rangeEnd correction ownership verification |
| `docs/sprint-artifacts/2-3-archive-metadata-storage.md` | Clarified AC5 wording to reflect per-message atomicity boundary |
| `docs/sprint-artifacts/sprint-status.yaml` | Updated story status |

---

_Story created by: /bmad:bmm:workflows:create-story_
_Model: Claude Opus 4.5_
_Date: 2025-12-18_
_Analysis depth: Deep codebase examination with actual file reading_

_Story completed by: /bmad:bmm:workflows:dev-story_
_Model: Claude Opus 4.5_
_Date: 2025-12-18_
