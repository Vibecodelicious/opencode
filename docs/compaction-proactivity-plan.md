# Compaction Proactivity Plan

## Where tool instructions live
- Tool instructions are the `*.txt` files under `packages/opencode/src/tool/`.
- Example: `packages/opencode/src/tool/compact.txt` is loaded by `packages/opencode/src/tool/compact.ts` (via `import DESCRIPTION from "./compact.txt"`).
- Retrieve uses `packages/opencode/src/tool/retrieve.txt` in the same way.

## Goal
Make compaction more proactive so context stays focused on the current task, especially after task completion or project switches.

## Plan
1. **Update compaction guidance**
   - Edit `packages/opencode/src/tool/compact.txt` to add explicit triggers for:
     - Project/repo switches (e.g., moving from one codebase to another)
     - Completed task blocks (review finished, plan written, investigation concluded)
   - Emphasize that proactive compaction should happen even if the user didn’t request it, as long as it’s safe and summaries preserve value.

2. **Keep behavior consistent with existing flow**
   - No new toggles or logging; use existing ask/notify/silent modes.
   - Preserve two‑phase compaction flow and message ID requirements.

3. **Validation**
   - Manually verify the updated instructions appear in the compact tool description (call `compact` in prepare mode and confirm the new guidance is visible to the LLM).
   - No new tests unless instructions are moved into shared prompt infrastructure.

## Notes for implementation
- Keep edits local to `packages/opencode/src/tool/compact.txt` unless there’s a requirement to sync guidance across other prompts.
- Avoid creating new testing scaffolding; follow existing patterns.
