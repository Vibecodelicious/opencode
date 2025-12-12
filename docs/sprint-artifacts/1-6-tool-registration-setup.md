# Story 1.6: Tool Registration Setup

Status: ready-for-dev

## Story

As a developer,
I want placeholder registrations for Compact and Retrieve tools,
so that the tool infrastructure is ready for implementation.

## Acceptance Criteria

1. Compact and Retrieve tools are registered in `tool/registry.ts` and appear in `all()`.
2. Each tool has a stub implementation using `Tool.define(...)` that returns "Not yet implemented".
3. Each tool has a `.txt` description with a concise summary and usage notes.
4. Proper TypeScript types and existing tools remain unaffected (no regressions, respects config/permissions patterns).

## Tasks / Subtasks

- [ ] Task 1 (AC: 1, 2): Add stub tool implementations for Compact and Retrieve.
  - [ ] Subtask 1.1: Create `packages/opencode/src/tool/compact.ts` stub with correct schema + stub output.
  - [ ] Subtask 1.2: Create `packages/opencode/src/tool/retrieve.ts` stub with correct schema + stub output.
- [ ] Task 2 (AC: 3): Add description files for both tools.
  - [ ] Subtask 2.1: Create `packages/opencode/src/tool/compact.txt` with basic description/params.
  - [ ] Subtask 2.2: Create `packages/opencode/src/tool/retrieve.txt` with basic description/params.
- [ ] Task 3 (AC: 1, 4): Register both tools in `packages/opencode/src/tool/registry.ts` `all()` without impacting existing entries; ensure typing/permissions stay consistent.
  - [ ] Subtask 3.1: Verify registry exports include Compact and Retrieve and remain deterministic.
  - [ ] Subtask 3.2: Confirm existing tools and experimental gating (e.g., batch) still work.

## Story Requirements (from epics/prd)

- Provide Compact/Retrieve scaffolding only: no storage, placeholders, or LLM calls yet.
- Follow tool patterns from architecture: `Tool.define`, clear descriptions, Zod parameter schemas.
- Keep message IDs, archive metadata, and placeholder logic untouched (future stories rely on stability).
- Compaction modes (ask/notify/silent) from Story 1.5 remain authoritative for later implementation.

## Developer Context

- Architecture doc: tools live under `tool/`, use `Tool.define`; registry returns `all()` and filters by provider/permissions; Smart Archive placeholders use `[SMART_ARCHIVED: ...]` (do not conflict).
- PRD: compact/retrieve are dual tools; MVP uses file-based storage and exact ID lookup—stubs must not claim functionality.
- Codebase patterns: strict TypeScript, Zod validation, mirrored tests (`packages/opencode/test/...`), avoid breaking registry ordering or experimental gating (`batch` flag).

### Technical Requirements / Guardrails

- Tool IDs: `compact`, `retrieve`; exports named `CompactTool`, `RetrieveTool`.
- Stubs return a friendly "Not yet implemented" message and set empty metadata; no side effects.
- Parameter schemas:
  - Compact: accept `ranges` array of `{ startMessageId: string; endMessageId?: string }` (keeps shape aligned with planned Story 2.1).
  - Retrieve: accept `{ archiveId: string }`.
- Descriptions mention placeholder status and intended future behavior; no false claims of archiving/retrieval.
- Registry: append tools alongside existing built-ins before custom plugins; respect provider filtering (codesearch/websearch rules), preserve experimental batch toggling.
- No new dependencies; reuse existing `zod` import style.

### Architecture Compliance

- Use `Tool.define` pattern and `Tool.Info` typing from `tool.ts`.
- Keep registry deterministic and side-effect free; do not alter permission gating in `enabled`.
- Avoid touching message rendering, storage, or compaction logic.

### Library / Framework Requirements

- TypeScript strict mode; Zod for parameter validation.
- No network or external library additions for stubs.

### File Structure Requirements

- New files: `packages/opencode/src/tool/compact.ts`, `packages/opencode/src/tool/compact.txt`, `packages/opencode/src/tool/retrieve.ts`, `packages/opencode/src/tool/retrieve.txt`.
- Modified: `packages/opencode/src/tool/registry.ts` to include new tools in `all()`.

### Testing Requirements

- Add or plan unit tests under `packages/opencode/test/tool/` to assert:
  - Registry `all()` includes compact/retrieve when experimental flags are unchanged.
  - Parameter validation errors are clear for invalid payloads.
  - Stubs return the expected "Not yet implemented" output.
- Run `bun test:no_external_deps` when implemented; current step focuses on scaffolding.

## Previous Story Intelligence

- Story 1.5 added compaction config (mode ask/notify/silent, enabled toggle) with CLI/env overrides; future tool behavior must respect these settings—stubs should not bypass config expectations.
- Tests and Zod patterns from Story 1.5 offer validation style to mirror for tool schemas.

## Git Intelligence Summary

- Recent commit `feat: extend compaction configuration controls` touched config, flags, prompt, compaction, message-v2; reinforces that compaction mode is already configurable—keep compatibility and avoid schema churn in this story.

## Project Context Reference

- docs/epics.md, docs/architecture.md, docs/prd.md, docs/project-context.md

## Story Completion Status

- Target status: ready-for-dev once code/tests updated and registry entries verified.
- Story file: docs/sprint-artifacts/1-6-tool-registration-setup.md
