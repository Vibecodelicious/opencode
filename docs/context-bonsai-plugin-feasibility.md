# Context Bonsai: Plugin Feasibility Analysis

## Executive Summary

**Can Context Bonsai be rewritten as a plugin? Yes — with two targeted changes to OpenCode's plugin surface area.**

Two proposed changes (`chat.context` hook + Session API in `ToolContext`) close the core gaps: context transformation and message read/write access. Summarization — which previously appeared to require a third change — is handled by the plugin making **direct AI SDK calls**. OpenCode plugins are full npm packages loaded via `BunProc.install()` and dynamic `import()` (`plugin/index.ts:14-52`). A plugin can declare `"ai"` and a provider SDK (e.g., `@ai-sdk/anthropic`) as dependencies, read API keys from `process.env`, and call `generateText()` / `streamText()` directly — completely bypassing `client.session.prompt()`. This gives the plugin the same side-effect-free summarization path that the core compact tool uses (`SessionProcessor` + `streamText()`), without requiring any new OpenCode primitives. The `ToolContext.extra` field provides `providerID` and `modelID` (`prompt.ts:857`) so the plugin knows which model the session is using. See `docs/proposal-plugin-hooks.md` for the full proposal.

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

### 1. Compact & Retrieve Tools — TODAY: Partial → WITH PROPOSAL: Yes (with caveats)

**What works today:** A plugin can register `compact` and `retrieve` tools via the `tool` hook. The LLM sees them and can call them.

**Gaps in today's plugin system:**
- **No access to message storage.** The compact tool needs to read all session messages, iterate over them by ID, and write `archive`/`archivedBy` metadata to specific messages. The plugin `ToolContext` only provides `sessionID`, `messageID`, `agent`, and `abort` — no Storage or Session API.
- **No obvious LLM call path.** The compact tool makes a secondary `streamText()` call to generate summaries, routed through `SessionProcessor` (creating a temporary `summary: true` assistant message). Plugins have no access to `SessionProcessor` — but they don't need it (see resolution below).
- **No way to trigger two-phase flow.** The prepare phase sets `CompactionModeState`, which is an in-memory singleton Map that `toModelMessage()` reads to decide whether to prefix message IDs. A plugin can't set this state or influence `toModelMessage` behavior.

**How the proposal resolves these:**
- **Storage gap** → Resolved by `ToolContext.session` API. `messages()`, `message(id)`, `updateMessage(id, fn)`, and `addPart()` give plugins full read/write access with atomic semantics.
- **LLM summarization** → Resolved via direct AI SDK calls. Plugins are npm packages — they can import `"ai"` and a provider SDK (e.g., `@ai-sdk/anthropic`) as dependencies and call `generateText()` / `streamText()` directly using API keys from `process.env`. The `ToolContext.extra` field provides `providerID` and `modelID` so the plugin knows which model the session is using. This completely bypasses `client.session.prompt()` and its side effects (persistent messages, `loop()` execution, event emission). The result is equivalent to the core compact tool's `SessionProcessor` + `streamText()` path — a side-effect-free inference call with no session mutation.
- **Two-phase flow** → Resolved by `chat.context` hook. The plugin maintains its own in-memory state and applies message ID prefixing in the hook callback, bypassing `CompactionModeState` entirely.

### 2. Message Archival Rendering — TODAY: Not feasible → WITH PROPOSAL: Yes

This is the **core architectural gap**. When OpenCode builds the conversation to send to the LLM, it calls `MessageV2.toModelMessage()` which:

1. Checks each message for `archive` metadata → renders a `[SMART_ARCHIVED]` placeholder instead
2. Checks each message for `archivedBy` → skips it entirely
3. Optionally prefixes all content with `[msg_xxx]` when compaction mode is enabled

**There is no plugin hook today** that intercepts or modifies the messages array before `streamText()`. The conversation construction at `prompt.ts:705-727` is hardcoded.

**How the proposal resolves this:** The `chat.context` hook fires *before* `toModelMessage()`, giving plugins the `WithParts[]` array. A plugin can filter out archived messages, inject summary placeholders, and apply message ID prefixing — all before OpenCode's own conversion runs.

### 3. Context Gauge — TODAY: Not feasible → WITH PROPOSAL: Partial

The context gauge is currently injected as a `ContextGaugePart` on assistant messages after each LLM response (`prompt.ts:762-767`). This requires access to the assistant message, token usage, and `Session.updatePart()`.

**How the proposal addresses this:** The existing `event` hook receives `message.updated` events which include token usage and cost data on completed assistant messages. A plugin can observe these events to track context utilization. However, injecting a visible gauge part onto the assistant message still requires the `ToolContext.session.addPart()` API — which is only available during tool execution, not during event handling. A plugin could surface gauge information via a dedicated tool instead.

