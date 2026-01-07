# Story 5.2: Compact Tool Prepare Mode (Two-Phase Entry Point)

Status: done

## Story

As an LLM,
I want to call the compact tool with no ranges to enable message ID visibility,
so that I can see message IDs and then call compact again with specific ranges.

## Acceptance Criteria

1. **Given** the compact tool is called with no ranges (empty array or omitted)
   **When** the tool executes
   **Then** it sets a session-level flag: `compactionModeEnabled = true`
   **And** it returns a tool response instructing the LLM how to proceed

2. **And** the tool response includes:
   ```
   Message IDs are now visible in the conversation (e.g., [msg_abc123]).

   IMPORTANT: Do NOT mimic or generate message IDs in your responses. These IDs are
   injected by the system and correspond to real stored messages. Only reference IDs
   you can see prefixed on actual messages.

   Call compact again with specific message ID ranges to archive content.
   ```

3. **Given** the flag `compactionModeEnabled = true` is set
   **When** the system rebuilds context for the tool response
   **Then** `toModelMessage()` includes ID prefixes on all messages
   **And** the LLM sees all messages with `[msg_xxx]` prefixes visible

4. **Given** compact tool is called with valid ranges (non-empty array)
   **When** compaction completes successfully
   **Then** the flag is reset: `compactionModeEnabled = false`
   **And** subsequent context builds hide message IDs again

5. **And** the tool description (`compact.txt`) is updated to explain:
   - Two-phase flow explanation
   - "Message IDs are NOT visible by default. Call compact with no ranges first to enable ID visibility."
   - "Do not generate or guess message IDs - only use IDs visible in the conversation after prepare phase."

## Tasks / Subtasks

