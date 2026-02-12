# PROJECT: Context Bonsai Plugin Proposal

## What We're Doing

Creating a **proposal** for how to re-implement the "Context Bonsai" (surgical
compaction) feature as an **OpenCode plugin** (npm package), rather than the
current direct integration on the `surgical_compaction` branch.

The proposal must:
- Require **minimal upstream OpenCode modifications**
- Be **grounded in actual upstream code** — every feasibility claim must
  reference real code on the `dev` branch
- Be high-level (not implementation-ready code)

## Scope: What the Plugin MUST Implement

1. **Prune tool** (renamed from "compact") — two-phase archiving: toggle
   message ID visibility, then archive a message range with an LLM-generated
   summary + index terms
2. **Retrieve tool** — restore previously pruned/archived content back into the
   conversation
3. **Context gauges** — periodic token utilization checkpoints injected into the
   conversation as `<system-reminder>` tags (using OpenCode's existing system
   reminder pattern)
4. **Archived message rendering** — when constructing the conversation payload
   for the LLM, pruned messages are replaced with compact summary placeholders
   (the feature is useless without this)
5. **Notify mode (always on)** — the plugin operates automatically; the user is
   informed of what was pruned. No configuration knobs.
6. **Accurate utilization reporting** — whatever context gauge is shown must
   reflect actual token usage. OpenCode already has internal usage calculations;
   the plugin should leverage them rather than reinvent.

## Scope: What is EXPLICITLY OUT OF SCOPE

- **Gauge ramping** (variable frequency based on utilization) — not needed,
  though some periodic gauge mechanism is required
- **Autonomy mode selection** (ask/notify/silent) — always notify, no user
  choice
- **Post-compaction gauge reset as a separate mechanism** — OpenCode already
  recalculates usage internally; rely on that

## Reference Material

- **Current implementation**: `surgical_compaction` branch on this repo — serves
  as a partial reference for how the feature works, but the plugin must be
  structured differently
- **Previous analysis notes**: branch
  `origin/claude/analyze-context-plugin-feasibility-xf6nl` — contains docs in
  `docs/context-bonsai-plugin-feasibility.md` and
  `docs/proposal-plugin-hooks.md`. **UNTRUSTED** — the LLM went off on tangents
  and changed requirements. Treat as potentially helpful hints only.
- **Upstream README**: standard OpenCode — the `dev` branch is the upstream
  default

## Key Findings

Full research details with code references are in **PROJECT_RESEARCH.md**.

### Upstream Plugin System (verified against `upstream/dev`)

Upstream already has **16 hooks** including two critical experimental ones:

- **`experimental.chat.messages.transform`** — fires at `prompt.ts:620`, BEFORE
  `toModelMessages()`. Plugin receives the `WithParts[]` array and can modify it
  in-place. This enables archived message rendering and context gauge injection
  WITHOUT upstream changes.
- **`experimental.chat.system.transform`** — lets plugins modify the system
  prompt array. Input includes `{ sessionID?, model }`.

Plugin **ToolContext** (`packages/plugin/src/tool.ts`) has: `sessionID`,
`messageID`, `agent`, `directory`, `worktree`, `abort`, `metadata()`, `ask()`.
No message read/write. No languageModel.

### What Upstream CAN Do Today (no changes needed)

- Register prune/retrieve tools via `tool` hook
- Modify messages before LLM via `experimental.chat.messages.transform`
- Inject system prompt guidance via `experimental.chat.system.transform`
- Track token usage via `event` hook (message.updated events include tokens)
- Get model context limit via `chat.params` or system transform hooks (cache it)

### The ONE Hard Blocker

**Plugin ToolContext lacks session message read/write and languageModel access.**
Without this, the prune and retrieve tools cannot:
- Read messages to identify what to archive
- Write archive metadata to messages
- Call the LLM for summarization

Everything else works with existing hooks.

### Minimum Upstream Change Required

**Enhance Plugin ToolContext with a session API** — add `messages()`,
`message(id)`, `updateMessage(id, fn)`, and `languageModel` to ToolContext.
Implementation delegates to existing internal APIs (`Session.messages`,
`MessageV2.get`, `Storage.update`, `Provider.getLanguage`). See
PROJECT_RESEARCH.md Section 9 for details.

**Nice-to-have**: Enrich `experimental.chat.messages.transform` input from `{}`
to `{ sessionID, model }` for easier gauge computation.

### Metadata Persistence Concern

`Session.updateMessage()` uses `Storage.write()` (blind overwrite), which could
clobber custom fields added by the plugin. The proposed `updateMessage(id, fn)`
uses `Storage.update()` (atomic read-modify-write) which preserves other fields.
But if OpenCode core later calls `Session.updateMessage()` on the same message,
the plugin's fields could be lost. Need to audit call sites or use sidecar
storage.

## Status / Next Steps

- [x] Agree on scope (in/out)
- [x] Read reference material (treated as untrusted hints)
- [x] Research upstream plugin system hooks
- [x] Research upstream conversation construction pipeline
- [x] Research upstream system reminder pattern
- [x] Research upstream token tracking
- [x] Document research findings (PROJECT_RESEARCH.md)
- [x] Write the proposal (PROJECT_PROPOSAL.md)
