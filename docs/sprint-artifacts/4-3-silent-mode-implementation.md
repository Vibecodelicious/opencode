# Story 4.3: Silent Mode Implementation

Status: Done

## Story

As a user in "silent" mode,
I want the LLM to compact without any notification,
So that my workflow is completely uninterrupted.

## Acceptance Criteria

1. **Mode Detection**
   - Given compaction mode is set to "silent" in config
   - When the LLM executes compaction
   - Then the tool detects the mode and proceeds without prompts

2. **Minimal Tool Output**
   - Given mode is "silent"
   - When compaction completes successfully
   - Then the tool returns:
     - Empty output string (no text for LLM to present to user)
     - Full metadata for internal tracking (summaries, counts, errors)
     - Title indicating completion status

3. **LLM Does Not Mention Compaction**
   - Given mode is "silent"
   - When the LLM receives the tool result
   - Then the LLM does NOT mention the compaction to the user
   - And the LLM continues with its response as if compaction didn't happen

4. **Logging for Audit/Debugging**
   - Given silent mode compaction completes
   - When the tool finishes execution
   - Then compaction is logged for debugging purposes
   - And logs include: ranges archived, token counts, success/failure

5. **Placeholder Visibility**
   - Given content has been silently archived
   - When the user scrolls back in conversation history
   - Then they see `[SMART_ARCHIVED]` placeholders (same as other modes)
   - And placeholders include summary and index terms for retrieval

## Tasks / Subtasks

- [x] Task 1 (AC: 1, 2): Verify silent mode implementation in CompactTool
  - [x] Subtask 1.1: Confirm silent mode code path exists (compact.ts:811-826)
  - [x] Subtask 1.2: Verify output is empty string (`output: ""`)
  - [x] Subtask 1.3: Verify metadata is fully populated (same as other modes)
  - [x] Subtask 1.4: Add explicit test for silent mode output structure

- [x] Task 2 (AC: 3): Add SILENT MODE BEHAVIOR section to compact.txt
  - [x] Subtask 2.1: Add dedicated section explaining LLM behavior in silent mode
  - [x] Subtask 2.2: Document that LLM must NOT mention compaction to user
  - [x] Subtask 2.3: Provide example of correct silent mode LLM response
  - [x] Subtask 2.4: Add guidance for edge cases (errors in silent mode)

- [x] Task 3 (AC: 4): Verify logging coverage
  - [x] Subtask 3.1: Review existing log statements in silent mode path
  - [x] Subtask 3.2: Add log.info for silent mode execution if missing
  - [x] Subtask 3.3: Ensure logs include: mode, ranges, token counts, result

- [x] Task 4 (AC: 5): Verify placeholder behavior (should already work)
  - [x] Subtask 4.1: Confirm placeholders render same as other modes
  - [x] Subtask 4.2: Document in story that placeholder behavior is mode-independent

- [x] Task 5: Testing
  - [x] Subtask 5.1: Create compact-silent-mode.test.ts with dedicated silent mode tests
  - [x] Subtask 5.2: Test that Permission.ask is NOT called in silent mode
  - [x] Subtask 5.3: Test that output is empty string
  - [x] Subtask 5.4: Test that metadata is fully populated
  - [x] Subtask 5.5: Verify all existing tests pass (no regressions)

## Dev Notes

### Current State Analysis

**compact.ts (lines 810-826) - Silent Mode Already Implemented:**
```typescript
// SILENT MODE: Return minimal output - user configured to not see compaction details
if (compactionMode === "silent") {
  return {
    title: archived ? "Compaction complete" : "Compaction ready",
    output: "", // Silent mode: no output text for LLM to present
    metadata: {
      rangeCount: normalized.length,
      totalMessages,
      totalTokens,
      summaries,
      archived: archivalResult.archivedCount,
      ...(archivalResult.skippedCount > 0 && { skipped: archivalResult.skippedCount }),
      ...(archivalResult.errors.length > 0 && { archivalErrors: archivalResult.errors }),
      ...(summarizationError && { error: summarizationError }),
    },
  }
}
```

**Observation:** The core silent mode behavior is ALREADY implemented:
- Empty output string ✓
- Full metadata populated ✓
- No Permission.ask() call ✓

