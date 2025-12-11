# Story 1.4: ID-Annotated Context Builder

Status: Done

## Story

As a developer,
I want a function that builds context with message IDs prefixed to content,
so that the compaction LLM can reference specific messages by ID.

## Acceptance Criteria

1. Given an array of messages, when calling `toModelMessageWithIDs(messages)`, each message's text content is prefixed with `[msg_xxx]`.
2. Tool call parts retain their structure; ID prefixes apply only to text parts.
3. Archived messages show placeholders instead of original content (aligns with archive metadata).
4. The function follows existing `toModelMessage()` patterns and handles all part types correctly.
5. Used only for the compaction LLM call, not the main conversation.

## Tasks / Subtasks

- [x] Task 1 (AC: 1, 2, 4, 5): Implement ID-prefixed context builder in `packages/opencode/src/session/archive-context.ts`
  - [x] Subtask 1.1: Mirror `toModelMessage()` structure, prefixing only text parts with `[msg_<id>]`
  - [x] Subtask 1.2: Preserve tool call parts, attachments, and non-text parts without mutation
  - [x] Subtask 1.3: Ensure archived messages render placeholders (anchor) or are omitted (followers)
- [x] Task 2 (AC: 4): Integration and wiring
  - [x] Subtask 2.1: Export and reference builder where compaction LLM call is made
  - [x] Subtask 2.2: Add defensive handling for unsupported part types to avoid crashes
- [x] Task 3 (AC: 3, 4): Testing
  - [x] Subtask 3.1: Unit tests for ID prefixing across user/assistant/system/tool messages
  - [x] Subtask 3.2: Tests for archived anchor placeholder rendering and follower omission
  - [x] Subtask 3.3: Tests ensuring non-archived messages and tool call parts remain unchanged

## Dev Notes

- Architecture alignment: follows compaction summarization context format `[msg_xxx]` (docs/architecture.md#Compaction-Summarization-Context-Format); uses existing message IDs.
- Archive awareness: anchor messages with `archive` render `[SMART_ARCHIVED: ...]` placeholder; followers with `archivedBy` are omitted (reuse message-v2 logic).
- File target: new module `packages/opencode/src/session/archive-context.ts`; reuse patterns from `toModelMessage()` in `message-v2.ts`.
- Input handling: operate on the existing MessageV2 structures; do not mutate inputs; keep parts order intact.
- Usage scope: only for compaction LLM call; main conversation stays on `toModelMessage()`.
- Testing standards: bun:test; mirror source structure under `packages/opencode/test/session/archive-context.test.ts`; cover edge cases (mixed parts, archived ranges, empty parts).

### Project Structure Notes

- Source: `packages/opencode/src/session/archive-context.ts` (new), may be imported by compaction pipeline.
- Tests: `packages/opencode/test/session/archive-context.test.ts` (mirror path).
- Keep consistency with existing session/message utilities; avoid new dependencies.

### References

- docs/epics.md#Story-1.4
- docs/architecture.md#Sub-Agent-Context-Format
- docs/prd.md (Message identity, compaction context)
- docs/sprint-artifacts/1-3-message-schema-extension-for-archive-fields.md
- packages/opencode/src/session/message-v2.ts (existing render patterns)
- docs/project-context.md (testing and coding standards)

## Dev Agent Record

### Context Reference

- docs/epics.md
- docs/architecture.md
- docs/prd.md
- docs/project-context.md
- docs/sprint-artifacts/1-2-context-gauge-injection-logic.md
- docs/sprint-artifacts/1-3-message-schema-extension-for-archive-fields.md

### Agent Model Used

Codex (GPT-5) via CLI harness

### Debug Log References

### Completion Notes List
- Implemented `toModelMessageWithIDs` to mirror `toModelMessage` while prefixing text parts with `[msg_<id>]`, keeping tool/attachment structures and archive placeholders intact.
- Wired compaction flow to use the ID-annotated builder exclusively, leaving primary conversation rendering unchanged.
- Added bun tests covering ID prefixing, archive handling, ignored text, non-text preservation, and tool call rendering; full suite fails only on existing permission/storage setup outside this change.
- Hardened tool part rendering with defensive guards to skip malformed tool entries without crashing compaction context building.

### File List
- docs/sprint-artifacts/1-4-id-annotated-context-builder.md
- docs/sprint-artifacts/sprint-status.yaml
- packages/opencode/src/session/archive-context.ts
- packages/opencode/src/session/compaction.ts
- packages/opencode/test/session/archive-context.test.ts

### Change Log
- Added ID-prefixed context builder for compaction and accompanying tests; updated compaction pipeline to consume new builder.
