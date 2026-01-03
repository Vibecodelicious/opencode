# Story 2.7: Data Integrity and Persistence Guarantees

Status: Done

## Story

As a user,
I want archived content to be reliably preserved,
So that I never lose data due to compaction.

## Acceptance Criteria

1. **Archive Metadata Persistence Across Resume (FR21)**
   - Given content has been archived
   - When the session is resumed later
   - Then archive metadata is correctly loaded
   - And original content is still accessible
   - And placeholders render correctly

2. **Crash Recovery - Complete or Nothing**
   - Given a system crash during compaction
   - When the session is recovered
   - Then either:
     - Compaction completed fully (all metadata saved), OR
     - Compaction did not happen (no partial state)
   - And no orphaned `archivedBy` references exist without a valid anchor

3. **Data Integrity Over Time (FR22)**
   - Given archived content
   - When time passes and sessions are resumed multiple times
   - Then archived content maintains integrity indefinitely
   - And no data corruption occurs during storage operations
   - And original message `parts[]` content remains unchanged

4. **Valid Placeholder References (NFR7)**
   - Given messages with `archivedBy` fields
   - When rendering context via `toModelMessage()`
   - Then each `archivedBy` points to a message with valid `archive` field
   - And no broken references cause rendering errors

5. **Atomic Storage Boundary Verification**
   - Given the existing `storeArchiveMetadata()` function
   - When reviewing/testing its behavior
   - Then verify `Storage.update()` provides per-message atomicity
   - And file locking prevents corruption from concurrent writes
   - And partial range failures are handled gracefully (already implemented in Story 2.3)

## Tasks / Subtasks

- [x] Task 1 (AC: 1, 3): Create session resume persistence tests
  - [x] Subtask 1.1: Write test that archives messages, then reloads session and verifies metadata
  - [x] Subtask 1.2: Test that original `parts[]` content is unchanged after archive
  - [x] Subtask 1.3: Test multiple resume cycles don't corrupt data
  - [x] Subtask 1.4: Test placeholder rendering works after session resume

- [x] Task 2 (AC: 2): Test crash recovery scenarios
  - [x] Subtask 2.1: Research how to simulate mid-operation failures in tests
  - [x] Subtask 2.2: Test that `Storage.update()` failures leave no partial state on single message
  - [x] Subtask 2.3: Test that a range with mid-range failure has valid anchor with corrected `rangeEnd`
  - [x] Subtask 2.4: Test that orphaned `archivedBy` references are handled gracefully if anchor is missing

- [x] Task 3 (AC: 4): Implement reference validation
  - [x] Subtask 3.1: Add `validateArchiveReferences()` function to check `archivedBy` → `archive` consistency
  - [x] Subtask 3.2: Integrate validation into session load or provide as utility function
  - [x] Subtask 3.3: Handle broken references gracefully (log warning, treat as unarchived)
  - [x] Subtask 3.4: Test orphan detection and graceful handling

- [x] Task 4 (AC: 5): Document and verify Storage.update() atomicity guarantees
  - [x] Subtask 4.1: Review `Storage.update()` implementation in storage.ts
  - [x] Subtask 4.2: Verify file locking behavior with concurrent operations
  - [x] Subtask 4.3: Add integration test with concurrent archive operations
  - [x] Subtask 4.4: Document atomicity guarantees in code comments

- [x] Task 5: Integration testing
  - [x] Subtask 5.1: End-to-end test: archive → resume → verify → archive more → resume
  - [x] Subtask 5.2: Test with large message ranges (10+ messages)
  - [x] Subtask 5.3: Verify all existing tests still pass

## Technical Deep Dive

### Current State Analysis

**Story 2.3 already implemented:**
- `storeArchiveMetadata()` with per-message atomicity via `Storage.update()`
- Race condition protection (skip already-archived messages)
- Anchor promotion when first message is pre-archived
- RangeEnd correction on mid-range failures
- Comprehensive test coverage (24 tests in `compact-archival.test.ts`)

