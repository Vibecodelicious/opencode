# Story 2.6: LLM Autonomous Compaction Decision

Status: Done

## Story

As a user,
I want the LLM to autonomously decide when to compact,
So that I don't have to manually manage context.

## Acceptance Criteria

1. **Context Gauge Awareness**
   - Given the LLM sees context gauge checkpoints showing >60% utilization
   - When the LLM observes large blocks of content not relevant to current task
   - Then the LLM can autonomously call the Compact tool

2. **Voluminous Content Detection**
   - Given there are large tool outputs (>5000 tokens)
   - When the content has already been analyzed/processed
   - Then the LLM identifies it as a compaction candidate
   - And explains why compaction is appropriate

3. **Completed Discussion Detection**
   - Given a discussion or task has concluded
   - When the content may be needed later but not immediately
   - Then the LLM identifies it as a compaction candidate
   - And preserves essential information in the summary

4. **Loop/Iteration Compaction**
   - Given the LLM is in a debugging/iteration loop
   - When prior iterations have completed and a new iteration begins
   - Then the LLM can compact prior iterations
   - And the summary captures: what was tried, what was learned, any constraints discovered

5. **Range Partitioning**
   - Given a contiguous range contains multiple distinct topics
   - When different topics would benefit from separate summaries
   - Then the LLM partitions into multiple ranges in a single compact call
   - And each range gets its own summary and index terms

6. **Mode-Aware Behavior**
   - Given the user has configured compaction mode (ask/notify/silent)
   - When the LLM decides to compact autonomously
   - Then the LLM respects the configured mode
   - And explains its reasoning when in ask/notify modes

7. **Reasoning Explanation**
   - Given compaction mode is "ask" or "notify"
   - When the LLM compacts autonomously
   - Then the LLM explains WHY it decided to compact
   - Including: utilization level, content identified, expected savings

## Tasks / Subtasks

- [x] Task 1 (AC: 1, 2, 3): Update compact.txt with autonomous decision guidance
  - [x] Subtask 1.1: Add "AUTONOMOUS DECISION" section explaining when LLM should proactively compact
  - [x] Subtask 1.2: Add context gauge interpretation guidance (>60% = consider, >80% = strongly consider)
  - [x] Subtask 1.3: Add content detection patterns (voluminous tool outputs, completed discussions)
  - [x] Subtask 1.4: Emphasize explaining reasoning in tool response

- [x] Task 2 (AC: 4): Add loop/iteration detection guidance
  - [x] Subtask 2.1: Document loop/iteration detection patterns in compact.txt
  - [x] Subtask 2.2: Add CRITICAL guidance about preserving "tried/learned" information
  - [x] Subtask 2.3: Include examples of good vs bad iteration summaries

- [x] Task 3 (AC: 5): Add range partitioning guidance
  - [x] Subtask 3.1: Document when to partition ranges vs use single range
  - [x] Subtask 3.2: Explain how to identify topic boundaries for partitioning
  - [x] Subtask 3.3: Note that tool accepts array of ranges for single call

- [x] Task 4 (AC: 6, 7): Document mode-aware behavior
  - [x] Subtask 4.1: Document the three modes (ask/notify/silent) in compact.txt
  - [x] Subtask 4.2: Explain what each mode means for LLM behavior
  - [x] Subtask 4.3: Add guidance on explaining reasoning for ask/notify modes

- [x] Task 5: Manual integration testing
  - [x] Subtask 5.1: Test LLM recognizes high context utilization scenario
  - [x] Subtask 5.2: Test LLM identifies compaction candidates autonomously
  - [x] Subtask 5.3: Test LLM explains reasoning when compacting
  - [x] Subtask 5.4: Verify mode behavior is documented (actual mode handling is Epic 4)

## Technical Deep Dive

### Current State of compact.txt

The current tool description (updated in Story 2.5) focuses on **user-directed** compaction:
- Explains WHEN TO USE: "Use when the user explicitly requests..."
- HOW TO IDENTIFY MESSAGE RANGES
- PARAMETERS and VALIDATION RULES
- AFTER COMPACTION - REPORT TO USER

**What's Missing for Story 2.6:**
1. Guidance for AUTONOMOUS (LLM-initiated) compaction decisions
2. Context gauge interpretation for detecting high utilization
3. Loop/iteration detection patterns
4. Range partitioning guidance
5. Mode-aware behavior explanation

### Context Gauge Format

From Story 1.2 implementation, context gauges render as:
```
[CONTEXT GAUGE: 45,000 / 100,000 tokens (45%)]
```

Thresholds from `compaction.ts`:
- 0% - 30%: Every 30% checkpoint
- 30% - 60%: Every 15% checkpoint
- 60% - 80%: Every 10% checkpoint
- 80%+: Every 5% checkpoint

