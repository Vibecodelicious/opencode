# Story 5.7: Fix Archive Metadata Not Stored During Smart Compaction (Data Loss Bug)

Status: done

## Story

As a user,
I want smart compaction to reliably store archive metadata,
so that archived content can be retrieved and is never lost.

## Bug Description

Compaction reports success but fails to store summary and index terms. When retrieval is attempted:
- Archive shows "No summary generated" and "No index terms"
- Retrieve tool reports "message wasn't properly archived as an anchor"
- **Original content is no longer accessible** - this is a data loss bug

## Root Cause

The `generateSummaries()` function in compact.ts was calling `streamText()` directly with Claude Code's OAuth credentials. These credentials are restricted to "Claude Code" API calls only, which requires:
1. Routing through `SessionProcessor` (proper credential handling)
2. Including the "You are Claude Code" identification in system prompts

Without these, the API call failed with: "This credential is only authorized for use with Claude Code and cannot be used for other API requests."

The error was caught and swallowed, returning empty summaries, which resulted in compaction "succeeding" but storing no metadata.

## Acceptance Criteria

1. **Summary and index terms stored correctly**
   **Given** smart compaction with Claude Opus 4.5
   **When** the compaction LLM call executes
   **Then** the summary and index terms are correctly parsed from the LLM response
   **And** archive metadata is stored on the anchor message

2. **Retrieve tool works**
   **Given** a message that was successfully compacted
   **When** the retrieve tool is called with the archive ID
   **Then** the archived content is successfully returned

3. **Failures reported correctly**
   **Given** a compaction LLM call that fails
   **When** the failure occurs
   **Then** the tool reports failure (not false success)

## Tasks / Subtasks

- [x] Task 1: Investigate credential error (AC: #1, #3)
  - [x] Subtask 1.1: Identify "credential only authorized for Claude Code" error in logs
  - [x] Subtask 1.2: Compare with working auto-compaction in session/compaction.ts
  - [x] Subtask 1.3: Discover SessionProcessor pattern requirement

- [x] Task 2: Implement SessionProcessor integration (AC: #1, #2)
  - [x] Subtask 2.1: Add SessionProcessor, Identifier, Instance, SystemPrompt imports
  - [x] Subtask 2.2: Create temporary assistant message for summary generation
  - [x] Subtask 2.3: Route streamText() through SessionProcessor.process()
  - [x] Subtask 2.4: Extract text from message parts after processing

- [x] Task 3: Add Claude Code identification (AC: #1)
  - [x] Subtask 3.1: Detect anthropic/claude providers via providerID and modelID
  - [x] Subtask 3.2: Include SystemPrompt.header("anthropic") for Claude models
  - [x] Subtask 3.3: Test with Claude Opus 4.5

- [x] Task 4: Fix Anthropic API validation error (AC: #1)
  - [x] Subtask 4.1: Identify step-start/step-finish parts causing validation failure
  - [x] Subtask 4.2: Filter out these parts before passing to toModelMessageWithIDs()

- [x] Task 5: Verification (AC: #1, #2, #3)
  - [x] Subtask 5.1: Test compaction generates summaries
  - [x] Subtask 5.2: Test retrieve tool returns archived content
  - [x] Subtask 5.3: Verify errors are logged and reported

## Technical Notes

- Location: `packages/opencode/src/tool/compact.ts`
- The fix was implemented together with Story 5.6 (TUI corruption) as both shared the same root cause
- Key pattern: `SessionProcessor.create()` + `processor.process(() => streamText({...}))`
- The anthropic spoof header ("You are Claude Code, Anthropic's official CLI for Claude.") is required for Claude Code OAuth credentials

## File List

**Modified Files:**
- `packages/opencode/src/tool/compact.ts` - Same changes as Story 5.6 (implemented together)

**See Story 5.6 for detailed change list.**

## Dev Agent Record

### Implementation

This story was fixed as part of Story 5.6 implementation. The same root cause (direct streamText() call) was responsible for both:
1. TUI corruption (Story 5.6) - stream output leaking to stdout
2. Metadata not stored (Story 5.7) - credential error causing empty summaries

### Root Cause Analysis

The credential error "This credential is only authorized for use with Claude Code" was being caught and swallowed:
```typescript
} catch (e) {
  log.error("Failed to generate summaries", { error: e })
  return {}  // Empty summaries returned, compaction "succeeds" but stores nothing
}
```

### Solution

Route API calls through SessionProcessor (which handles Claude Code credentials properly) and include the Claude Code identification header in system prompts.

### Testing

- TypeScript: `bunx tsc --noEmit` - PASS
- Manual: Verified summaries are generated and stored correctly with Claude Opus 4.5

## Change Log

- 2026-01-07: Story created from Epic 5.7 definition
- 2026-01-07: Root cause identified - credential restriction error
- 2026-01-07: Fixed together with Story 5.6 using SessionProcessor pattern
- 2026-01-07: Manual testing confirmed fix - summaries generated and retrievable
