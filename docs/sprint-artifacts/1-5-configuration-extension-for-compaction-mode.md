# Story 1.5: Configuration Extension for Compaction Mode

Status: ready-for-dev

## Story

As a user,
I want to configure my preferred compaction mode,
so that I can control how autonomous the LLM is with compaction decisions.

## Acceptance Criteria

1. Config supports:
   ```typescript
   compaction: {
     mode: "ask" | "notify" | "silent", // default: "notify"
     enabled: boolean, // default: true
   }
   ```
2. Settings persist across sessions.
3. Settings are changeable via config file or CLI.
4. Invalid values are rejected with helpful error messages.

## Tasks / Subtasks

- [ ] Task 1 (AC: 1, 2): Extend config schema and defaults in `packages/opencode/src/config/config.ts` with `compaction.mode` and `compaction.enabled`, defaulting to `"notify"` and `true`; ensure persisted/loaded settings remain stable.
  - [ ] Subtask 1.1: Add Zod validation for `mode` union and boolean `enabled`, with clear error messages.
  - [ ] Subtask 1.2: Ensure defaults apply when values are missing and do not break existing configs.
- [ ] Task 2 (AC: 2, 3): Wire config loader/CLI override so mode and enabled can be set via config file or CLI flag pattern consistent with existing config handling.
  - [ ] Subtask 2.1: Document/propagate the new options through config accessors.
  - [ ] Subtask 2.2: Verify values are visible where compaction tooling will consume them.
- [ ] Task 3 (AC: 4): Add tests covering valid/invalid config values and defaults.
  - [ ] Subtask 3.1: Tests for valid modes and boolean enabled.
  - [ ] Subtask 3.2: Tests for invalid mode values and non-boolean enabled with helpful errors.

## Dev Notes

- Implement in `packages/opencode/src/config/config.ts` following existing config patterns; keep backwards compatibility with current config shape.
- Defaults: `mode: "notify"`, `enabled: true`; keep unset fields non-breaking for existing users.
- Validation: use existing Zod-based patterns; ensure error messages surface invalid mode/boolean values cleanly.
- Consumption: compaction tooling (Epic 4) will honor these settings; ensure config accessors expose the new fields.
- Testing: align with project standards in `docs/project-context.md`; place tests alongside config tests (e.g., `packages/opencode/test/config/...`).

### Project Structure Notes

- Source: `packages/opencode/src/config/config.ts`
- Tests: mirror path under `packages/opencode/test/`
- Keep consistency with current config loader and CLI override patterns.

### References

- docs/epics.md#Story-1.5
- docs/prd.md (Configuration Integration)
- docs/project-context.md (testing and coding standards)
- docs/sprint-artifacts/1-4-id-annotated-context-builder.md (recent patterns and learnings)

## Dev Agent Record

### Context Reference

- docs/epics.md
- docs/prd.md
- docs/project-context.md
- docs/sprint-artifacts/1-4-id-annotated-context-builder.md

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List

