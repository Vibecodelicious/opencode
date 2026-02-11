# Context Bonsai: Plugin Feasibility Analysis

## Executive Summary

**Can Context Bonsai be rewritten as a plugin? Yes — with two targeted changes to OpenCode's plugin surface area.**

A plugin can provide the compact and retrieve **tools** (the LLM-facing interface), but the core value of the feature depends on modifying how OpenCode **constructs the conversation before sending it to the LLM** — and the plugin system has no hook for that today. Two proposed changes (`chat.context` hook + Session API in `ToolContext`) close this gap entirely. Secondary LLM calls for summarization are already supported via the SDK client's `session.prompt()` and `session.summarize()` endpoints — this has been validated against the codebase. See `docs/proposal-plugin-hooks.md` for the full proposal.

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

### 1. Compact & Retrieve Tools — PARTIALLY FEASIBLE

**What works:** A plugin can register `compact` and `retrieve` tools via the `tool` hook. The LLM would see them in the tool list and could call them.

**What doesn't work:**
- **No access to message storage.** The compact tool needs to read all session messages, iterate over them by ID, and write `archive`/`archivedBy` metadata to specific messages. The plugin `ToolContext` only provides `sessionID`, `messageID`, `agent`, and `abort` — no Storage or Session API.
- **No access to the LLM for summarization.** The compact tool makes a separate `streamText()` call to generate summaries, routed through `SessionProcessor` (for OAuth credentials). Plugins receive an SDK `client`, but it's unclear whether it supports raw `streamText` calls with custom system prompts and full conversation context.
- **No way to trigger two-phase flow.** The prepare phase sets `CompactionModeState`, which is an in-memory singleton Map that `toModelMessage()` reads to decide whether to prefix message IDs. A plugin can't set this state or influence `toModelMessage` behavior.

### 2. Message Archival Rendering — NOT FEASIBLE

This is the **core architectural gap**. When OpenCode builds the conversation to send to the LLM, it calls `MessageV2.toModelMessage()` which:

1. Checks each message for `archive` metadata → renders a `[SMART_ARCHIVED]` placeholder instead
2. Checks each message for `archivedBy` → skips it entirely
3. Optionally prefixes all content with `[msg_xxx]` when compaction mode is enabled

**There is no plugin hook that intercepts or modifies the messages array between `toModelMessage()` and `streamText()`.** The conversation construction happens at `prompt.ts:705-727`:

```typescript
messages: [
  ...system.map(...),
  ...MessageV2.toModelMessage(
    msgs.filter(...),
    { compactionModeEnabled: CompactionModeState.get(sessionID) },
  ),
],
```

This is hardcoded — no hook, no middleware, no extension point. Even `chat.params` only modifies temperature/topP/options, not the messages array.

### 3. Context Gauge Injection — NOT FEASIBLE

The context gauge is injected as a `ContextGaugePart` on assistant messages after each LLM response (`prompt.ts:762-767`). This requires:

- Access to the assistant message being built
- Token usage data from the LLM response
- Model context limit information
- Ability to persist a new part via `Session.updatePart()`

None of these are available to plugins. The `tool.execute.after` hook fires per-tool, not per-turn. The `event` hook receives events but can't modify state. The `chat.message` hook only fires for **user** messages, not assistant messages.

### 4. Compaction Mode State — NOT FEASIBLE

The two-phase prepare/execute flow relies on `CompactionModeState`, an in-memory Map that toggles message ID visibility. This state is read by `toModelMessage()` during conversation construction. A plugin has no way to:

- Set this state
- Read this state
- Influence how `toModelMessage()` renders messages

### 5. Message Schema Extensions — NOT FEASIBLE

The `archive` and `archivedBy` fields are added to the `MessageV2.Info` Zod schema. A plugin can't extend Zod schemas on core types. Even if a plugin stored metadata externally, `toModelMessage()` wouldn't know to check for it.

### 6. Overflow Detection & Auto-Compaction — NOT FEASIBLE

`SessionCompaction.isOverflow()` and `SessionCompaction.process()` are called from the main session loop. There's no hook for "context is about to overflow" or "session needs compaction."

### 7. TUI Rendering — NOT FEASIBLE

The TUI tool renderers for compact/retrieve results are in the React-based Ink UI. There's no plugin hook for adding TUI components. Without these, the compact/retrieve tool results would render as raw text rather than formatted displays.