**Interpretation Guidance for LLM:**
- <30%: No compaction needed
- 30-60%: Monitor, compact if very large tool outputs
- 60-80%: Consider compacting completed discussions
- 80%+: Strongly consider compacting, prioritize large/stale content

### Compaction Mode Configuration

From `config.ts:524-543`, compaction config supports:
```typescript
compaction: {
  mode: "ask" | "notify" | "silent",  // default: "notify"
  enabled: boolean,  // default: true
}
```

**Mode Behavior (to be implemented in Epic 4):**
- **ask**: LLM presents what will be archived, waits for user approval
- **notify**: LLM compacts and reports what it did
- **silent**: LLM compacts without user notification

**For Story 2.6:** Document these modes in compact.txt so LLM knows they exist. The actual mode-aware execution logic is Epic 4 (Stories 4.1-4.3).

### Loop/Iteration Detection Pattern

From epics.md:596-650, the tool description should guide LLM to:

1. Detect when in a loop (debugging, retrying, iterating)
2. Identify when prior iterations can be compacted (new iteration started)
3. CRITICAL: Before compacting, extract what must propagate:
   - What was tried in each iteration
   - What was learned (errors, insights, partial successes)
   - Any constraints discovered

**Example Good Summary:**
```
Iteration 1-3: Tried fixing auth via token refresh (failed - tokens valid),
session storage (failed - sessions persisting), found root cause in middleware order
```

**Example Bad Summary:**
```
Debugging session for authentication issues.
```

### Range Partitioning

From epics.md, consider splitting ranges when:
- Different topics/tasks are intermixed
- User might want to retrieve only a portion
- A single summary would lose important distinctions

Tool accepts array of ranges - can partition in single call.

### Proposed Tool Description Update

Add new sections to compact.txt:

```
AUTONOMOUS COMPACTION DECISION:
You can proactively decide to compact without user request when:

1. Context gauge shows >60% utilization AND you see:
   - Large tool outputs (>5000 tokens) already analyzed
   - Completed discussions not relevant to current task
   - Verbose file contents already reviewed
   - Debugging iterations where new iteration has begun

2. Context gauge shows >80% utilization:
   - Strongly consider compacting
   - Prioritize largest/oldest content
   - Multiple ranges may be appropriate

LOOP/ITERATION DETECTION:
When following instructions in a debugging/iteration loop:
- Prior iterations may be compacted once a new iteration begins
- CRITICAL: Before compacting loop iterations, identify what must propagate:
  - What was tried in each iteration
  - What was learned (errors, insights, partial successes)
  - Any constraints discovered that affect future attempts
- The summary MUST capture these learnings, not just "tried X, failed"

Good example: "Iteration 1-3: Tried fixing auth via token refresh (failed - tokens valid),
session storage (failed - sessions persisting), found root cause in middleware order"

Bad example: "Debugging session for authentication issues."

RANGE PARTITIONING:
Consider splitting a contiguous range into multiple archives when:
- Different topics/tasks are intermixed (separate summaries more useful)
- User might want to retrieve only a portion
- A single summary would lose important distinctions between sub-topics

When partitioning, provide multiple ranges in the single compact call.

COMPACTION MODES:
The user can configure compaction mode:
- "ask": You should explain what you want to compact and wait for approval
- "notify" (default): Compact and explain what you did in your response
- "silent": Compact without mentioning it to the user

In ask/notify modes, explain WHY you decided to compact:
- Current context utilization (from context gauge)
- What content you identified for compaction
- Expected token savings
- Why the content is suitable for archiving
```

## Previous Story Intelligence

### Story 2.5 (User-Directed Compaction) - Just Completed

**Key learnings:**
- compact.txt was updated with comprehensive user-directed guidance
- Message IDs are NOT visible in normal LLM context (only via `toModelMessageWithIDs`)
- LLM must infer ranges from conversation structure and topic boundaries
- CompactTool.execute() returns: summary, index terms, token estimates, message counts
- Error messages are clear and actionable

**Files touched:**
- `packages/opencode/src/tool/compact.txt` - current implementation baseline

### Story 2.3/2.4 (Archive Metadata + Placeholder)

**Key learnings:**
- `storeArchiveMetadata()` handles archival with race condition protection
- `toModelMessage()` renders `[SMART_ARCHIVED: ...]` placeholders automatically
- CompactTool integrates summarization + archival in one call

### Story 1.2 (Context Gauge Injection)

**Key learnings:**
- Gauges stored as ContextGaugePart with tokenCount, contextLimit, percentage
- Ramping frequency based on utilization thresholds
- Gauge renders as: `[CONTEXT GAUGE: X / Y tokens (Z%)]`

