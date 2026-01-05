# Story 3.2: LLM Autonomous Retrieval

Status: done

## Story

As a user,
I want the LLM to autonomously retrieve archived content when relevant,
So that important context is restored without manual intervention.

## Acceptance Criteria

1. **Autonomous Retrieval Decision** - LLM calls Retrieve tool when archived content is relevant (topic match, task dependency, explicit reference)

2. **Summary vs Full Content** - LLM evaluates if summary suffices; retrieves only when specific details needed

3. **Mode Behavior** - Explains retrieval in ask/notify modes; no permission required (unlike compaction)

## Tasks

- [x] Task 1: Add autonomous retrieval guidance to retrieve.txt
  - [x] Add "AUTONOMOUS RETRIEVAL" section with decision framework
  - [x] Add "WHEN NOT TO RETRIEVE" anti-patterns
  - [x] Add mode explanation guidance

- [x] Task 2: Validate
  - [x] Review for alignment with compact.txt style
  - [x] Verify no conflicting instructions

## Dev Notes

### What This Story Is

**Tool description update only** - retrieve.ts is complete from Story 3.1. This story adds LLM guidance for autonomous retrieval decisions to retrieve.txt.

### File to Modify

`packages/opencode/src/tool/retrieve.txt` - Add ~40 lines of autonomous retrieval guidance.

### Content to Add to retrieve.txt

```
AUTONOMOUS RETRIEVAL:
Proactively retrieve when archived content would help answer the current question or task.

When to retrieve:
1. Index term match - User question matches archive index terms
2. Summary insufficient - Need specifics beyond what summary provides
3. Explicit reference - User asks about something that was archived
4. Task dependency - Current implementation needs archived details

When NOT to retrieve:
1. Summary answers the question - High-level queries don't need full content
2. Unrelated to current task - Don't retrieve just because archives exist
3. Already retrieved - Same archive already in current context

RETRIEVAL DOESN'T REQUIRE PERMISSION:
Unlike compaction, retrieval is read-only. Proceed when helpful.

EXPLANATION (ask/notify modes):
Briefly state what you're retrieving and why.
Example: "Retrieving the auth discussion - the summary doesn't have the middleware order you're asking about."
```

### Key Distinction from Compaction

| Aspect | Compaction | Retrieval |
|--------|-----------|-----------|
| Effect | Removes context | Adds context |
| Permission | Requires mode-based permission | No permission needed |
| Explanation | Required in ask/notify | Courtesy in ask/notify |

## Definition of Done

- [x] retrieve.txt includes autonomous retrieval decision guidance
- [x] retrieve.txt includes anti-patterns (when NOT to retrieve)
- [x] retrieve.txt includes mode explanation guidance
- [x] Style aligns with compact.txt

## References

- Architecture: docs/architecture.md:226-234 (Retrieval Architecture)
- PRD: FR15 (LLM autonomous retrieval)
- Pattern reference: packages/opencode/src/tool/compact.txt (autonomous guidance example)
- Story 3.1: Retrieve tool implementation (complete)

---

## Dev Agent Record

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Completion Notes List

- Added ~38 lines of autonomous retrieval guidance to retrieve.txt
- Added "AUTONOMOUS RETRIEVAL" section with 4 decision criteria (index term match, summary insufficient, explicit reference, task dependency)
- Added "When NOT to retrieve" anti-patterns (3 cases: summary answers, unrelated to task, already retrieved)
- Added "RETRIEVAL DOESN'T REQUIRE PERMISSION" section explaining difference from compaction
- Added "EXPLANATION (ask/notify modes)" section with example explanations
- Validated style alignment with compact.txt (all-caps headers, bold numbered lists, inline examples)
- No code changes - documentation-only update

### Code Review Fixes (AI)

- Fixed style inconsistency: Changed `**When to retrieve:**` → `WHEN TO RETRIEVE:` (ALL-CAPS header)
- Fixed style inconsistency: Changed `**When NOT to retrieve:**` → `WHEN NOT TO RETRIEVE:` (ALL-CAPS header)

### File List

- packages/opencode/src/tool/retrieve.txt (modified)

### Change Log

- 2026-01-05: Added autonomous retrieval guidance to retrieve.txt (Story 3.2)
- 2026-01-05: Code review polish - fixed header style inconsistencies

---

_Story: 3.2 | Created: 2026-01-05 | Model: Claude Opus 4.5_
