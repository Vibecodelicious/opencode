# Story 4.1: Ask Mode Implementation

Status: Done

## Story

As a user in "ask" mode,
I want the LLM to request permission before compacting,
So that I approve every compaction decision.

## Acceptance Criteria

1. **Mode Detection** ✅
   - Given compaction mode is set to "ask" in config
   - When the LLM decides to compact content autonomously
   - Then the tool detects the mode before execution

2. **Permission Request** ✅
   - Given mode is "ask"
   - When the LLM wants to compact
   - Then instead of executing immediately, present:
     - What will be archived (message range) ✅
     - Estimated token savings ✅
     - The proposed summary (if pre-generated) — *intentionally skipped, see Implementation Notes*
   - And ask: "Proceed with compaction? (yes/no)" ✅

3. **User Approval Flow** ✅
   - Given user says "yes" or approves
   - Then compaction proceeds normally
   - And archived content appears as `[SMART_ARCHIVED]` placeholder

4. **User Rejection Flow** ✅
   - Given user says "no" or declines
   - Then compaction is cancelled
   - And conversation continues without modification
   - And no archive metadata is stored

5. **Conversational Interaction** — *see Implementation Notes*
   - The interaction must be conversational (not a modal/dialog)
   - LLM explains reasoning in natural language
   - User responds in natural language

### Implementation Notes

**AC 2 - Pre-generated summary:** Summaries are intentionally NOT pre-generated before asking permission. The "(if pre-generated)" qualifier makes this optional. Pre-generating would require an LLM call before getting permission, adding cost and latency. Summaries are generated after approval.

**AC 5 - Permission UI:** Implementation uses OpenCode's native Permission system (modal dialog) rather than a conversational flow. This provides consistent UX with all other tools (bash, edit, write, read) and enables the "Always" option to skip future prompts. The Permission dialog shows message ranges and token estimates clearly.

## Tasks / Subtasks

- [x] Task 1 (AC: 1): Add mode detection to CompactTool
  - [x] Subtask 1.1: Import Config and Permission into compact.ts
  - [x] Subtask 1.2: Read `compaction.mode` from config at tool execution start
  - [x] Subtask 1.3: Default to "notify" mode when config not specified

- [x] Task 2 (AC: 2, 5): Implement ask mode using Permission system
  - [x] Subtask 2.1: When mode is "ask", call Permission.ask() before compaction
  - [x] Subtask 2.2: Permission title shows: message count, token estimate
  - [x] Subtask 2.3: Permission metadata includes: ranges, rangeDescriptions, totalMessages, totalTokens

- [x] Task 3 (AC: 3, 4): Handle Permission response
  - [x] Subtask 3.1: If Permission.ask() resolves, continue with compaction
  - [x] Subtask 3.2: If user declines, Permission.RejectedError is thrown automatically
  - [x] Subtask 3.3: No special handling needed - Permission system manages approval state

- [x] Task 4: Update compact.txt for ask mode behavior
  - [x] Subtask 4.1: Add "ASK MODE BEHAVIOR" section to compact.txt
  - [x] Subtask 4.2: Explain that native Permission dialog is used (consistent with other tools)
  - [x] Subtask 4.3: Document that no special parameters needed - just call tool normally

- [x] Task 5: Testing
  - [x] Subtask 5.1: Unit test Permission.ask called when mode is "ask"
  - [x] Subtask 5.2: Unit test Permission.ask NOT called in notify/silent modes
  - [x] Subtask 5.3: Unit test RejectedError thrown when user declines
  - [x] Subtask 5.4: Unit test Permission metadata includes correct token estimates

## Dev Notes

### Current State Analysis

**compact.ts (lines 680-788):**
- `CompactTool.execute(params, ctx)` is the main entry point
- Currently executes compaction immediately with no mode check
- Returns structured output with title, output text, and metadata

**config.ts (lines 523-543):**
- Compaction config schema already exists:
  ```typescript
  compaction: z.object({
    mode: z.enum(["ask", "notify", "silent"]).default("notify"),
    enabled: z.boolean().default(true),
  })
  ```
- Mode is already configurable - just not used yet

**compact.txt (lines 109-133):**
- Already documents the three modes conceptually
- Explains that "ask" mode requires waiting for approval
- **Gap**: No guidance on the actual two-step execution flow

### Implementation Approach

**Approach: Native Permission System (Code Review Fix)**

After code review, the initial two-step LLM-controlled flow was replaced with the native Permission system used by all other OpenCode tools:

- Uses `Permission.ask()` to display a native TUI permission dialog
- Follows the same pattern as bash.ts, edit.ts, write.ts, etc.
- User sees standard permission menu with "Yes", "Always", or "Reject" options
- Rejection throws `Permission.RejectedError` which cancels compaction
- No special parameters needed - just call the tool normally

### Key Implementation Details

1. **Reading Config in Tool:**
   ```typescript
   import { Config } from "../config/config"
   import { Permission } from "../permission"

   const config = await Config.get()
   const mode = config.compaction?.mode ?? "notify"
   ```

2. **Ask Mode Flow (Permission System):**
   ```typescript
   if (mode === "ask") {
     await Permission.ask({
       type: "compact",
       sessionID: ctx.sessionID,
       messageID: ctx.messageID,
       callID: ctx.callID,
       title: `Archive ${totalMessages} messages (~${totalTokens} tokens)`,
       metadata: { ranges, totalMessages, totalTokens, rangeDescriptions },
     })
     // If we reach here, permission was granted
     // RejectedError thrown automatically if declined
   }
   ```

