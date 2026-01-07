# Story 4.2: Notify Mode Implementation

Status: Done

## Story

As a user in "notify" mode,
I want the LLM to compact and then tell me what it did,
So that I'm informed without interrupting my flow.

## Acceptance Criteria

1. **Mode Detection**
   - Given compaction mode is set to "notify" in config (or not specified, as it's the default)
   - When the LLM executes compaction
   - Then the tool performs compaction immediately without permission prompts

2. **Notification in Tool Result**
   - Given mode is "notify"
   - When compaction completes successfully
   - Then the tool returns a notification in the result that includes:
     - Archived message range(s) with IDs (e.g., "msg_abc to msg_xyz")
     - Token savings (e.g., "4,500 tokens")
     - Generated summary for each range
     - Index terms for each range
     - Retrieval hint: "Use retrieve tool with archiveId 'msg_abc' to restore if needed"

3. **Concise but Informative Output**
   - Given mode is "notify"
   - When the LLM presents the compaction result to the user
   - Then the notification is concise but informative
   - And the user sees what was archived and how to retrieve it

4. **Conversation Flow Continuity**
   - Given compaction completes in notify mode
   - When the LLM presents results
   - Then the conversation continues without requiring a user response
   - And the LLM naturally incorporates the compaction notification into its response

5. **Default Mode Behavior**
   - Given no compaction mode is configured
   - When the tool reads configuration
   - Then it defaults to "notify" mode behavior

## Tasks / Subtasks

- [x] Task 1 (AC: 1, 5): Verify notify mode detection in CompactTool
  - [x] Subtask 1.1: Confirm Config.get() returns "notify" as default when compaction.mode is not specified
  - [x] Subtask 1.2: Verify no Permission.ask() is called in notify mode (code path already exists)
  - [x] Subtask 1.3: Add explicit test for default mode being "notify"

- [x] Task 2 (AC: 2, 3): Verify notification output format
  - [x] Subtask 2.1: Review current output format in compact.ts (lines 828-866) for notify mode
  - [x] Subtask 2.2: Verify output includes: archived ranges, token savings, summaries, index terms
  - [x] Subtask 2.3: Verify retrieval hint is included in output
  - [x] Subtask 2.4: Add test to verify output format matches AC requirements

- [x] Task 3 (AC: 4): Update compact.txt for notify mode behavior
  - [x] Subtask 3.1: Add "NOTIFY MODE BEHAVIOR" section to compact.txt (if not sufficient)
  - [x] Subtask 3.2: Document that LLM should incorporate notification naturally into response
  - [x] Subtask 3.3: Provide example of good notify mode LLM response

- [x] Task 4: Testing
  - [x] Subtask 4.1: Unit test that Permission.ask is NOT called in notify mode
  - [x] Subtask 4.2: Unit test that output includes all required notification elements
  - [x] Subtask 4.3: Unit test default mode behavior (no config = notify)
  - [x] Subtask 4.4: Verify all existing tests pass (no regressions)

## Dev Notes

### Current State Analysis

**compact.ts (lines 707-866):**
- Mode detection is already implemented (line 709): `const compactionMode: "ask" | "notify" | "silent" = config.compaction?.mode ?? "notify"`
- Notify mode already shares code path with ask mode for output building (lines 828-866)
- The output format already includes: range details, summaries, index terms, token counts
- NO Permission.ask() call happens in notify mode (only in ask mode, lines 728-770)

**Current output format (lines 829-855):**
```typescript
const rangeDetails = validatedRanges.map((r) => {
  const s = summaries[r.range.startMessageId]
  const summaryText = s?.summary ?? "No summary generated"
  const indexText = s?.indexTerms?.length ? s.indexTerms.join(", ") : "No index terms"
  return `[${r.range.startMessageId} to ${r.range.endMessageId} (${r.messages.length} message${r.messages.length === 1 ? "" : "s"}, ~${r.tokenEstimate.toLocaleString()} tokens)]
  Summary: ${summaryText}
  Index: ${indexText}`
}).join("\n\n")
```

**Observation:** The current implementation ALREADY satisfies most of the ACs for notify mode! The key implementation work completed in Story 2.x created the output format that notify mode uses.

**Gap Analysis:**
1. **Retrieval hint** - The output does NOT currently include a retrieval hint. AC2 requires: "Use retrieve tool with archiveId 'msg_abc' to restore if needed"
2. **compact.txt** - May need a dedicated "NOTIFY MODE BEHAVIOR" section to guide LLM on how to present the notification naturally
3. **Test coverage** - Need explicit tests for notify mode behavior

### Implementation Approach

This story is largely a **verification and polish** story since the core notify mode behavior is already implemented. Key tasks:

1. **Add retrieval hint to output** - Modify the output string to include retrieval instructions
2. **Enhance compact.txt** - Add explicit notify mode guidance for LLM behavior
3. **Add test coverage** - Explicit tests for notify mode paths

### Key Implementation Details

1. **Adding Retrieval Hint (compact.ts):**
   The output needs to include a retrieval hint. Example addition after the status text:
   ```typescript
   const retrievalHint = archived && archivalResult.archivedCount > 0
     ? `\n\nTo restore archived content, use the retrieve tool with archiveId "${firstAnchorId}".`
     : ""
   ```

2. **LLM Guidance (compact.txt):**
   Add a "NOTIFY MODE BEHAVIOR" section:
   ```
   **NOTIFY MODE BEHAVIOR:**
   When the user's compaction mode is "notify" (the default), after compaction completes:
   - Present the notification naturally as part of your response
   - Don't make it the focus - mention it briefly before/after your main content
   - Include what was archived and the summary so user understands what's preserved

   Example good notify response:
   "I've archived our earlier debugging discussion (~3,500 tokens) - the summary captures the key findings about the middleware ordering issue. Now, regarding your question about..."

   Example avoid:
   Just dumping the raw tool output without context
   ```

### Previous Story Patterns

**From Story 4.1 (Ask Mode):**
- Mode detection pattern established (lines 707-709)
- Permission system integration pattern
- Test patterns in `compact-ask-mode.test.ts`

**From Story 2.5/2.6 (User/LLM Compaction):**
- Output format established
- Tool description patterns in compact.txt

### Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add retrieval hint to notify/ask mode output |
| `packages/opencode/src/tool/compact.txt` | Add "NOTIFY MODE BEHAVIOR" section |
| `packages/opencode/test/tool/compact-notify-mode.test.ts` | New test file for notify mode behavior |

### Testing Strategy

1. **Unit Tests (compact-notify-mode.test.ts):**
   - Test that Permission.ask is NOT called when mode is "notify"
   - Test that output includes all required elements (ranges, tokens, summaries, retrieval hint)
   - Test default mode is "notify" when config.compaction.mode is undefined
   - Test output format matches expected structure

2. **Integration Testing:**
   - Run actual compaction in notify mode
   - Verify output is human-readable and informative

### Risk Assessment

**Low Risk** - This story is primarily verification and polish:
- Core functionality already exists
- Mode detection already implemented
- Output format already established
- Only additions: retrieval hint, LLM guidance, explicit tests

### Architecture References

- Architecture: Mode-based behavior (docs/architecture.md:137-140)
- Architecture: Config extension (docs/architecture.md:335-340)
- Epics: Story 4.2 (docs/epics.md:831-859)
- PRD: FR19 (notify mode requirement)

## Definition of Done

- [x] Notify mode executes compaction immediately without permission prompts
- [x] Output includes: archived ranges, token savings, summaries, index terms
- [x] Output includes retrieval hint for restoring archived content
- [x] compact.txt has "NOTIFY MODE BEHAVIOR" section guiding LLM on natural presentation
- [x] Default mode is "notify" when no config specified (verified by test)
- [x] Unit tests for notify mode behavior (Permission NOT called, output format)
- [x] All existing tests pass (no regressions) - 337 tests passing (1 skipped)

## References

- Architecture: Mode-based behavior (docs/architecture.md:137-140)
- Architecture: Config extension (docs/architecture.md:335-340)
- Epics: Story 4.2 (docs/epics.md:831-859)
- PRD: FR19 (notify mode requirement)
- Story 4.1: Ask mode implementation (established mode detection pattern)
- Story 2.5/2.6: User/LLM compaction (established output format)
- compact.ts: Current mode handling (lines 707-866)
- compact.txt: Current mode documentation (lines 109-144)
- config.ts: Compaction config schema with "notify" default

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- No blocking issues encountered during implementation

### Completion Notes List

**Task 1 - Verify notify mode detection:**
- Confirmed config.ts line 534 defaults mode to "notify"
- Confirmed config.ts line 542 defaults entire compaction object to `{ mode: "notify", enabled: true }`
- Verified existing tests in compact-ask-mode.test.ts already cover notify mode (lines 189-227, 276-314)

**Task 2 - Add retrieval hint to output:**
- Added retrieval hint with archive IDs to notify/ask mode output (compact.ts lines 853-860)
- Hint lists all successfully archived range IDs for easy retrieval reference
- Format: `To restore archived content, use the retrieve tool with archiveId: "msg_xxx", "msg_yyy".`

**Task 3 - Update compact.txt:**
- Added comprehensive "NOTIFY MODE BEHAVIOR" section (lines 146-163)
- Includes example of good notify response and what to avoid
- Emphasizes natural conversation flow - compaction is housekeeping, not the main event

**Task 4 - Testing:**
- Created new test file: compact-notify-mode.test.ts with 6 tests
- Tests cover: retrieval hint inclusion, output format, multiple ranges, Permission.ask not called, default mode
- All tests pass with no regressions

### File List

- packages/opencode/src/tool/compact.ts (modified - added retrieval hint to notify/ask mode output)
- packages/opencode/src/tool/compact.txt (modified - added NOTIFY MODE BEHAVIOR section, ID format clarification, AC4 explicit guidance)
- packages/opencode/src/tool/retrieve.txt (modified - added ID format clarification for consistency)
- packages/opencode/test/tool/compact-notify-mode.test.ts (new - 6 unit tests for notify mode)
- packages/opencode/test/tool/compact-ask-mode.test.ts (modified - use shared fixture)
- packages/opencode/test/fixture/fixture.ts (modified - added createTestSession shared helper)

### Change Log

- 2026-01-06: Implemented notify mode for CompactTool - adds retrieval hints to output, comprehensive LLM guidance in tool description, and 6 new unit tests
- 2026-01-06: Code review fixes - strengthened test assertions for retrieval hint, added explicit AC4 guidance (no user response required), added msg_abc ID format clarification to compact.txt and retrieve.txt referencing id.ts
- 2026-01-06: Code review fixes (round 2) - extracted createTestSession to shared fixture (DRY), added test for non-archived output case, updated sprint-status to done
- 2026-01-06: Code review fixes (round 3) - fixed test count docs (5→6 tests), removed duplicate notify mode test from compact-ask-mode.test.ts

---

_Story: 4.2 | Created: 2026-01-06 | Model: Claude Opus 4.5_
_Analysis depth: Deep codebase examination with actual file reading_