**What Story 2.7 adds:**
- Persistence verification across actual session resume (not just reload)
- Reference validation to catch orphaned `archivedBy` pointers
- Explicit crash recovery testing
- Documentation of atomicity guarantees

### Storage.update() Implementation (storage.ts:178-188)

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

**Atomicity guarantees:**
- `Lock.write(target)` provides exclusive file lock
- Read-modify-write happens under lock
- `Bun.write()` is atomic (writes to temp file, then renames)
- If process crashes mid-operation, file remains in pre-update state

### Crash Recovery Scenarios

| Scenario | Expected Outcome | Test Approach |
|----------|------------------|---------------|
| Crash before any `Storage.update()` | No archival occurred | Mock failure before first update |
| Crash after anchor update, before subsequent | Anchor exists with partial range | Mock failure after first, verify rangeEnd |
| Crash during `Storage.update()` | File unchanged (atomic write) | Hard to test - rely on Bun.write guarantees |
| Process killed between messages | Some messages archived, others not | Test sequential failures |

### Reference Validation Design

```typescript
// In compact.ts or session/message-v2.ts

interface ReferenceValidationResult {
  valid: boolean
  orphanedMessages: string[]  // Messages with archivedBy but no valid anchor
  brokenAnchors: string[]     // Anchors with rangeEnd pointing to non-existent message
}

async function validateArchiveReferences(sessionID: string): Promise<ReferenceValidationResult> {
  const messages = await Session.messages({ sessionID })
  const archiveAnchors = new Map<string, MessageV2.Archive>()
  const orphaned: string[] = []
  const brokenAnchors: string[] = []

  // First pass: collect all anchors
  for (const msg of messages) {
    if (msg.info.archive) {
      archiveAnchors.set(msg.info.id, msg.info.archive)
    }
  }

  // Second pass: validate archivedBy references
  for (const msg of messages) {
    if (msg.info.archivedBy) {
      if (!archiveAnchors.has(msg.info.archivedBy)) {
        orphaned.push(msg.info.id)
      }
    }
  }

  // Third pass: validate rangeEnd references
  const messageIds = new Set(messages.map(m => m.info.id))
  for (const [anchorId, archive] of archiveAnchors) {
    if (archive.rangeEnd && !messageIds.has(archive.rangeEnd)) {
      brokenAnchors.push(anchorId)
    }
  }

  return {
    valid: orphaned.length === 0 && brokenAnchors.length === 0,
    orphanedMessages: orphaned,
    brokenAnchors,
  }
}
```

### Graceful Handling of Broken References

In `toModelMessage()`, if `archivedBy` points to a message without `archive`:
- Log warning: "Orphaned archivedBy reference detected"
- Render the message normally (treat as not archived)
- Don't crash or throw

## Previous Story Intelligence

### Story 2.3 (Archive Metadata Storage) - Key Learnings

**Race condition handling:**
- Pre-check: skip messages already archived in input data (avoids I/O)
- Inside lock: check again for concurrent archival
- Anchor promotion: if first message archived by concurrent op, next unarchived becomes anchor

**RangeEnd correction patterns:**
- After normal archival: correct if actual last differs from intended
- After mid-range failure: correct to actual last archived message
- Ownership verification: only correct if summary matches (prevents overwriting concurrent ops)

**Atomicity boundary:** Per-message, not per-batch. Partial success is acceptable.

**Test patterns established:**
- Use `Storage.get()` to verify persistence
- Create mock summaries with known content
- Verify both `archive` and `archivedBy` fields after operations

### Story 2.6 (LLM Autonomous Compaction) - Key Learnings

**Documentation-focused story:** Primarily about tool description quality
- Actual code changes minimal (compact.txt only)
- Testing is manual/behavioral

**Code review improvements:**
- "Learnings captured" vs "already read" distinction for compaction justification
- CRITICAL section about verifying learnings are preserved

### Git Commit Patterns

Recent commits show the pattern:
```
feat(compact): <action description> (Story X.Y)

<Why this matters for the compaction system>
<What was done>
<Testing notes>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## Implementation Guide

### Step 1: Create Persistence Test Suite

Create `packages/opencode/test/tool/compact-persistence.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { storeArchiveMetadata } from "../../src/tool/compact"

