# Context Bonsai: Plugin Feasibility Analysis

## Executive Summary

**Can Context Bonsai be rewritten as a plugin? Yes — with two targeted changes to OpenCode's plugin surface area.**

Two proposed changes (`chat.context` hook + Session API in `ToolContext`) close the core gaps: context transformation and message read/write access. The Session API includes a `languageModel` field that exposes the session's pre-configured `LanguageModel` instance (from `Provider.getModel()`), giving the plugin direct access to `generateText()` / `streamText()` with all provider configuration — custom base URLs, auth tokens, headers, middleware — already applied. This is fully side-effect-free (no session mutation, no `loop()`, no events) and equivalent to the core compact tool's `SessionProcessor` + `streamText()` path. See `docs/proposal-plugin-hooks.md` for the full proposal.

---

## What Context Bonsai Touches

The feature modifies **13+ source files** across 5 architectural layers:

| Layer | Files | What It Does |
|-------|-------|-------------|
| **Tool definitions** | `tool/compact.ts`, `tool/retrieve.ts`, `tool/compact.txt`, `tool/retrieve.txt` | Two new tools the LLM can call |
| **Message schema** | `session/message-v2.ts` | New `archive`, `archivedBy`, `ContextGaugePart` fields on messages |
| **Conversation rendering** | `session/message-v2.ts` (`toModelMessage`), `session/archive-context.ts` | Replaces archived messages with placeholders; skips `archivedBy` messages; conditionally prefixes message IDs |
| **Session pipeline** | `session/prompt.ts`, `session/compaction.ts`, `session/compaction-mode-state.ts`, `session/system.ts`, `session/prompt/compaction.txt` | Context gauge injection, overflow handling, summarization LLM call routing, system prompt for compaction |
| **TUI + share** | `cli/cmd/tui/routes/session/index.tsx`, `share/share-next.ts` | Tool result rendering, filtering gauge parts from enterprise sync |

---

## What the Plugin System Can Do Today

OpenCode's plugin system provides these hooks (from `packages/plugin/src/index.ts`):

| Hook | What It Allows |
|------|----------------|
| `tool` | Register custom tools with description, args (Zod), and execute function |
| `chat.message` | Intercept a new **user** message after creation, before storage — can modify message and parts |
| `chat.params` | Modify `temperature`, `topP`, and provider `options` before the LLM call |
| `tool.execute.before` | Modify tool arguments before execution |
| `tool.execute.after` | Modify tool output after execution |
| `permission.ask` | Override permission decisions (allow/deny/ask) |
| `event` | Subscribe to all bus events (message.updated, session.compacted, etc.) |
| `config` | Receive configuration at init |
| `auth` | Add authentication methods |

Plugins also receive a `PluginInput` with: `client` (SDK), `project`, `directory`, `worktree`, and `$` (Bun shell).

---

## Feature-by-Feature Feasibility