3. **Tool Description Update (compact.txt):**
   ```
   **ASK MODE BEHAVIOR:**
   When the user's compaction mode is "ask", the tool uses the native permission system:
   - A permission dialog appears in the UI showing: message ranges, count, and token estimates
   - The user can approve (once or always) or reject via the standard permission menu
   - If rejected, a Permission.RejectedError is thrown and compaction is cancelled
   - You can simply call the tool normally - no special parameters needed
   ```

### Previous Story Patterns

**From Story 2.6 (LLM Autonomous Compaction):**
- compact.txt already has comprehensive mode documentation
- Established pattern: tool description guides LLM behavior
- Mode section at lines 109-133 explains expected behavior

**From Story 1.5 (Configuration Extension):**
- Config schema is already complete and working
- `Config.get()` returns parsed config with defaults

### Files Modified

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add mode detection, Permission.ask() for ask mode, silent mode early return |
| `packages/opencode/src/tool/compact.txt` | Add "ASK MODE BEHAVIOR" section explaining native permission dialog |
| `packages/opencode/test/tool/compact-ask-mode.test.ts` | New test file with 7 unit tests for Permission system integration |

### Testing Strategy

1. **Unit Tests (compact-ask-mode.test.ts):**
   - Mock Permission.ask to verify it's called when mode is "ask"
   - Verify Permission.ask is NOT called in notify/silent modes
   - Verify RejectedError thrown when user declines
   - Verify Permission metadata includes correct token estimates

2. **Manual Testing:**
   - Set `compaction.mode: "ask"` in config
   - Trigger autonomous compaction scenario (high context)
   - Verify native Permission dialog appears
   - Test approve → compaction proceeds
   - Test reject → compaction cancelled

## Definition of Done

- [x] CompactTool reads compaction mode from config
- [x] In "ask" mode, tool calls Permission.ask() before executing compaction
- [x] Permission dialog shows: message count, token estimate, range descriptions
- [x] Permission rejection throws Permission.RejectedError (cancels compaction)
- [x] compact.txt updated with ASK MODE BEHAVIOR section
- [x] Unit tests for Permission.ask integration (7 tests in compact-ask-mode.test.ts)
- [x] All existing tests pass (no regressions) - 332 tests passing

## References

- Architecture: Config extension (docs/architecture.md:335-340)
- Architecture: Mode-based behavior (docs/architecture.md:137-140)
- Epics: Story 4.1 (docs/epics.md:801-828)
- PRD: FR18 (ask mode requirement) (docs/prd.md:483-484)
- Story 2.6: Autonomous compaction (established mode documentation pattern)
- Story 1.5: Configuration extension (config schema implementation)
- compact.txt: Current mode documentation (lines 109-133)
- compact.ts: Tool implementation (lines 680-788)
- config.ts: Compaction config schema (lines 523-543)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- No blocking issues encountered during implementation

### Completion Notes List

**Initial Implementation:**
- Implemented ask mode by adding Config import and reading compaction.mode at tool execution start
- Initial approach used a two-step LLM-controlled flow with `approved` parameter

**Code Review Fixes (Critical):**
- Code review identified that OpenCode has a native Permission system used by all other tools
- Rewrote ask mode to use `Permission.ask()` instead of LLM-controlled two-step flow
- Removed `approved` parameter from Parameters schema (no longer needed)
- Now uses the same pattern as bash.ts, edit.ts, write.ts, etc.
- Users see the standard native TUI permission dialog with "Yes", "Always", "Reject" options
- Rejection properly throws `Permission.RejectedError` which cancels compaction

**Documentation Updates:**
- Replaced "ASK MODE EXECUTION" section in compact.txt with simpler "ASK MODE BEHAVIOR" section
- Removed `approved` parameter documentation (no longer exists)
- Updated to explain that native permission dialog is used

**Tests:**
- Wrote 7 unit tests in compact-ask-mode.test.ts to test Permission system:
  - Permission.ask is called when mode is "ask"
  - RejectedError is thrown when user declines permission
  - Permission.ask is NOT called in notify mode
  - Permission.ask is NOT called in silent mode (also verifies empty output)
  - Default notify mode (no Permission.ask) when no config specified
  - Permission.ask metadata includes correct token estimates for multiple ranges
  - Skips Permission.ask on subsequent calls when "always" was previously approved
- All 332 tests pass with no regressions

**Code Review Follow-up Optimizations:**
- Optimized token estimation: calculate `tokenEstimate` once per range during validation, reuse throughout
- Added explicit type annotation `compactionMode: "ask" | "notify" | "silent"` for clarity
- Added logging after permission granted for better observability
- Moved silent mode handling earlier for cleaner code flow
- Improved test message content with realistic authentication/OAuth examples
- Extended silent mode test to verify empty output string

### File List

- packages/opencode/src/tool/compact.ts (modified - added Config and Permission imports, ask mode uses Permission.ask(), inline metadata docs)
- packages/opencode/src/tool/compact.txt (modified - added ASK MODE BEHAVIOR section explaining native permission dialog)
- packages/opencode/test/tool/compact-ask-mode.test.ts (new - 7 unit tests for Permission system integration)
- docs/sprint-artifacts/sprint-status.yaml (modified - marked story 4.1 as done)

### Change Log

- 2026-01-05: Implemented ask mode for CompactTool - adds permission request flow when compaction.mode is "ask"
- 2026-01-05: Code review fix - rewrote to use native Permission system instead of LLM-controlled two-step flow
- 2026-01-05: Code review follow-up - optimized token estimation (calculate once per range, reuse), added explicit type annotation, added permission granted logging, improved test message content with realistic examples, added silent mode empty output test
- 2026-01-05: Code review final - added test for "always" permission behavior, added inline documentation for Permission metadata structure

---

_Story: 4.1 | Created: 2026-01-05 | Model: Claude Opus 4.5_
_Analysis depth: Deep codebase examination with actual file reading_