## Git Intelligence

Recent commit pattern:
```
8ba764746 feat(compact): complete Story 2.5 user-directed compaction via tool call
d361d3510 refactor(test): extract test helpers for compact-archival tests
f4335e912 docs: update sprint tracking for archive metadata storage
bd1a2e798 feat(compact): persist archive metadata to message storage
```

**Pattern:** Stories follow red-green-refactor, with clear commit messages explaining what/why.

## Implementation Guide

### Step 1: Read Current compact.txt
Review the current content (Story 2.5 update) to understand the baseline.

### Step 2: Add AUTONOMOUS COMPACTION DECISION Section
Insert after "WHEN TO USE:" section. Cover:
- Context gauge interpretation
- Content detection patterns
- Proactive compaction triggers

### Step 3: Add LOOP/ITERATION DETECTION Section
Document:
- How to detect iteration patterns
- What information must be preserved
- Good vs bad summary examples

### Step 4: Add RANGE PARTITIONING Section
Explain:
- When to partition vs single range
- How to identify topic boundaries
- Tool accepts array for single call

### Step 5: Add COMPACTION MODES Section
Document:
- Three modes and their meanings
- How LLM should behave in each mode
- Reasoning explanation guidance

### Step 6: Manual Testing
- Simulate high context scenario
- Verify LLM recognizes compaction opportunity
- Check reasoning explanation quality

## Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.txt` | Add autonomous decision, loop detection, partitioning, and mode guidance |

## Definition of Done

- [x] compact.txt updated with AUTONOMOUS COMPACTION DECISION section
- [x] Context gauge interpretation guidance included (>60%, >80% thresholds)
- [x] Loop/iteration detection guidance with good/bad examples
- [x] Range partitioning guidance included
- [x] Compaction modes (ask/notify/silent) documented
- [x] Reasoning explanation guidance for ask/notify modes
- [x] Manual testing confirms LLM can autonomously identify compaction opportunities
- [x] Manual testing confirms LLM explains reasoning appropriately

## Risk Notes

1. **LLM Judgment Quality**: Autonomous compaction decisions depend on LLM judgment. Over-compaction or poor timing could frustrate users. The "ask" mode provides a safety valve.

2. **Mode Behavior Not Yet Implemented**: The actual mode-aware execution logic is in Epic 4 (Stories 4.1-4.3). This story only documents the intended behavior in the tool description.

3. **Summary Quality for Iterations**: Loop/iteration summaries are critical - poor summaries could lose important debugging insights. The detailed guidance with examples helps, but quality depends on LLM following the guidance.

4. **No Automated Tests**: This story is primarily about tool description quality, tested through LLM interaction. Consider adding prompt-based tests if time permits.

## References

- Architecture: Compaction Architecture (docs/architecture.md:127-143)
- Architecture: Token Checkpoints (docs/architecture.md:199-220)
- Architecture: Tool Implementation (docs/architecture.md:249-261)
- Epics: Story 2.6 (docs/epics.md:598-654)
- Story 2.5: User-directed compaction (completed, baseline for compact.txt)
- Story 1.2: Context gauge injection (completed, gauge format reference)
- Story 1.5: Configuration extension (completed, mode config reference)
- Project Context: Testing standards (docs/project-context.md)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

None - documentation-only story, no debugging required.

### Completion Notes List

- Added AUTONOMOUS COMPACTION DECISION section with context gauge interpretation (>60%, >80% thresholds)
- Added content detection patterns for identifying compaction candidates
- Added LOOP/ITERATION DETECTION section with CRITICAL guidance on preserving learnings
- Included good vs bad iteration summary examples
- Added RANGE PARTITIONING section with topic boundary identification guidance
- Added COMPACTION MODES section documenting ask/notify/silent behaviors
- Added reasoning explanation guidance for ask/notify modes
- All 284 existing tests pass with no regressions

**Code Review Improvements (2025-12-31):**
- Refined compaction justification guidance: emphasis on "learnings captured" vs "already read"
- Added CRITICAL section: "Before compacting, verify the learnings are preserved"
- Updated example to demonstrate proper justification (insights captured, not just analyzed)
- Consolidated duplicate reasoning guidance sections

### File List

- `packages/opencode/src/tool/compact.txt` - Updated with autonomous decision, loop detection, partitioning, and mode guidance
- `docs/sprint-artifacts/sprint-status.yaml` - Updated story status to review

### Change Log

- 2025-12-31: Story 2.6 implementation complete - added LLM autonomous compaction decision guidance to compact.txt

---

_Story created by: /bmad:bmm:workflows:create-story_
_Model: Claude Opus 4.5_
_Date: 2025-12-31_
_Analysis depth: Deep codebase examination with actual file reading_