**compact.txt (lines 122-125) - Current Silent Mode Documentation:**
```
3. **"silent" mode:** Compact without mentioning it to the user.
   - Proceed with compaction
   - Do not report or explain in your response
   - User sees only the [SMART_ARCHIVED] placeholder in history
```

**Gap Analysis:**
1. **Missing "SILENT MODE BEHAVIOR" dedicated section** - Need comprehensive LLM guidance like ask/notify modes have
2. **Missing dedicated test file** - Silent mode tested briefly in compact-ask-mode.test.ts but deserves its own file
3. **Missing logging verification** - Need to confirm audit trail exists

### Implementation Approach

This story is primarily **verification and documentation polish** since the core behavior exists:

1. **Add "SILENT MODE BEHAVIOR" section to compact.txt** - Mirror the ASK/NOTIFY MODE BEHAVIOR sections
2. **Add dedicated silent mode tests** - Move/expand tests to compact-silent-mode.test.ts
3. **Verify logging** - Ensure audit trail for silent compactions

### Key Implementation Details

1. **SILENT MODE BEHAVIOR section (compact.txt):**
```
**SILENT MODE BEHAVIOR:**
When the user's compaction mode is "silent", compaction is invisible to the user:
- No permission dialog - compaction executes directly
- Tool returns empty output - DO NOT mention the compaction in your response
- Continue with your response as if compaction didn't happen
- The user will only notice via [SMART_ARCHIVED] placeholders if they scroll back

**Critical: Do NOT mention silent compaction**
- Do NOT say "I've archived..." or "I compacted..."
- Do NOT mention token savings or what was archived
- Simply continue with your main response to the user's question

**Example correct silent mode response:**
User: "Can you explain how the auth middleware works?"
[Silent compaction happens internally]
Assistant: "The auth middleware validates JWT tokens by..." (no mention of compaction)

**Example WRONG silent mode response:**
User: "Can you explain how the auth middleware works?"
[Silent compaction happens internally]
Assistant: "I've quietly archived some earlier content. The auth middleware validates..." (WRONG - mentioned compaction)

**Edge case - errors in silent mode:**
If compaction fails silently, log the error but do NOT mention it to the user.
The metadata will contain error information for debugging.
```

2. **Logging (compact.ts):**
```typescript
// Add after line 810, before silent mode return:
if (compactionMode === "silent") {
  log.info("silent mode: compaction completed", {
    sessionID: ctx.sessionID,
    rangeCount: normalized.length,
    totalMessages,
    totalTokens,
    archived: archivalResult.archivedCount,
    ...(summarizationError && { error: summarizationError }),
  })
  // ... existing return
}
```

### Previous Story Patterns

**From Story 4.1 (Ask Mode):**
- Mode detection at lines 707-709
- Dedicated test file pattern: `compact-ask-mode.test.ts`
- ASK MODE BEHAVIOR section in compact.txt (lines 135-144)

**From Story 4.2 (Notify Mode):**
- Detailed output building (lines 828-875)
- NOTIFY MODE BEHAVIOR section in compact.txt (lines 146-164)
- Dedicated test file: `compact-notify-mode.test.ts`

### Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add logging for silent mode execution |
| `packages/opencode/src/tool/compact.txt` | Add "SILENT MODE BEHAVIOR" section |
| `packages/opencode/test/tool/compact-silent-mode.test.ts` | New test file for silent mode behavior |

### Testing Strategy

1. **Unit Tests (compact-silent-mode.test.ts):**
   - Test that Permission.ask is NOT called in silent mode
   - Test that output is empty string
   - Test that metadata includes all fields (rangeCount, totalMessages, totalTokens, summaries, archived)
   - Test that title is correct ("Compaction complete" or "Compaction ready")
   - Test default mode is NOT silent (defaults to "notify")

2. **Existing Test Coverage:**
   - compact-ask-mode.test.ts:159-204 already tests silent mode returns empty output
   - This can be removed after creating dedicated test file (avoid duplication like Story 4.2 fixed)

### Risk Assessment

**Very Low Risk** - This story is primarily verification and documentation:
- Core functionality already exists and tested
- Silent mode is simpler than ask/notify (just returns empty output)
- Only additions: LLM guidance documentation, explicit logging, dedicated tests