Each section describes the current plugin gap **and** how the proposed changes resolve it (or don't).

### 1. Compact & Retrieve Tools — TODAY: Partial → WITH PROPOSAL: Yes

**What works today:** A plugin can register `compact` and `retrieve` tools via the `tool` hook. The LLM sees them and can call them.

**Gaps in today's plugin system:**
- **No access to message storage.** The compact tool needs to read all session messages, iterate over them by ID, and write `archive`/`archivedBy` metadata to specific messages. The plugin `ToolContext` only provides `sessionID`, `messageID`, `agent`, and `abort` — no Storage or Session API.
- **No LLM call path.** The compact tool makes a secondary `streamText()` call to generate summaries, routed through `SessionProcessor` with the session's configured provider. Plugins have no access to `SessionProcessor` or the pre-configured `LanguageModel` instance.
- **No way to trigger two-phase flow.** The prepare phase sets `CompactionModeState`, which is an in-memory singleton Map that `toModelMessage()` reads to decide whether to prefix message IDs. A plugin can't set this state or influence `toModelMessage` behavior.

**How the proposal resolves these:**
- **Storage gap** → Resolved by `ToolContext.session` API. `messages()`, `message(id)`, `updateMessage(id, fn)`, and `addPart()` give plugins full read/write access with atomic semantics.
- **LLM summarization** → Resolved via `ToolContext.session.languageModel`. The Session API exposes the session's pre-configured `LanguageModel` instance (from `Provider.getModel()`), which has all provider configuration baked in: custom base URLs, auth tokens from `auth.json`, provider-specific headers (e.g., Anthropic beta headers), AWS Bedrock credential chains, Google Vertex project/location, and any plugin auth loader output. The plugin calls `generateText({ model: ctx.session.languageModel, system: "...", messages: [...] })` directly — fully side-effect-free, no session mutation, equivalent to the core compact tool's internal `streamText()` path. This avoids `client.session.prompt()` entirely (which persists messages and runs the full `loop()`).
- **Two-phase flow** → Resolved by `chat.context` hook. The plugin maintains its own in-memory state and applies message ID prefixing in the hook callback, bypassing `CompactionModeState` entirely.

### 2. Message Archival Rendering — TODAY: Not feasible → WITH PROPOSAL: Yes

This is the **core architectural gap**. When OpenCode builds the conversation to send to the LLM, it calls `MessageV2.toModelMessage()` which:

1. Checks each message for `archive` metadata → renders a `[SMART_ARCHIVED]` placeholder instead
2. Checks each message for `archivedBy` → skips it entirely
3. Optionally prefixes all content with `[msg_xxx]` when compaction mode is enabled

**There is no plugin hook today** that intercepts or modifies the messages array before `streamText()`. The conversation construction at `prompt.ts:705-727` is hardcoded.

**How the proposal resolves this:** The `chat.context` hook fires *before* `toModelMessage()`, giving plugins the `WithParts[]` array. A plugin can filter out archived messages, inject summary placeholders, and apply message ID prefixing — all before OpenCode's own conversion runs.

### 3. Context Gauge — TODAY: Not feasible → WITH PROPOSAL: Yes

The context gauge is a **compaction trigger for the model**, not an observability feature. It injects text like `[CONTEXT GAUGE: 67,000 / 100,000 tokens (67%)]` into the conversation so the model sees its own context pressure and proactively looks for compaction opportunities. The compact tool's system prompt tells the model to monitor these gauges and compact at 60-80% utilization. Gauge frequency ramps up as context fills (sparse early, frequent near capacity).

**How the proposal resolves this:** The `chat.context` hook fires before every LLM call. The plugin:
1. Tracks token usage from `message.updated` events via the existing `event` hook (assistant messages include token counts)
2. Computes utilization against the model's context limit (available from `chat.context` input's `model` field or `ToolContext.extra`)
3. Injects gauge text as a `<system-reminder>`-tagged synthetic text part on the last user message in the `chat.context` callback

This follows the established `insertReminders()` pattern (`prompt.ts:1251-1277`), which already injects `<system-reminder>`-tagged synthetic parts on user messages for plan mode and build-switch notifications. The system prompts for Claude, Qwen (the fallback), and Polaris explicitly prime the model to attend to `<system-reminder>` tags. However, the system prompts for GPT-series (`beast.txt`), Gemini (`gemini.txt`), and GPT-5 (`codex.txt`) do **not** include this priming — the model sees the tags but isn't told what they mean. The `insertReminders()` function injects `<system-reminder>` content on all models regardless (`prompt.ts:1251-1277` has no provider check), so the existing pattern is already provider-inconsistent. A plugin would inherit the same inconsistency, which is acceptable — the gauge text itself (`[CONTEXT GAUGE: ...]`) is meaningful even without the tag wrapper.

This is simpler than the core implementation, which persists a `ContextGaugePart` schema type on assistant messages and renders it in `toModelMessage()`. The plugin just needs the model to *see* the gauge; it doesn't need to persist it as a typed part.

### 4. Compaction Mode State — TODAY: Not feasible → WITH PROPOSAL: Yes

**How the proposal resolves this:** The plugin maintains its own in-memory state (no dependency on `CompactionModeState`). The `chat.context` hook gives the plugin full control over message content before `toModelMessage()`, so it can apply message ID prefixing directly.

### 5. Message Schema Extensions — TODAY: Not feasible → WITH PROPOSAL: Yes

**How the proposal resolves this:** The `updateMessage(id, fn)` callback receives a mutable draft of `MessageV2.Info`. Plugins can set arbitrary fields (e.g., `archive`, `archivedBy`) without schema changes. The storage layer is raw JSON throughout — `Storage.read()` returns `Bun.file().json()` with a type assertion (`storage.ts:168-176`), and `Storage.update()` reads, mutates, and writes back without validation. Zod schemas exist for type generation but are never applied to the read or write path. Custom fields survive the full cycle by design, not by accident.

### 6. Overflow Detection & Auto-Compaction — TODAY: Not feasible → WITH PROPOSAL: Unnecessary

If a plugin prunes context effectively via `chat.context`, the model sees fewer tokens, the API reports lower usage, and `isOverflow()` won't trigger on the next turn. Built-in compaction acts as a safety net, not a conflict.