### 8. Enterprise Share Filtering — NOT FEASIBLE

The `share-next.ts` change filters `ContextGaugePart` from enterprise sync. No plugin hook exists for share/export filtering.

---

## What Would Be Needed to Make It Fully Plugin-Compatible

To move Context Bonsai entirely to a plugin, OpenCode would need two changes (see `docs/proposal-plugin-hooks.md` for the full proposal):

### Critical (Feature Won't Work Without These)

1. **`chat.context` hook** — A hook that lets a plugin transform the `WithParts[]` message array **after** retrieval from storage but **before** `toModelMessage()` conversion and `streamText()`. This must operate on `WithParts[]` (not `ModelMessage[]`) because message IDs, part structure, and metadata fields like `archive`/`archivedBy` are lost during `toModelMessage()` conversion. This would allow the plugin to:
   - Filter out archived messages and inject summary placeholders
   - Skip `archivedBy` messages
   - Prefix message IDs when in compaction mode
   - Inject any additional context

2. **Session API in `ToolContext`** — Expose read/write access to session messages on the tool execution context. The SDK client only has read-only message endpoints (GET), so this is the *only* write path available to plugins. The `updateMessage` API must use a callback pattern `(draft) => void` that delegates to `Storage.update()` to preserve atomic write-lock semantics. The compact tool needs to:
   - List all messages in a session
   - Read message content by ID
   - Atomically write `archive`/`archivedBy` metadata to messages
   - Create new message parts

3. **LLM access for summarization** — **Validated.** The SDK `client` exposes `session.prompt()` (POST `/session/{id}/message`) which accepts `system?: string` as a full system prompt override — it *replaces* the agent prompt (`prompt.ts:800`), not appends to it. There is also a dedicated `session.summarize()` (POST `/session/{id}/summarize`) endpoint. Neither route has auth middleware restrictions. The compact tool's existing `generateSummaries()` function (`compact.ts:364-524`) demonstrates secondary LLM calls via `SessionProcessor` + `streamText()`, confirming the pattern works with OAuth credential routing.

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
| Compact tool (LLM interface) | Partial | Yes | `tool` hook (existing) + `session` API (new) |
| Retrieve tool (LLM interface) | Partial | Yes | `tool` hook (existing) + `session` API (new) |
| Archive rendering in context | No | Yes | `chat.context` hook on `WithParts[]` (new) |
| Message ID visibility toggle | No | Yes | Plugin-internal state + `chat.context` |
| Context gauge display | No | Yes | `event` hook (existing) + `tool` to surface it |
| Two-phase prepare/execute | No | Yes | Plugin-internal state + `chat.context` |
| Summarization LLM call | No | Yes | SDK `client.session.prompt({ system })` — validated, replaces agent prompt |
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

2. **Session API in `ToolContext`** — Expose `messages()`, `message(id)`, `updateMessage(id, fn)`, and `addPart()` on the tool execution context. This is a **hard requirement** because the SDK client only has read-only message endpoints — there is no write path for plugins today. The `updateMessage` API uses a callback pattern `(draft) => void` that delegates to `Storage.update()`, preserving the atomic write-lock semantics used throughout OpenCode's codebase.

A previously considered `session.turn.after` hook was dropped from the proposal — the existing `event` hook already receives `message.updated` events with full token/cost data, making a dedicated post-turn hook redundant.

Similarly, an overflow/compaction override hook is not needed. If a plugin prunes context effectively via `chat.context`, the API reports lower token usage, and `isOverflow()` won't trigger on the next turn. Built-in compaction serves as a safety net, not a conflict.

With these two changes (~90 lines, 3 files), Context Bonsai could be a fully self-contained plugin. Both changes are architecturally reasonable, additive, and follow existing hook conventions.

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

The most pragmatic path is **Option A**: propose a `chat.context` hook (on `WithParts[]`, before model conversion) and a Session API in `ToolContext` (with atomic `Storage.update`-backed writes). These are two general-purpose improvements (~90 lines, 3 files) that would benefit any plugin wanting to do context manipulation, prompt injection, or message filtering. With those changes in place, Context Bonsai could be a clean, self-contained plugin with no core modifications.

See `docs/proposal-plugin-hooks.md` for the detailed proposal.
