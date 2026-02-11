# Context Bonsai: Plugin Feasibility Analysis

## Executive Summary

**Can Context Bonsai be rewritten as a plugin? Partially, but not fully — and the gaps are significant.**

A plugin can provide the compact and retrieve **tools** (the LLM-facing interface), but the core value of the feature depends on modifying how OpenCode **constructs the conversation before sending it to the LLM** — and the plugin system has no hook for that. Approximately 40% of the feature could live in a plugin today; the remaining 60% requires either core changes to OpenCode or new plugin hooks that don't yet exist.

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

To move Context Bonsai entirely to a plugin, OpenCode would need these new plugin hooks:

### Critical (Feature Won't Work Without These)

1. **`chat.context` / `chat.messages`** — A hook that lets a plugin transform the messages array **after** retrieval from storage but **before** sending to the LLM. This is the single most important missing hook. It would allow the plugin to:
   - Replace archived messages with placeholders
   - Skip `archivedBy` messages
   - Prefix message IDs when in compaction mode
   - Inject context gauge text

2. **Session/Storage API access** — Either expose `Session` and `Storage` APIs in `PluginInput`, or provide a `session.messages` hook that gives read/write access to message metadata. The compact tool needs to:
   - List all messages in a session
   - Read message content by ID
   - Write `archive`/`archivedBy` metadata to messages
   - Create new message parts

3. **LLM access for summarization** — A way for a plugin tool to make a secondary LLM call with a custom system prompt and the current conversation context. The existing SDK `client` may partially support this, but it would need to handle OAuth credential routing.

### Important (Feature Degraded Without These)

4. **`session.afterTurn`** — A hook that fires after each assistant turn with access to the assistant message and token usage. This would enable context gauge injection.

5. **`session.overflow`** — A hook that fires when context overflow is detected, allowing the plugin to handle it instead of the default compaction behavior.

### Nice-to-Have

6. **TUI tool renderer registration** — A way for plugins to register custom renderers for their tool results.

7. **Share/export filter** — A hook to filter message parts from enterprise sync.

---

## Feasibility Matrix

| Component | Plugin Today | With New Hooks | Difficulty of New Hooks |
|-----------|:---:|:---:|---|
| Compact tool (LLM interface) | Partial | Yes | Medium — needs storage API |
| Retrieve tool (LLM interface) | Partial | Yes | Medium — needs storage API |
| Archive rendering in context | No | Yes | **High** — new `chat.context` hook |
| Message ID visibility toggle | No | Yes | **High** — tied to `chat.context` |
| Context gauge injection | No | Yes | Medium — new `session.afterTurn` hook |
| Two-phase prepare/execute | No | Yes | Medium — state + `chat.context` |
| Summarization LLM call | No | Yes | Medium — LLM API in plugin context |
| Overflow detection | No | Yes | Low — new event/hook |
| TUI rendering | No | Partial | Low — renderer registration |
| Auto-compaction modes | No | Yes | Medium — combined hooks |
| Message schema (archive fields) | No | Partial | Medium — metadata API |
| Share filtering | No | Yes | Low |

---

## Recommended Path Forward

### Option A: Propose New Plugin Hooks to OpenCode (Recommended)

The **cleanest long-term approach** is to propose 2-3 new hooks to the OpenCode project:

1. **`chat.context`** — Transform the messages array before LLM submission. This is generally useful beyond Context Bonsai and would benefit the entire plugin ecosystem.
2. **Storage/Session API in PluginInput** — Let plugins read/write message metadata. Guard with appropriate permissions.
3. **`session.afterTurn`** — Post-turn hook with token data.

With these three hooks, Context Bonsai could be a fully self-contained plugin. These hooks are architecturally reasonable and don't break OpenCode's design — they fill obvious gaps in the plugin surface area.

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

Context Bonsai's value comes primarily from **modifying how the conversation is constructed before being sent to the LLM** — and this is exactly what the plugin system doesn't support. The tools (compact/retrieve) are the user-facing surface, but the machinery behind them requires deep integration with the message pipeline, storage layer, and session processing loop.

The most pragmatic path is **Option A**: propose a `chat.context` hook and Storage API access to the OpenCode project. These are general-purpose improvements that would benefit any plugin wanting to do context manipulation, prompt injection, or message filtering. With those hooks in place, Context Bonsai could be a clean, self-contained plugin with no core modifications.