### 7. TUI Rendering — TODAY: Not feasible → WITH PROPOSAL: Partial (nice-to-have)

No plugin hook for custom TUI components. Tool results render as raw text. This is a cosmetic limitation, not a functional blocker.

### 8. Enterprise Share Filtering — TODAY: Not feasible → WITH PROPOSAL: Not addressed

The `share-next.ts` change filters `ContextGaugePart` from enterprise sync. No plugin hook exists for share/export filtering. Low priority — plugins can avoid adding sensitive parts in the first place.

---

## What Would Be Needed to Make It Fully Plugin-Compatible

To move Context Bonsai entirely to a plugin, OpenCode would need two changes (see `docs/proposal-plugin-hooks.md` for the full proposal):

### Critical (Feature Won't Work Without These)

1. **`chat.context` hook** — A hook that lets a plugin transform the `WithParts[]` message array **after** retrieval from storage but **before** `toModelMessage()` conversion and `streamText()`. This must operate on `WithParts[]` (not `ModelMessage[]`) because message IDs, part structure, and metadata fields like `archive`/`archivedBy` are lost during `toModelMessage()` conversion. This would allow the plugin to:
   - Filter out archived messages and inject summary placeholders
   - Skip `archivedBy` messages
   - Prefix message IDs when in compaction mode
   - Inject any additional context

2. **Session API in `ToolContext`** — Expose read/write access to session messages on the tool execution context. The SDK client only has read-only message endpoints (GET), so this is the *only* write path available to plugins. The `updateMessage` API must use a callback pattern `(draft) => void` that delegates to `Storage.update()` to preserve atomic write-lock semantics, with an identity-field guard that throws if `id`, `sessionID`, `role`, or `parentID` are modified (see proposal for implementation). The compact tool needs to:
   - List all messages in a session
   - Read message content by ID (via `message(id)` to avoid full-list scans)
   - Atomically write `archive`/`archivedBy` metadata to messages
   - Create new message parts (via `addPart()` — available during tool execution)

