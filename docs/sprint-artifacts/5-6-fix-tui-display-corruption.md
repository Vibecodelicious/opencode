# Story 5.6: Fix TUI Display Corruption During Smart Compaction with Claude Opus 4.5

Status: done

## Story

As a user,
I want smart compaction to execute without corrupting the TUI display,
so that the interface remains readable during compaction operations.

## Bug Description

When using Claude Opus 4.5 model, raw output (API responses, JSON structures, debug info) bleeds into the TUI during compaction, corrupting the display layout. This does not occur with the BigPickle LLM model.

## Acceptance Criteria

1. **No stdout leakage during compaction**
   **Given** smart compaction is triggered with Claude Opus 4.5
   **When** the compaction LLM call executes
   **Then** no raw output bleeds into the TUI display

2. **TUI components handle compaction output**
   **Given** compaction generates status messages
   **When** status is displayed
   **Then** messages render within TUI components (not raw stdout)

3. **Error capture via TUI**
   **Given** any errors during compaction
   **When** errors occur
   **Then** they are captured and displayed via proper TUI error handling

4. **Model parity**
   **Given** compaction with any supported model
   **When** operation completes
   **Then** behavior matches the clean output observed with BigPickle model

## Tasks / Subtasks

- [x] Task 1: Investigate streamText behavior with Opus 4.5 (AC: #1)
  - [x] Subtask 1.1: Search for how other tools use streamText in OpenCode
  - [x] Subtask 1.2: Check if streamText has onChunk or other callbacks that might output to stdout
  - [x] Subtask 1.3: Compare BigPickle vs Opus 4.5 API response formats

- [x] Task 2: Review generateSummaries function (AC: #1, #2)
  - [x] Subtask 2.1: Trace all code paths that could produce stdout output
  - [x] Subtask 2.2: Check if any middleware or transforms output to console
  - [x] Subtask 2.3: Verify response.text fully captures streamed output

- [x] Task 3: Implement fix for stdout leakage (AC: #1, #2)
  - [x] Subtask 3.1: Capture all streaming output properly
  - [x] Subtask 3.2: Ensure no intermediate chunks reach stdout
  - [x] Subtask 3.3: Test with Claude Opus 4.5 to verify TUI remains clean (manual testing confirmed fix)

- [x] Task 4: Add error handling for display (AC: #3)
  - [x] Subtask 4.1: Ensure all errors in generateSummaries are caught and logged
  - [x] Subtask 4.2: Route error messages through TUI-safe channels

- [x] Task 5: Verification (AC: #4) - Manual testing complete
  - [x] Subtask 5.1: Test compaction with BigPickle model (baseline)
  - [x] Subtask 5.2: Test compaction with Claude Opus 4.5 (bug fix verification)
  - [x] Subtask 5.3: Verify TUI remains clean during entire operation

## Dev Notes

### Investigation Areas

- **🔴 NEW CODE LOGGING PRACTICES**: Smart compaction is newly written code. Did we incorrectly use `console.log`/`console.error` instead of OpenCode's established logging patterns?
  - Check `packages/opencode/src/tool/compact.ts` for any direct console calls
  - Check the summarization LLM call - is output being streamed to stdout instead of captured?
  - Review how other tools (e.g., existing ones in `tool/`) suppress or route their output through the TUI

- **OpenCode's logging conventions**: The codebase uses `Log.create()` abstraction. Verify compact.ts follows this pattern consistently.

- **Model-specific response handling**: Does Opus 4.5 produce more verbose streaming chunks that our code doesn't properly capture?

- **streamText() output capture**: Verify the separate LLM call for summarization routes all output through proper channels.

### Key Files

- `packages/opencode/src/tool/compact.ts` - Primary investigation target
- `packages/opencode/src/util/log.ts` - Logging abstraction
- `packages/opencode/src/provider/provider.ts` - Model provider implementation

### Evidence

- Working: `/tmp/opencode_smart_compaction.png` (BigPickle - clean TUI)
- Bug: `/tmp/opencode_compaction_bug.png` (Opus 4.5 - garbled output)

### Code Analysis (Pre-Implementation)

From compact.ts review:
- Line 18: `const log = Log.create({ service: "tool.compact" })` - correct logging pattern
- Line 397: `streamText()` call in generateSummaries - potential source of stdout leakage
- Line 433: `const text = await response.text` - captures final text, but streaming chunks may leak
- No visible `console.log` statements

## Technical Notes

- This is likely a TUI output capture issue specific to how Claude Opus 4.5 responses are streamed
- The bug only manifests during the compaction operation, not during normal conversation
- Key question: "How do other OpenCode tools handle LLM calls and logging? Are we following the same pattern?"

## File List

**Modified Files:**
- `packages/opencode/src/tool/compact.ts` - Fixed generateSummaries() stream consumption
- `docs/epics.md` - Added Story 5.6 definition
- `docs/prd.md` - Documented TUI corruption bug in "Bugs Discovered" section

## Dev Agent Record

### Implementation Plan
1. Investigated how streamText is used across the codebase
2. Found that compact.ts used `await response.text` while SessionProcessor uses `fullStream` iteration
3. Identified missing `onError` callback in compact.ts (present in prompt.ts and compaction.ts)
4. Implemented fix using fullStream iteration pattern matching SessionProcessor

### Root Cause Analysis
The `generateSummaries()` function in compact.ts was consuming the stream via `await response.text` property, which internally consumes the stream. During this consumption, some providers (particularly Anthropic with Claude Opus 4.5) may output data that leaks to stdout, corrupting the TUI.

The fix properly consumes the stream via `fullStream` iteration, matching the pattern used in:
- `SessionProcessor.process()` (session/processor.ts)
- `SessionCompaction.process()` (session/compaction.ts)

### Changes Made
1. Added `onError` callback to streamText() call to route errors through Log system
2. Replaced `await response.text` with `for await (const chunk of response.fullStream)`
3. Added proper abort signal checking during stream iteration
4. Added comments explaining the fix and referencing the bug

### Completion Notes
- TypeScript compilation passes
- All 397 tests pass (0 failures)
- Manual testing with Claude Opus 4.5 confirmed TUI no longer corrupts ✓

### Testing
- TypeScript: `bunx tsc --noEmit` - PASS
- Unit tests: `bun test:no_external_deps` - 397 pass, 0 fail

## Change Log

- 2026-01-07: Story created from Epic 5.6 definition, investigation started
- 2026-01-07: Root cause identified - stream consumption pattern mismatch
- 2026-01-07: Fix implemented using fullStream iteration + onError callback
- 2026-01-07: All tests passing, ready for manual verification with Opus 4.5
- 2026-01-07: Manual testing confirmed fix - TUI remains clean with Claude Opus 4.5. Story complete.