### Architecture References

- Architecture: Mode-based behavior (docs/architecture.md:137-140)
- Architecture: Config extension (docs/architecture.md:335-340)
- Epics: Story 4.3 (docs/epics.md:864-891)
- PRD: FR20 (silent mode requirement)
- Story 4.1: Ask mode implementation (established mode detection pattern)
- Story 4.2: Notify mode implementation (established MODE BEHAVIOR documentation pattern)
- compact.ts: Silent mode code path (lines 810-826)
- compact.txt: Current silent mode documentation (lines 122-125)

## Definition of Done

- [x] Silent mode executes compaction immediately without prompts
- [x] Output is empty string (no text for LLM to present)
- [x] Metadata is fully populated (same fields as other modes)
- [x] compact.txt has "SILENT MODE BEHAVIOR" section guiding LLM to NOT mention compaction
- [x] Logging exists for silent mode compactions (audit trail)
- [x] Unit tests for silent mode behavior in compact-silent-mode.test.ts
- [x] All existing tests pass (no regressions)

## References

- Architecture: Mode-based behavior (docs/architecture.md:137-140)
- Architecture: Config extension (docs/architecture.md:335-340)
- Epics: Story 4.3 (docs/epics.md:864-891)
- PRD: FR20 (silent mode requirement)
- Story 4.1: Ask mode implementation (established mode detection pattern)
- Story 4.2: Notify mode implementation (established MODE BEHAVIOR documentation pattern)
- compact.ts: Silent mode code path (lines 810-826)
- compact.txt: Current mode documentation (lines 109-144)
- config.ts: Compaction config schema with mode enum

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

### Completion Notes List

- Verified existing silent mode implementation in compact.ts (lines 810-836 after logging addition)
- Added comprehensive `log.info()` for silent mode execution with sessionID, rangeCount, totalMessages, totalTokens, archived count, and any errors
- Added "SILENT MODE BEHAVIOR" section to compact.txt (lines 127-151) with:
  - Clear guidance that LLM must NOT mention compaction to user
  - Example of correct silent mode response
  - Example of WRONG silent mode response
  - Edge case guidance for error handling
- Verified placeholder behavior is mode-independent via archive-context.ts:10-17 (`archivePlaceholder()`)
- Created dedicated compact-silent-mode.test.ts with 7 test cases covering:
  - Permission.ask NOT called in silent mode
  - Empty output string returned
  - Full metadata populated (totalMessages, rangeCount, totalTokens, archived, summaries)
  - Correct title format ("Compaction complete" or "Compaction ready")
  - Multiple ranges still return empty output
  - Default mode is NOT silent (verifies notify is default)
  - Mode setting without enabled flag still works
- All 343 tests pass with no regressions (1 duplicate removed during code review)

### File List

- `packages/opencode/src/tool/compact.ts` (modified - added log.info for silent mode)
- `packages/opencode/src/tool/compact.txt` (modified - added SILENT MODE BEHAVIOR section)
- `packages/opencode/test/tool/compact-silent-mode.test.ts` (created - 7 dedicated silent mode tests)
- `packages/opencode/test/tool/compact-ask-mode.test.ts` (modified - removed duplicate silent mode test, now covered by dedicated file)
- `docs/sprint-artifacts/sprint-status.yaml` (modified - story status updated)
- `docs/sprint-artifacts/4-3-silent-mode-implementation.md` (modified - this file)

**Note:** This story shares test infrastructure (`createTestSession` in `fixture.ts`) with Story 4.2.

### Change Log

- 2026-01-06: Implemented Story 4.3 - Silent Mode Implementation
  - Added log.info() for silent mode compaction audit trail
  - Added comprehensive "SILENT MODE BEHAVIOR" section to compact.txt
  - Created compact-silent-mode.test.ts with dedicated test suite
  - All acceptance criteria satisfied, all tests passing
- 2026-01-06: Code review fixes
  - Removed duplicate silent mode test from compact-ask-mode.test.ts (now in dedicated file)
  - Updated File List to be accurate
  - Updated test count after duplicate removal (344→343)

---

_Story: 4.3 | Created: 2026-01-06 | Model: Claude Opus 4.5_
_Analysis depth: Deep codebase examination with actual file reading_