describe("archive persistence", () => {
  let sessionID: string

  beforeEach(async () => {
    // Create test session with messages
    sessionID = `ses_persist_test_${Date.now()}`
    // ... setup messages
  })

  afterEach(async () => {
    // Cleanup
  })

  test("archive metadata persists across session resume", async () => {
    // 1. Archive messages
    // 2. Clear any in-memory caches
    // 3. Reload session via Session.messages()
    // 4. Verify archive/archivedBy fields present
    // 5. Verify placeholder renders correctly
  })

  test("original parts content unchanged after archival", async () => {
    // 1. Record original parts content
    // 2. Archive messages
    // 3. Reload and compare parts - should be identical
  })

  test("multiple resume cycles don't corrupt data", async () => {
    // 1. Archive
    // 2. Resume, verify
    // 3. Resume again, verify still correct
    // 4. Archive more content
    // 5. Resume, verify all archives correct
  })
})
```

### Step 2: Add Reference Validation

Add to `packages/opencode/src/tool/compact.ts` or create new file:

```typescript
export async function validateArchiveReferences(sessionID: string): Promise<{
  valid: boolean
  orphaned: string[]
  broken: string[]
}> {
  // Implementation per design above
}
```

### Step 3: Update toModelMessage() for Graceful Handling

In `message-v2.ts`, the current code:
```typescript
if (msg.info.archivedBy) continue  // Skip subsequent messages
```

Should become:
```typescript
if (msg.info.archivedBy) {
  // Validate anchor exists before skipping
  const anchor = messages.find(m => m.info.id === msg.info.archivedBy)
  if (!anchor?.info.archive) {
    log.warn("orphaned archivedBy reference, rendering normally", { messageID: msg.info.id, archivedBy: msg.info.archivedBy })
    // Fall through to normal rendering
  } else {
    continue  // Skip - anchor will render placeholder
  }
}
```

### Step 4: Document Atomicity Guarantees

Add JSDoc to `storeArchiveMetadata()`:
```typescript
/**
 * ## Atomicity Guarantees
 *
 * This function provides the following guarantees:
 *
 * 1. **Per-message atomicity**: Each message update via Storage.update() is atomic.
 *    The file is read, modified, and written under an exclusive lock. If the process
 *    crashes during write, Bun's atomic write (temp file + rename) ensures the file
 *    remains in its pre-update state.
 *
 * 2. **Partial range success**: If a range fails mid-way, messages already archived
 *    remain archived. The anchor's rangeEnd is corrected to the actual last archived
 *    message, ensuring no orphaned archivedBy references.
 *
 * 3. **Crash recovery**: On crash, the worst case is:
 *    - Some messages in a range are archived, others aren't
 *    - The anchor's rangeEnd may be incorrect (will be corrected on next archive attempt)
 *    - Original content is NEVER lost (we only add metadata, never modify parts[])
 */
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add `validateArchiveReferences()`, update JSDoc with atomicity guarantees |
| `packages/opencode/src/session/message-v2.ts` | Add graceful handling for orphaned `archivedBy` in `toModelMessage()` |
| `packages/opencode/test/tool/compact-persistence.test.ts` | NEW: Persistence and crash recovery tests |

## Definition of Done

- [x] Archive metadata persists correctly across session resume
- [x] Original message content verified unchanged after archival
- [x] Reference validation function implemented
- [x] Orphaned `archivedBy` references handled gracefully (log + render normally)
- [x] Crash recovery scenarios tested (partial archival leaves consistent state)
- [x] Atomicity guarantees documented in code
- [x] All existing tests pass (no regressions)
- [x] New persistence tests pass

## Risk Notes

1. **Testing actual crashes is hard:** We can test Storage.update() failure handling, but testing actual process crashes requires external tooling. Rely on Bun's atomic write guarantees.

2. **Orphan cleanup not implemented:** Story focuses on detection and graceful handling, not automatic cleanup. Orphan cleanup could be a future enhancement.

