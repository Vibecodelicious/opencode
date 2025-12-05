# Story 1.2: Context Gauge Injection Logic

**Status:** ready-for-review

## Story

As a user,
I want the system to automatically insert context gauge checkpoints as the conversation grows,
So that the LLM can see how full the context window is.

## Acceptance Criteria

1. **Given** a conversation with growing token count
   **When** the token count crosses a checkpoint threshold (as percentage of context limit)
   **Then** a ContextGaugePart is appended to the current assistant message

2. **And** checkpoint frequency ramps up as context fills (percentage-based for model independence):
   | Utilization | Checkpoint Interval |
   |-------------|---------------------|
   | 0% - 30% | Every 30% of context |
   | 30% - 60% | Every 15% of context |
   | 60% - 80% | Every 10% of context |
   | 80%+ | Every 5% of context |

3. **And** checkpoints are never modified after creation (append-only)

4. **And** the gauge renders in context as: `[CONTEXT GAUGE: 45,000 / 100,000 tokens (45%)]`

5. **And** gauge injection does not invalidate prompt cache (appended, not inserted)

## Tasks / Subtasks

- [x] **Task 1: Implement context gauge injection** (AC: #1, #2, #3)
  - [x] 1.1: Create injection logic in `packages/opencode/src/session/compaction.ts` (extend existing)
  - [x] 1.2: Calculate checkpoint thresholds based on model context limit
  - [x] 1.3: Implement ramping frequency logic (percentage-based intervals)
  - [x] 1.4: Scan existing ContextGaugeParts in session to track last checkpoint
  - [x] 1.5: Append ContextGaugePart to assistant message after response completion

- [x] **Task 2: Integration with token estimation** (AC: #1)
  - [x] 2.1: Use `util/token.ts` for token count calculations
  - [x] 2.2: Retrieve model context limit from `ModelsDev.Model` configuration
  - [x] 2.3: Verify token calculations match session state

- [x] **Task 3: Comprehensive testing** (AC: #1, #2, #3, #4)
  - [x] 3.1: Unit tests for checkpoint threshold calculation
  - [x] 3.2: Unit tests for ramping frequency logic (all 4 utilization ranges)
  - [x] 3.3: Integration tests for gauge injection after message completion
  - [x] 3.4: Tests verifying append-only constraint (no modifications)
  - [x] 3.5: Tests verifying gauge renders correctly in toModelMessage()
  - [x] 3.6: Tests verifying existing messages load without injection errors

## Dev Notes

### Primary File Locations

**Source:**
- `packages/opencode/src/session/compaction.ts` - Extend existing module (add gauge injection function)

**Tests:**
- `packages/opencode/test/session/gauge-injection.test.ts` - NEW

**Dependencies:**
- `packages/opencode/src/session/message-v2.ts` - ContextGaugePart (from Story 1.1)
- `packages/opencode/src/util/token.ts` - Token counting utilities
- `packages/opencode/src/model/models.ts` - Context limit configuration

### Ramping Frequency Implementation

**Key Insight:** Thresholds are percentage-based, not token-count based. This makes the logic model-agnostic.

Define thresholds as percentages:
```typescript
const CHECKPOINT_THRESHOLDS = [
  { utilization: 0.30, interval: 0.30 },   // 0-30%: every 30%
  { utilization: 0.60, interval: 0.15 },   // 30-60%: every 15%
  { utilization: 0.80, interval: 0.10 },   // 60-80%: every 10%
  { utilization: 1.00, interval: 0.05 },   // 80%+: every 5%
]
```

**Finding next threshold:**
1. Calculate current percentage: `currentPercent = tokenCount / contextLimit`
2. Find applicable interval from thresholds
3. Find last checkpoint percentage from existing ContextGaugeParts
4. Calculate next checkpoint: `lastCheckpoint + interval`
5. If `currentPercent >= nextCheckpoint`, create new gauge

**State Tracking Pattern:** Scan existing ContextGaugeParts in session message to find last checkpoint. This follows existing pattern where `compaction` field on parts (`time.compacted`) is used for state. No separate state storage needed.

### Injection Point

**When to inject:** After LLM response completion, before message is finalized for storage.

**Where in code:** Hook into existing message completion flow:
1. After `toModelMessage()` call (so gauge appears in context)
2. Before `Message.update()` saves to storage
3. Append to `assistant.parts` array (not insert at beginning - preserves prompt cache)

**Pattern match:** Follow existing compaction injection pattern in `SessionCompaction.process()` - both are append-only operations triggered at specific points in message lifecycle.

### Token Estimation

Use existing `util/token.ts` utilities:
- `countTokens(text)` - Estimate tokens in string
- For multi-part messages, estimate each part and sum

### Model Configuration

Get context limit from model config:
```typescript
import { ModelsDev } from "@/model/models"

const model = ModelsDev.Model[modelID]
const contextLimit = model.contextWindowTokens || 128000
```

Store as constant or derive from active model during message completion.

### Backwards Compatibility

- Existing messages without ContextGaugeParts load normally
- Injection is new behavior (only affects new conversations)
- No schema migrations needed (part types are already optional)

### Architecture References

- [Source: docs/architecture.md#Token-Checkpoints] - Ramping frequency details
- [Source: docs/epics.md#Story-1.2] - Full story requirements
- [Source: docs/architecture.md#Sub-Agent-Context-Format] - Message ID patterns
- [Source: packages/opencode/src/session/message-v2.ts:157-165] - ContextGaugePart definition (Story 1.1)
- [Source: packages/opencode/src/session/compaction.ts] - Existing injection patterns to follow

## Dev Agent Record

### Context Reference

- `docs/sprint-artifacts/1-2-context-gauge-injection-logic.md` (current story + AC/Dev Notes)
- `docs/architecture.md#Token-Checkpoints` (ramping frequency guidance referenced during implementation)

### Agent Model Used

- Codex (GPT-5) via CLI harness (per activation instructions)

### Debug Log References

- `bun test packages/opencode/test/session/gauge-injection.test.ts`
- `XDG_DATA_HOME=/tmp/opencode-test-data bun test packages/opencode/test/session` *(used after encountering `EACCES` writing `Global.Path.log`)*

### Completion Notes List

- Implemented context gauge math/tracking inside `SessionCompaction`, including token aggregation, checkpoint detection, and the new `injectContextGauge` entry point.
- Hooked the injection into the normal prompt loop and derived the context limit from `ModelsDev.Model` before appending ContextGaugePart.
- Added `packages/opencode/test/session/gauge-injection.test.ts` to cover threshold math, token accounting, highest checkpoint discovery, and gauge part rounding / append-only expectations.

### File List
- `packages/opencode/src/session/compaction.ts` (MODIFY - added threshold math, token accounting, and `injectContextGauge`)
- `packages/opencode/src/session/prompt.ts` (MODIFY - hook to call `injectContextGauge` after assistant responses)
- `packages/opencode/test/session/gauge-injection.test.ts` (NEW - unit/integration coverage for thresholds and gauge parts)

## Change Log

- 2025-12-05: Implemented context gauge injection with ramping thresholds + token accounting, hooked prompt emitter, and added `gauge-injection.test.ts`; full session test run executed via `XDG_DATA_HOME=/tmp/opencode-test-data bun test packages/opencode/test/session` after the default log path required elevated permissions.
- 2025-12-05: Refactored gauge injection to reuse the existing prompt window (`msgs`) and current assistant tokens instead of re-reading storage each turn.