3. **LLM access for summarization** — **Resolved via `ToolContext.session.languageModel` (part of change #2).** The Session API exposes the session's pre-configured `LanguageModel` instance, giving the plugin access to the same model object that OpenCode's own `SessionCompaction.process()` uses (`compaction.ts:242-316`). The plugin imports the Vercel AI SDK (`"ai"` package) and calls `generateText()` directly:

   ```typescript
   import { generateText } from "ai"

   // Inside tool execute():
   const { text } = await generateText({
     model: ctx.session.languageModel,
     system: compactionSystemPrompt,
     messages: messagesToSummarize,
   })
   ```

   This is fully side-effect-free — no session messages, no `loop()`, no events, no recursive compaction. The `LanguageModel` comes from `Provider.getModel()` with all provider configuration already applied: custom base URLs, auth tokens from `auth.json`, provider-specific headers, AWS credential chains, plugin auth loader output, etc. The plugin doesn't need to reconstruct any of this.

   **Why not `client.session.prompt()`?** That path always persists a user message (`prompt.ts:202`) and runs the full `loop()` including overflow compaction (`prompt.ts:555-570`) and tool resolution (`prompt.ts:613`).

   **Why not a new `infer()` primitive?** Not needed — exposing the `LanguageModel` lets the plugin call the AI SDK directly, which is more flexible and adds no new API surface beyond what change #2 already provides.

### Not Needed (Previously Considered)

4. **`session.afterTurn` / `session.turn.after`** — Dropped. The existing `event` hook receives `message.updated` events which include the full assistant message with tokens, cost, and model info. A plugin can filter for completed assistant messages to get the same data.

5. **`session.overflow` / compaction override** — Not needed. If a plugin prunes context via `chat.context`, the API reports lower token usage, and the built-in `isOverflow()` check won't trigger. Built-in compaction acts as a safety net for cases where plugin pruning is insufficient.

### Nice-to-Have

6. **TUI tool renderer registration** — A way for plugins to register custom renderers for their tool results.

7. **Share/export filter** — A hook to filter message parts from enterprise sync.

---

## Feasibility Matrix

| Component | Plugin Today | With Proposed Changes | Notes |
|-----------|:---:|:---:|---|
| Compact tool (LLM interface) | Partial | Yes | `tool` hook (existing) + `session` API (new) + `session.languageModel` for summarization |
| Retrieve tool (LLM interface) | Partial | Yes | `tool` hook (existing) + `session` API (new) |
| Archive rendering in context | No | Yes | `chat.context` hook on `WithParts[]` (new) |
| Message ID visibility toggle | No | Yes | Plugin-internal state + `chat.context` |
| Context gauge (compaction trigger) | No | Yes | `event` hook for token data + `chat.context` to inject gauge text into conversation |
| Two-phase prepare/execute | No | Yes | Plugin-internal state + `chat.context` |
| Summarization LLM call | No | Yes | `session.languageModel` + AI SDK `generateText()` — fully side-effect-free, inherits all provider config |
| Overflow detection | No | Yes | Built-in compaction acts as safety net; no override needed |
| TUI rendering | No | Partial | Nice-to-have — tool results render as text |
| Auto-compaction modes | No | Yes | Plugin-internal state + `chat.context` + `session` API |
| Message metadata (archive fields) | No | Yes | Atomic `updateMessage(id, fn)` can set arbitrary fields |
| Share filtering | No | No | Low priority — avoid adding sensitive parts |

---

## Recommended Path Forward

### Option A: Propose Two Plugin Surface Changes to OpenCode (Recommended)

The **cleanest long-term approach** is to propose 2 targeted changes to the OpenCode project (see `docs/proposal-plugin-hooks.md` for the full proposal):

1. **`chat.context` hook** — Transform the `WithParts[]` message array *before* `toModelMessage()` conversion and `streamText()`. This hook fires early enough that plugins have access to message IDs, part structure, and metadata — the same data structures OpenCode's own compaction uses. This is generally useful beyond Context Bonsai and would benefit the entire plugin ecosystem (RAG, redaction, prompt caching, etc.).

2. **Session API in `ToolContext`** — Expose `messages()`, `message(id)`, `updateMessage(id, fn)`, `addPart()`, and `languageModel` on the tool execution context. This is a **hard requirement** because the SDK client only has read-only message endpoints and no access to the configured `LanguageModel`. The `updateMessage` API uses a callback pattern `(draft) => void` that delegates to `Storage.update()`, preserving atomic write-lock semantics, with an identity-field guard (see proposal). `message(id)` avoids full-list scans during archive-by-ID operations. `addPart()` enables part creation during tool execution (does **not** solve event-time writes). `languageModel` exposes the pre-configured `LanguageModel` instance from `Provider.getModel()`, giving plugins side-effect-free LLM access with all provider configuration (base URLs, auth, headers, middleware) already applied.

A previously considered `session.turn.after` hook was dropped — the existing `event` hook already receives `message.updated` events with full token/cost data. An overflow/compaction override hook is also unnecessary — effective `chat.context` pruning keeps token counts below thresholds, and built-in compaction serves as a safety net.

With these two changes (~90 lines, 3 files), Context Bonsai can be a fully self-contained plugin. Both changes are architecturally reasonable, additive, and follow existing hook conventions.

**Risk:** The OpenCode team may not want to stabilize these APIs, since the plugin system is relatively new.

### Option B: Minimal Core Changes + Plugin

A hybrid approach:

- **In OpenCode core:** Add the `archive`/`archivedBy` message schema fields and the rendering logic in `toModelMessage()`. This is a small, general-purpose change (~100 lines) that could be framed as "message archival support."
- **As a plugin:** The compact/retrieve tools, context gauge, summarization, mode state, and decision logic.
- **Challenge:** The plugin still needs Storage API access and LLM call capability.

### Option C: Fork-Only (Current Approach)

Continue maintaining Context Bonsai as a fork. The feature is deeply integrated and works well as a cohesive unit within OpenCode. The downside is keeping up with upstream changes.

---

## Conclusion

Context Bonsai's value comes primarily from **modifying how the conversation is constructed before being sent to the LLM** — and this is exactly what the plugin system doesn't support today. The tools (compact/retrieve) are the user-facing surface, but the machinery behind them requires access to the message pipeline and storage layer.

The most pragmatic path is **Option A**: propose a `chat.context` hook (on `WithParts[]`, before model conversion) and a Session API in `ToolContext` (with atomic `Storage.update`-backed writes). These are two general-purpose improvements (~90 lines, 3 files) that would benefit any plugin doing context manipulation, prompt injection, or message filtering.

Summarization is handled by the `languageModel` field on the Session API. The plugin calls `generateText({ model: ctx.session.languageModel, ... })` with the pre-configured `LanguageModel` instance, which includes all provider configuration (custom base URLs, auth tokens, headers, middleware). This is the same model object that OpenCode's own `SessionCompaction.process()` uses. No session messages are created, no `loop()` runs, no events are emitted.

See `docs/proposal-plugin-hooks.md` for the detailed proposal.