### 4. Compaction Mode State — TODAY: Not feasible → WITH PROPOSAL: Yes

**How the proposal resolves this:** The plugin maintains its own in-memory state (no dependency on `CompactionModeState`). The `chat.context` hook gives the plugin full control over message content before `toModelMessage()`, so it can apply message ID prefixing directly.

### 5. Message Schema Extensions — TODAY: Not feasible → WITH PROPOSAL: Yes

**How the proposal resolves this:** The `updateMessage(id, fn)` callback receives a mutable draft of `MessageV2.Info`. Plugins can set arbitrary fields (e.g., `archive`, `archivedBy`) without Zod schema changes — `Storage.update` writes the raw object without re-validation. The `chat.context` hook can read these fields when deciding how to render messages.

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
   - Create new message parts (via `addPart()` — available during tool execution only, does **not** solve event-time writes like context gauge injection)

3. **LLM access for summarization** — **Resolved via direct AI SDK calls (no OpenCode changes needed).** OpenCode plugins are full npm packages installed via `BunProc.install()` and loaded via dynamic `import()` (`plugin/index.ts:14-52`). A plugin can declare the Vercel AI SDK (`"ai"`) and a provider SDK (e.g., `@ai-sdk/anthropic`) as dependencies and call `generateText()` / `streamText()` directly:

   ```typescript
   import { generateText } from "ai"
   import { createAnthropic } from "@ai-sdk/anthropic"

   // Inside tool execute():
   const provider = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
   const { text } = await generateText({
     model: provider(ctx.extra.modelID),
     system: compactionSystemPrompt,
     messages: messagesToSummarize,
   })
   ```

   This is fully side-effect-free — no session messages created, no `loop()` execution, no events emitted, no recursive compaction risk. The `ToolContext.extra` field provides `providerID` and `modelID` (`prompt.ts:857`) so the plugin can match the session's model. API keys come from `process.env`, the same source OpenCode itself uses.

   **Why not `client.session.prompt()`?** That path always persists a user message (`prompt.ts:202`) and runs the full `loop()` including overflow compaction (`prompt.ts:555-570`) and tool resolution (`prompt.ts:613`). Direct AI SDK calls avoid all of this.

   **Why not a new `infer()` primitive?** Not needed — the plugin already has everything it needs to make its own LLM calls. Adding an `infer()` API would be redundant with what any npm package can already do.

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
| Compact tool (LLM interface) | Partial | Yes | `tool` hook (existing) + `session` API (new) + direct AI SDK calls for summarization |
| Retrieve tool (LLM interface) | Partial | Yes | `tool` hook (existing) + `session` API (new) |
| Archive rendering in context | No | Yes | `chat.context` hook on `WithParts[]` (new) |
| Message ID visibility toggle | No | Yes | Plugin-internal state + `chat.context` |
| Context gauge display | No | Partial | `event` hook for tracking; no way to inject gauge part onto assistant messages outside tool execution |
| Two-phase prepare/execute | No | Yes | Plugin-internal state + `chat.context` |
| Summarization LLM call | No | Yes | Plugin imports AI SDK directly and calls `generateText()` / `streamText()` — fully side-effect-free, no session mutation |
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

2. **Session API in `ToolContext`** — Expose `messages()`, `message(id)`, `updateMessage(id, fn)`, and `addPart()` on the tool execution context. This is a **hard requirement** because the SDK client only has read-only message endpoints — there is no write path for plugins today. The `updateMessage` API uses a callback pattern `(draft) => void` that delegates to `Storage.update()`, preserving the atomic write-lock semantics used throughout OpenCode's codebase, with an identity-field guard that throws if `id`, `sessionID`, `role`, or `parentID` are modified (see proposal for implementation). `message(id)` is included to avoid full-list scans during archive-by-ID operations. `addPart()` enables part creation during tool execution but does **not** solve the gauge gap (event-time writes remain unavailable).

**Summarization requires no OpenCode changes.** Plugins are full npm packages — they can import the Vercel AI SDK and a provider SDK as dependencies and call `generateText()` / `streamText()` directly using API keys from `process.env`. The `ToolContext.extra` field provides `providerID` and `modelID`. This is fully side-effect-free: no session messages created, no `loop()` execution, no events emitted.

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

Summarization — which initially appeared to require a third OpenCode change — is handled entirely by the plugin itself. Since OpenCode plugins are full npm packages (`BunProc.install()` + dynamic `import()`), the plugin can import the Vercel AI SDK and call `generateText()` / `streamText()` directly with API keys from `process.env` and model info from `ToolContext.extra`. This gives the plugin the same side-effect-free inference path that the core compact tool uses, without any new OpenCode primitives. No session messages are created, no `loop()` runs, no events are emitted.

See `docs/proposal-plugin-hooks.md` for the detailed proposal.
