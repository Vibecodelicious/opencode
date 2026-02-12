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

1. **Prune tool** (`context-bonsai:prune`, renamed from "compact") — two-phase
   archiving: toggle message ID visibility, then archive a message range with an
   LLM-generated summary + index terms
2. **Retrieve tool** (`context-bonsai:retrieve`) — restore previously
   pruned/archived content back into the conversation
3. **Context gauges** — periodic token utilization checkpoints injected into the
   conversation as `<system-reminder>` tags (using OpenCode's existing system
   reminder pattern)
4. **Archived message rendering** — when constructing the conversation payload
   for the LLM, pruned messages are replaced with compact summary placeholders
   (the feature is useless without this)
5. **Notify mode (always on)** — the plugin operates automatically; the user is
   informed of what was pruned. No configuration knobs.
6. **Accurate utilization reporting** — whatever context gauge is shown must
   reflect actual token usage, though it necessarily lags one turn behind (token
   counts come from the previous assistant message's events). A future upstream
   change could expose current-turn token counts, but the plugin does not depend
   on it. OpenCode already has internal usage calculations; the plugin should
   leverage them rather than reinvent.

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

### Hard Blockers

- **Plugin data persistence**: The message schema has no extension point for
  plugin data. Requires adding `metadata: z.record(z.unknown()).optional()` to
  `MessageV2.Base` (1 line). Plugins namespace by package name within this bag.
- **Message read**: Already works at runtime — `messages` leaks through the
  `...ctx` spread and `as unknown as PluginToolContext` cast in
  `registry.ts:fromPlugin()` (line 67). Must be formalized on the ToolContext
  type AND explicitly mapped in `fromPlugin()` to avoid depending on an
  undocumented leak.
- **Message write**: Requires adding `updateMessage(id, fn)` to ToolContext,
  delegating to `Storage.update()` (atomic read-modify-write).
- **LLM for summarization**: Requires adding `languageModel` to ToolContext,
  delegating to `Provider.getLanguage()`.

Everything else works with existing hooks.

### Minimum Upstream Changes Required

1. **Add `metadata` to `MessageV2.Base` schema** (1 line in `message-v2.ts`)
2. **Add `languageModel: LanguageModelV2` to ToolContext** (~10 lines across 4
   files: `plugin/src/tool.ts`, `tool/tool.ts`, `session/prompt.ts`,
   `tool/registry.ts`)
3. **Add `updateMessage(id, fn)` to ToolContext** (~15 lines across 2 files:
   `plugin/src/tool.ts`, `tool/registry.ts`)
4. **Formalize `messages` on ToolContext** (type + explicit runtime mapping,
   `plugin/src/tool.ts` + `tool/registry.ts`)
5. **Add `pluginID` to ToolContext** (~15 lines across 3 files:
   `plugin/src/tool.ts`, `plugin/index.ts`, `tool/registry.ts` — requires
   changing loader return type to carry plugin provenance)
6. **Enrich transform hook input** (2 lines across 2 files: `prompt.ts:620`
   runtime + `plugin/src/index.ts:198` type — add `{ sessionID, model }` to
   eliminate fragile per-session side caches)

### Metadata Persistence

Solved by adding `metadata` to the message schema. Since it's a known Zod
field, it survives `Session.updateMessage()` which parses inputs through
`fn(MessageV2.Info, ...)` (`util/fn.ts:5`). No schema bypass needed. Plugin
data is stored in `msg.metadata[ctx.pluginID]`, namespaced to avoid
cross-plugin conflicts.

## Status / Next Steps

- [x] Agree on scope (in/out)
- [x] Read reference material (treated as untrusted hints)
- [x] Research upstream plugin system hooks
- [x] Research upstream conversation construction pipeline
- [x] Research upstream system reminder pattern
- [x] Research upstream token tracking
- [x] Document research findings (PROJECT_RESEARCH.md)
- [x] Write the proposal (PROJECT_PROPOSAL.md)