3. **Design Decision - Utility Function Only:** `validateArchiveReferences()` is provided as an exported utility function rather than being integrated into automatic session load. This avoids performance overhead on every session load while still providing the capability for explicit validation when needed (e.g., after crash recovery, debugging). The graceful handling in `toModelMessage()` ensures orphans don't cause runtime errors.

4. **Large session performance:** Loading all messages to validate references could be slow for very large sessions. Consider lazy validation or batch processing for Growth phase.

5. **Lock contention:** High-frequency concurrent archival could cause lock contention. Current per-message locking is fine for MVP; consider batch locking for Growth.

## References

- Architecture: Archive Storage Design (docs/architecture.md:149-176)
- Architecture: Atomic Storage Operations (docs/architecture.md:NFR5-NFR8)
- PRD: FR21 (archive persists across resume), FR22 (archive maintains integrity), NFR7 (valid references), NFR8 (atomic operations)
- Story 2.3: Archive Metadata Storage (docs/sprint-artifacts/2-3-archive-metadata-storage.md) - foundation for this work
- Storage implementation: packages/opencode/src/storage/storage.ts:178-188
- Project Context: Testing standards (docs/project-context.md)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

N/A - No debugging required. Implementation was straightforward.

### Completion Notes List

1. All 5 Acceptance Criteria verified with comprehensive tests
2. Added `validateArchiveReferences()` function for detecting orphaned references
3. Modified `toModelMessage()` to gracefully handle orphaned `archivedBy` references
4. Added detailed atomicity guarantees documentation to `storeArchiveMetadata()`
5. Created new test file `compact-persistence.test.ts` with 21 tests
6. All tests pass (21 new + existing)

### File List

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/opencode/src/tool/compact.ts` | Modified | Added `validateArchiveReferences()` with large session warning (>1000 msgs), added detailed atomicity guarantees documentation with simplified @see reference |
| `packages/opencode/src/session/message-v2.ts` | Modified | Updated `toModelMessage()` to gracefully handle orphaned `archivedBy` references with warning logging |
| `packages/opencode/test/tool/compact-persistence.test.ts` | Added | New test file with 21 tests covering persistence, reference validation, orphan handling, crash recovery, and concurrent archive operations |

### Change Log

| Date | Change | By |
|------|--------|-----|
| 2025-12-31 | Implemented all 5 tasks for Story 2.7 | Claude Opus 4.5 |
| 2026-01-02 | Code review fixes: corrected test counts (16 not 11), added orphan detection logging to toModelMessage(), added design decision note for utility function approach | Claude Opus 4.5 |
| 2026-01-02 | Adversarial code review fixes: added 2 concurrent integration tests (Task 4.3), cleaned up type import confusion, added error handling for non-existent session in validateArchiveReferences(), added @see link to atomicity docs | Claude Opus 4.5 |
| 2026-01-02 | Final code review polish: added error cause to thrown error in validateArchiveReferences(), removed stale line numbers from @see link, reduced log noise (warn→debug) for orphan detection in toModelMessage(), added 2 edge case tests (empty session, invalid archive+archivedBy state), strengthened concurrent overlap test assertions | Claude Opus 4.5 |
| 2026-01-02 | Adversarial code review: further strengthened concurrent overlap test with per-message state verification (isArchived, hasConflict checks, archival chain integrity) | Claude Opus 4.5 |
| 2026-01-02 | Code review fixes: fixed @see link format in JSDoc, added large session warning (>1000 msgs), cleaned up type import naming (MessageV2Info), added non-existent session edge case test, fixed misleading test name | Claude Opus 4.5 |
| 2026-01-03 | Final code review fixes: corrected misleading JSDoc @throws (Session.messages never throws), removed dead try/catch code path, strengthened non-existent session test with explicit verification, renamed MessageV2Info→MessageV2Types for clarity | Claude Opus 4.5 |

---

_Story created by: /bmad:bmm:workflows:create-story_
_Model: Claude Opus 4.5_
_Date: 2025-12-31_
_Analysis depth: Deep codebase examination with actual file reading_