- [x] Task 1: Add session-level state storage for `compactionModeEnabled` flag (AC: #1, #4)
  - [x] Subtask 1.1: Determine storage location (Session.Info extension vs runtime state)
  - [x] Subtask 1.2: Add `compactionModeEnabled: boolean` field to session state
  - [x] Subtask 1.3: Ensure flag persists within session but resets on new sessions
  - [x] Subtask 1.4: Create getter/setter functions for the flag

- [x] Task 2: Modify compact tool to handle "prepare mode" (no ranges) (AC: #1, #2)
  - [x] Subtask 2.1: Update `Parameters` schema to make `ranges` optional or accept empty array
  - [x] Subtask 2.2: Detect prepare mode: check if `ranges` is empty/undefined/zero-length
  - [x] Subtask 2.3: When in prepare mode, set `compactionModeEnabled = true` on session
  - [x] Subtask 2.4: Return prepare mode response with instructions for LLM
  - [x] Subtask 2.5: Skip all validation/summarization logic when in prepare mode

- [x] Task 3: Wire `compactionModeEnabled` flag to `toModelMessage()` (AC: #3)
  - [x] Subtask 3.1: Ensure prompt.ts passes `compactionModeEnabled` from session state to `toModelMessage()`
  - [x] Subtask 3.2: Verify context rebuilds with IDs after flag is set
  - [x] Subtask 3.3: Test that LLM sees `[msg_xxx]` prefixes after prepare mode call

- [x] Task 4: Reset flag after successful compaction (AC: #4)
  - [x] Subtask 4.1: After `storeArchiveMetadata()` succeeds, reset `compactionModeEnabled = false`
  - [x] Subtask 4.2: Only reset on successful archival (not on validation-only or error cases)
  - [x] Subtask 4.3: Ensure subsequent context builds hide IDs again

- [x] Task 5: Update compact.txt tool description (AC: #5)
  - [x] Subtask 5.1: Add "TWO-PHASE COMPACTION FLOW" section at the top
  - [x] Subtask 5.2: Explain that message IDs are NOT visible by default
  - [x] Subtask 5.3: Document: call compact with no ranges first to see IDs
  - [x] Subtask 5.4: Warn: do not generate or guess message IDs
  - [x] Subtask 5.5: Update PARAMETERS section to show ranges is optional for prepare mode

- [x] Task 6: Write tests for two-phase compaction flow (AC: #1, #2, #3, #4)
  - [x] Subtask 6.1: Test prepare mode (empty ranges) sets flag and returns instructions
  - [x] Subtask 6.2: Test flag causes `toModelMessage()` to include ID prefixes
  - [x] Subtask 6.3: Test successful compaction resets flag
  - [x] Subtask 6.4: Test flag state persists within session
  - [x] Subtask 6.5: Test new session starts with flag false

## Dev Notes

### Architecture Context: Two-Phase Compaction Flow

The two-phase compaction flow solves a critical bug where the LLM was hallucinating fake message IDs. Here's the flow:

```
Phase 1 - Prepare Mode:
1. LLM sees high context utilization from context gauge
2. LLM decides to compact, but can't see message IDs
3. LLM calls compact({ ranges: [] }) - empty ranges triggers prepare mode
4. Tool sets compactionModeEnabled = true on session
5. Tool returns instructions to the LLM
6. System rebuilds context → flag is true → IDs now visible
7. LLM receives tool response AND sees [msg_xxx] prefixes on all messages

Phase 2 - Execute Mode:
8. LLM identifies specific message ranges to compact using visible IDs
9. LLM calls compact({ ranges: [{ startMessageId: "msg_xxx", ... }] })
10. Tool validates ranges, generates summaries, stores archive metadata
11. Tool resets compactionModeEnabled = false
12. Subsequent context hides IDs again
```

### Key Implementation Detail: Flag Flip Timing

The flag MUST be set BEFORE the tool response is delivered. When the AI SDK builds context to include the tool result, it should check the session's `compactionModeEnabled` flag. This enables single-turn compaction without extra user messages.

### Session State Options

**Option A: Extend Session.Info schema**
```typescript
// In session/index.ts Session.Info
compactionModeEnabled: z.boolean().optional().default(false)
```
Pros: Persists across connection drops, visible in storage
Cons: Stored to disk (overkill for transient state)

**Option B: Runtime state in SessionPrompt or similar**
Pros: Lightweight, in-memory only
Cons: Lost on crash/restart (acceptable - flag is transient)

**Recommended: Option B** - This is transient state that only matters during an active compaction flow. If the process restarts, starting fresh with IDs hidden is the correct behavior.

### Existing Code to Modify

1. **`packages/opencode/src/tool/compact.ts`**
   - Current Parameters require non-empty ranges: `.nonempty("ranges must include at least one range")`
   - Need to make ranges optional or remove nonempty constraint
   - Add prepare mode detection and handling at start of execute()
   - Add flag reset at end of successful compaction

2. **`packages/opencode/src/tool/compact.txt`**
   - Add TWO-PHASE COMPACTION section
   - Update PARAMETERS to show ranges is optional
   - Add warnings about not generating/guessing IDs

3. **`packages/opencode/src/session/prompt.ts`**
   - Need to pass `compactionModeEnabled` to `toModelMessage()` calls
   - May need to add state management for the flag

4. **`packages/opencode/src/session/message-v2.ts`**
   - Story 5.1 already added the `compactionModeEnabled` option to `toModelMessage()`
   - Just need to wire up the flag from session state

### Story 5.1 Foundation

Story 5.1 already implemented:
- `ToModelMessageOptions` interface with `compactionModeEnabled?: boolean`
- Conditional ID prefixing in `toModelMessage()` based on the flag
- Default behavior (flag omitted/false) hides IDs
- When `compactionModeEnabled: true`, IDs are prefixed

What Story 5.2 needs to add:
- Storage/management of the flag at session level
- Setting the flag in prepare mode
- Resetting the flag after compaction
- Wiring the flag through prompt.ts to toModelMessage()

### Prepare Mode Response Content

```typescript
const PREPARE_MODE_RESPONSE = `Message IDs are now visible in the conversation (e.g., [msg_abc123]).

IMPORTANT: Do NOT mimic or generate message IDs in your responses. These IDs are
injected by the system and correspond to real stored messages. Only reference IDs
you can see prefixed on actual messages.

Call compact again with specific message ID ranges to archive content.

Example:
{
  "ranges": [
    { "startMessageId": "msg_xxx", "endMessageId": "msg_yyy" }
  ]
}`
```

### Testing Strategy

1. **Unit tests for flag management:**
   - Flag starts false
   - Prepare mode sets flag true
   - Successful compaction resets flag false
   - Flag affects toModelMessage output

2. **Integration tests for two-phase flow:**
   - Full flow: prepare mode → ID visibility → compaction → ID hidden
   - Error handling: if compaction fails, flag state behavior
   - Session boundary: new session starts with flag false

### Project Structure Notes

- Tool implementation: `packages/opencode/src/tool/compact.ts`
- Tool description: `packages/opencode/src/tool/compact.txt`
- Session state: `packages/opencode/src/session/` (index.ts or new state file)
- Prompt building: `packages/opencode/src/session/prompt.ts`
- Message rendering: `packages/opencode/src/session/message-v2.ts`

### References

- [Source: docs/epics.md#Story-5.2] - User story and acceptance criteria
- [Source: docs/architecture.md#ID-Visibility] - Two-phase compaction design
- [Source: docs/architecture.md#Two-Phase-Compaction-Flow] - Flow diagram
- [Source: docs/sprint-artifacts/5-1-conditional-id-prefixing-based-on-compaction-mode-flag.md] - Foundation story
- [Source: packages/opencode/src/tool/compact.ts] - Current compact tool implementation
- [Source: packages/opencode/src/session/message-v2.ts:587-757] - toModelMessage with compactionModeEnabled

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

### Completion Notes List

1. **Task 1 (Session State)**: Created new `CompactionModeState` module at `packages/opencode/src/session/compaction-mode-state.ts` using runtime state (Option B as recommended in dev notes). Provides `get()`, `set()`, `clear()`, and `reset()` functions for managing the flag per session.

2. **Task 2 (Prepare Mode)**: Modified compact tool to handle empty/undefined ranges as "prepare mode". Added `isPrepareMode()` helper function and `PREPARE_MODE_RESPONSE` constant. When prepare mode is triggered, the tool sets `compactionModeEnabled = true` and returns instructions to the LLM.

3. **Task 3 (Wiring)**: Updated `prompt.ts` to pass `{ compactionModeEnabled: CompactionModeState.get(sessionID) }` to `toModelMessage()`. This leverages Story 5.1's foundation that already implemented conditional ID prefixing.

4. **Task 4 (Flag Reset)**: Added logic after `storeArchiveMetadata()` to reset the flag when `archivalResult.archivedCount > 0`. This ensures IDs are hidden again after successful compaction.

5. **Task 5 (Tool Description)**: Added "TWO-PHASE COMPACTION FLOW" section to `compact.txt` explaining prepare mode and execute mode. Updated PARAMETERS section to show ranges is optional.

6. **Task 6 (Tests)**: Added comprehensive tests in `compact-prepare-mode.test.ts` covering:
   - CompactionModeState flag management
   - isPrepareMode() function
   - PREPARE_MODE_RESPONSE content
   - Two-phase compaction flag lifecycle
   - Updated existing test that expected empty ranges to throw

### File List

**New Files:**
- `packages/opencode/src/session/compaction-mode-state.ts` - Runtime state module for compactionModeEnabled flag
- `packages/opencode/test/tool/compact-prepare-mode.test.ts` - Tests for two-phase compaction flow

**Modified Files:**
- `packages/opencode/src/tool/compact.ts` - Added prepare mode handling, flag management, imports
- `packages/opencode/src/tool/compact.txt` - Added TWO-PHASE COMPACTION section, updated PARAMETERS
- `packages/opencode/src/session/prompt.ts` - Added CompactionModeState import, wired flag to toModelMessage()
- `packages/opencode/test/tool/compact-retrieve.test.ts` - Updated test for empty ranges to expect prepare mode behavior
- `docs/sprint-artifacts/sprint-status.yaml` - Updated sprint status tracking
