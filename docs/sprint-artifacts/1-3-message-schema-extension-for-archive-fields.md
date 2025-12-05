# Story 1.3: Message Schema Extension for Archive Fields

Status: review

## Story

As a developer,
I want to extend message schema with archive metadata,
so that messages can be marked as archived with summary and index terms.

## Acceptance Criteria

1. MessageV2 supports optional `archive` on the first message in a range:
   ```typescript
   archive: {
     summary: string
     indexTerms: string[]
     rangeEnd: string // ID of last message in archived range
   }
   ```
2. MessageV2 supports optional `archivedBy` on subsequent messages in the range:
   ```typescript
   archivedBy: string // ID of first message with archive data
   ```
3. Existing messages without these fields load/render unchanged (backwards compatible).
4. Rendering: `archive` messages render a `[SMART_ARCHIVED: start to end]` placeholder with summary/index terms; `archivedBy` messages are omitted from context.

## Tasks / Subtasks

- [x] Task 1: Schema extension in `packages/opencode/src/session/message-v2.ts` (AC: 1, 2)
- [x] Task 2: Rendering guardrails in `toModelMessage()` (AC: 3, 4)
- [x] Task 3: Tests for placeholder rendering and skip logic (AC: 3, 4)

## Dev Notes

- Keep it minimal: anchor renders placeholder, follower is skipped; no extra refinements. If review churn or scope creep appears, fall back to the core goal: add schema and render placeholders, not police every misuse.
- Define `Archive` shape once and reuse. Avoid clever validation that risks backcompat.
- Test the simple branches: anchor placeholder, follower skip, normals unaffected, dual-state treated as anchor defensively.
- Time Traveler Council outcome: keep scope tight to `message-v2.ts` schema + render; reuse a single Archive type; add small, reviewer-friendly tests that document behavior so future devs don’t “fix” it away.

## Story Requirements

- Archive metadata lives on the first message of an archived range; followers point back via `archivedBy`. Storage remains file-based; original `parts[]` stay intact. IDs use existing `msg_xxx` format with `rangeEnd` pointing to the last message ID.
- Placeholder format per architecture: `[SMART_ARCHIVED: msg_start to msg_end]` (or single ID if no rangeEnd) followed by summary and index terms. Only anchor renders; followers are omitted to save tokens.
- Backwards compatibility: fields optional; existing messages load/render unchanged.
- Keep rendering compatible with existing parts (including ContextGaugePart) and message union patterns.

## Developer Context

- Architecture guardrails: archive metadata only on anchor; followers reference anchor. No new storage namespace. Retrieval tool will rely on `archive.rangeEnd` + `archivedBy` layout.
- Rendering expectations: anchor → placeholder; follower → skip. Context gauge and other parts must continue to render as-is. Avoid cache-breaking insertions; placeholders replace rendering only.
- Zod usage: reuse a single `Archive` type in `message-v2.ts`; keep fields optional for backcompat; avoid extra refinements.
- Scope discipline: limit code changes to `message-v2.ts` plus focused tests.

## Technical Requirements

- Add optional `archive` and `archivedBy` to MessageV2 schema (Zod) with a shared `Archive` shape.
- Update `toModelMessage()` to render anchors as `[SMART_ARCHIVED: msg_start to msg_end]` with summary/index terms; omit followers.
- Preserve existing rendering for non-archived messages and other part types (including context gauge).
- Ensure types integrate with the Part discriminated union without breaking existing parsing.

## Architecture Compliance

- Align with architecture placeholder format and archive metadata design (docs/architecture.md#Placeholder-Format, #Archive-Storage-Design).
- Honor message ID stability; do not introduce new ID patterns.
- Avoid modifying storage layout; metadata only.

## Library/Framework Requirements

- Use existing Zod import/style in `message-v2.ts`.
- Keep types strict (no `any`); optional fields for backcompat.

## File Structure Requirements

- Touch `packages/opencode/src/session/message-v2.ts` for schema/render changes.
- Add/update tests in `packages/opencode/test/session/message-v2.archive.test.ts` (or similar) mirrored path.

## Testing Requirements

- Unit tests: anchor placeholder render, follower skip, normal messages unchanged, dual-state treated as anchor defensively.
- Backcompat: messages without archive fields still parse/render.
- Keep tests small and readable for reviewer speed.

## Latest Technical Information

- No external tech updates required; schema-only change relies on existing Zod patterns and message rendering.

## Previous Story Intelligence

- Story 1.2 implemented ContextGaugePart injection and rendering. Ensure archive placeholder logic does not interfere with gauge rendering or append-only parts.

## Git Intelligence Summary

- Recent commits added ContextGaugePart schema and gauge injection; keep consistency with existing message-v2 patterns and rendering style.

## Project Context Reference

- docs/project-context.md

## Story Completion Status

- Status: review
- Note: Core goal is schema + placeholder rendering; if review scope creeps, re-anchor to that goal.

## Sprint Status Update

- Updated: sprint-status.yaml set 1-3-message-schema-extension-for-archive-fields to review after implementation and tests.

## Dev Agent Record

### Context Reference

docs/epics.md, docs/architecture.md, docs/prd.md, docs/sprint-artifacts/1-2-context-gauge-injection-logic.md, docs/project-context.md

### Agent Model Used

Codex (GPT-5)

### Debug Log References

- XDG_CACHE_HOME=/tmp/opencode-cache XDG_DATA_HOME=/tmp/opencode-test-data bun test packages/opencode/test/session

### Completion Notes List

- Added Archive schema (summary/indexTerms/rangeEnd) and archivedBy optional fields to MessageV2; reused shared Archive type.
- Updated toModelMessage to render SMART_ARCHIVED placeholders for anchors and skip archivedBy followers, with defensive dual-state handling.
- Added archive-focused tests covering schema parsing and placeholder rendering/skip logic.
- Added partitionByArchive helper to split anchors/followers/normal messages and covered with tests.

### File List

- packages/opencode/src/session/message-v2.ts
- packages/opencode/test/session/message-v2.archive.test.ts
