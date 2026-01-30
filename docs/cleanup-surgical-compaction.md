# Cleanup Plan: surgical_compaction -> upstream/dev

This repo is mid-cleanup for a merge. The goal is to produce a small, logical series of commits that each pass tests, based on `origin/surgical_compaction` (the current mainline for this work), and then re-apply those clean commits on top of `upstream/dev` for final merge.

## Mainline + eventual merge targets

- Mainline for cleanup: `origin/surgical_compaction`
- Eventual merge target: `upstream/dev`

## Current status snapshot (as of this doc)

- Branch: `dev`
- Tracking upstream: `vibecodelicious/dev`
- Ahead of `origin/surgical_compaction` by: 1 commit
  - `fcb0b6493 Update compaction guidance`
- Uncommitted changes:
  - `packages/opencode/src/tool/compact.txt`
  - `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Untracked files that should NOT be committed:
  - `.opencode/**`
  - `_bmad/`
  - `.bmad_old/`
- Untracked docs (decide whether to include or leave untracked):
  - `docs/compaction-proactivity-plan.md`
  - `docs/tool-renderer-plan.md`

## Clean commit plan (each step test-clean)

1. **docs(compact): strengthen proactive compaction guidance**
   - Files: `packages/opencode/src/tool/compact.txt`
   - Fold the existing commit + current working tree changes into one coherent doc commit.
   - Tests: none required (doc only).

2. **feat(tui): render compact/retrieve tool output**
   - Files: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
   - Tests: none required (no TUI tests available).

3. **docs: compaction/tool renderer planning notes** (optional)
   - Files: `docs/compaction-proactivity-plan.md`, `docs/tool-renderer-plan.md`
   - Commit only if these are intended for mainline; otherwise keep untracked.

## Cleanup execution steps

1. Create a clean branch from the mainline baseline:
   - `git checkout -b cleanup origin/surgical_compaction`
2. Apply the changes in order and commit:
   - Commit 1: compact guidance in `packages/opencode/src/tool/compact.txt`
   - Commit 2: TUI renderer changes in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
   - Commit 3: optional docs
3. Keep local tooling files out of git:
   - `.opencode/**`, `_bmad/`, `.bmad_old/`

## Re-apply on upstream/dev

After the clean series exists:

1. `git checkout -b cleanup-on-upstream upstream/dev`
2. Cherry-pick the clean commits (in order) onto this branch.
3. Run tests once after all picks (or after each commit if desired).

## Test guidance (repo-specific)

- Run tests from repo root.
- Preferred test command (no external deps):
  - `bun test:no_external_deps`
- For this specific cleanup, tests are optional because changes are docs/TUI display, but run at least once before final merge if possible.

## Useful git commands

- Show delta vs surgical_compaction:
  - `git log --oneline origin/surgical_compaction..HEAD`
  - `git diff --stat origin/surgical_compaction...HEAD`
- Current status:
  - `git status --short`
