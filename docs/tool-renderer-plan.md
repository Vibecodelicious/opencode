# TUI Tool Renderers Plan (compact, retrieve)

## Key facts
- Tool renderers live in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`.
- Tool output is passed to renderers as `props.output` (from `props.part.state.output`).
- There are no renderers registered for `compact` or `retrieve`; they fall back to `GenericTool` which ignores output.
- Existing output patterns:
  - `patch` uses `props.output` and renders a simple text block.
  - `bash` uses `props.metadata.output` and `stripAnsi`.
- Tool entries are hidden when “tool details” are off; keep this behavior.

## Implementation
- Add `ToolRegistry.register` entries for:
  - `compact` (container: `block`)
  - `retrieve` (container: `block`)
- Renderer behavior:
  - Title line via `ToolTitle` (similar to `patch`).
  - Render body only when `props.output?.trim()` exists.
  - Use `<text fg={theme.text}>{props.output.trim()}</text>` for output.
  - For `retrieve`, include `input(props.input)` in the title to show `archiveId`.
  - For `compact`, avoid `input(props.input)` (ranges are non‑primitive); optionally show `props.metadata.rangeCount` if desired.
- Do not add new logging, toggles, or truncation logic.

## Verification
- Run `compact` and `retrieve` in a session and confirm:
  - Title line shows with tool name.
  - Output body appears under the tool entry.
  - “tool details” toggle still hides the tool entry as before.
