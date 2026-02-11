# Proposal: Minimum Plugin Surface Area Changes for Context Management

## Motivation

OpenCode's plugin system is capable and well-designed, but it has a blind spot: **plugins cannot influence what the LLM sees**. They can add tools, modify parameters, and react to events — but they cannot transform the conversation context itself. This makes an entire category of plugins impossible: context compression, message summarization, RAG injection, prompt caching strategies, conversation branching, and more.

This proposal adds **two narrowly-scoped changes** that close this gap. Each is broadly useful and follows the existing hook conventions exactly.

---

## Proposed Changes

### 1. `chat.context` Hook — Transform Messages Before LLM Submission

**What it does:** Lets plugins transform the `WithParts[]` message array *before* OpenCode converts it to model format and passes it to `streamText()`.

**Why `WithParts[]` and not `ModelMessage[]`:** Operating on the internal `WithParts` representation gives plugins access to:
- **Message IDs** — needed to correlate with storage operations (e.g., marking messages as archived)
- **Part-level structure** — individual tool calls, reasoning blocks, and text segments, not flattened `content` arrays
- **Message metadata** — `archive`, `archivedBy`, `tokens`, `cost`, and other fields that are lost after `toModelMessage()` conversion

If the hook fired after `toModelMessage()`, plugins would have to reverse-engineer which `ModelMessage` entries correspond to which stored messages. This is fragile and lossy — message IDs don't survive the conversion. By hooking in *before* conversion, plugins operate on the same data structures that OpenCode's own compaction system uses.

**Why it's general-purpose:**
- RAG plugins can inject retrieved documents as additional messages
- Context compression plugins can filter, summarize, or replace old turns
- Audit plugins can redact sensitive content before it reaches the LLM
- Prompt engineering plugins can rewrite or annotate messages
- Caching plugins can restructure messages for optimal cache hit rates

**Hook signature** (follows existing `(input, output) => Promise<void>` pattern):

```typescript
// In packages/plugin/src/index.ts, add to Hooks interface:

/**
 * Transform the messages array before it is sent to the LLM.
 * Called after messages are loaded from storage but before toModelMessage()
 * conversion and streamText(). Plugins can filter, reorder, inject, or
 * replace messages. The system prompt array is also provided for modification.
 */
"chat.context"?: (
  input: {
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
  },
  output: {
    system: string[]
    messages: Array<{
      info: MessageInfo
      parts: Part[]
    }>
  },
) => Promise<void>
```

**Insertion point** — `packages/opencode/src/session/prompt.ts`, *before* the existing error-filter + `toModelMessage()` call at lines 705-728. Currently:

```typescript
// BEFORE (current code, inside streamText call)
messages: [
  ...system.map(
    (x): ModelMessage => ({
      role: "system",
      content: x,
    }),
  ),
  ...MessageV2.toModelMessage(
    msgs.filter((m) => {
      if (m.info.role !== "assistant" || m.info.error === undefined) {
        return true
      }
      if (
        MessageV2.AbortedError.isInstance(m.info.error) &&
        m.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
      ) {
        return true
      }
      return false
    }),
    { compactionModeEnabled: CompactionModeState.get(sessionID) },
  ),
],
```

Would become:

```typescript
// AFTER (proposed change)
// Let plugins transform messages before model conversion
const context = await Plugin.trigger(
  "chat.context",
  {
    sessionID,
    agent: lastUser.agent,
    model: { providerID: model.providerID, modelID: model.modelID },
  },
  {
    system,
    messages: msgs,
  },
)

// Then in streamText(), convert the (possibly transformed) messages:
messages: [
  ...context.system.map(
    (x): ModelMessage => ({
      role: "system",
      content: x,
    }),
  ),
  ...MessageV2.toModelMessage(
    context.messages.filter((m) => {
      if (m.info.role !== "assistant" || m.info.error === undefined) {
        return true
      }
      if (
        MessageV2.AbortedError.isInstance(m.info.error) &&
        m.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
      ) {
        return true
      }
      return false
    }),
    { compactionModeEnabled: CompactionModeState.get(sessionID) },
  ),
],
```

**Diff size:** ~20 lines changed in `prompt.ts`, ~15 lines added to `packages/plugin/src/index.ts`.

**Risk:** Low. The hook follows the same `Plugin.trigger()` pattern as `chat.params`. If no plugins use it, behavior is identical — the output object passes through untouched. Plugins that do use it are explicitly opting in to context manipulation, which is no more dangerous than the existing `chat.params` hook that can already set temperature to 2.0.

**Note on `toModelMessage()` and built-in compaction:** The existing error filter and `toModelMessage()` conversion (including `CompactionModeState` handling) remain in place *after* the hook. This means OpenCode's own rendering logic (archive placeholders, message ID prefixing, etc.) still applies to whatever the plugin returns. The plugin operates on the structural level (which messages to include); OpenCode handles the format conversion. If Context Bonsai prunes context effectively via this hook, the token counts reported by the API will stay within limits, and the built-in overflow compaction at `prompt.ts:555-570` won't trigger — it acts as a safety net, not a conflict.

---

### 2. Expose Session API in `ToolContext` — Let Plugin Tools Read/Write Messages

**What it does:** Adds a `session` object to the `ToolContext` that plugin-defined tools receive, giving them read/write access to session messages and parts.

**Why this is a hard requirement, not a convenience:** The SDK client (`PluginInput.client`) only exposes read-only endpoints for messages — `GET /session/{id}/messages` and `GET /session/{id}/message/{messageID}`. There are no PATCH/PUT/POST endpoints for updating message metadata. A plugin tool that needs to write to messages (e.g., marking them as archived) has no path to do so today. The `ToolContext.session` API is the *only* write path available to plugins.

**Why it's general-purpose:**
- Any tool that needs to reference prior conversation (search tools, citation tools)
- Tools that annotate messages with metadata
- Tools that create synthetic message parts (summaries, bookmarks)
- Tools that need to fork or branch conversations
- Debugging tools that inspect conversation state

**API surface** (minimal — just what's needed, nothing more):

```typescript
// In packages/plugin/src/tool.ts, update ToolContext:

export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  metadata(input: { title?: string; metadata?: any }): void

  // NEW: Session operations
  session: {
    /** List all messages in this session (ordered) */
    messages(): Promise<Array<{
      info: MessageInfo
      parts: Part[]
    }>>

    /** Get a single message by ID */
    message(id: string): Promise<{
      info: MessageInfo
      parts: Part[]
    } | undefined>

    /**
     * Atomically update a message.
     *
     * The callback receives a mutable draft of the message info.
     * Modifications are applied under a write lock (via Storage.update),
     * preventing read-then-write races between concurrent operations.
     *
     * This matches the pattern used throughout OpenCode's codebase
     * (Session.update, Storage.update, compact tool's archive logic).
     */
    updateMessage(id: string, fn: (draft: MessageInfo) => void): Promise<void>

    /** Add a part to a message */
    addPart(part: {
      messageID: string
      type: string
      [key: string]: unknown
    }): Promise<void>
  }
}
```

**Implementation** — `packages/opencode/src/session/prompt.ts`, in the `resolveTools()` function where tool execution context is built (around line 852). The `session` object delegates to existing internal functions:

```typescript
// In the tool execute wrapper, add to the context:
const result = await item.execute(args, {
  sessionID: input.sessionID,
  abort: options.abortSignal!,
  messageID: input.processor.message.id,
  callID: options.toolCallId,
  extra: input.model,
  agent: input.agent.name,
  metadata: async (val) => { ... },

  // NEW: Session API
  session: {
    async messages() {
      const msgs = []
      for await (const msg of MessageV2.stream(input.sessionID)) {
        msgs.push({ info: msg.info, parts: msg.parts })
      }
      return msgs
    },
    async message(id: string) {
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (msg.info.id === id) return { info: msg.info, parts: msg.parts }
      }
      return undefined
    },
    async updateMessage(id: string, fn: (draft: MessageInfo) => void) {
      // Delegates to Storage.update which acquires Lock.write(),
      // reads current state, applies the mutation, and writes atomically.
      await Storage.update(
        ["message", input.sessionID, id],
        fn,
      )
    },
    async addPart(part) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: input.sessionID,
        ...part,
      } as any)
    },
  },
})
```

**Why `(draft) => void` instead of `Record<string, unknown>`:** OpenCode's storage layer provides atomic updates via `Storage.update()`, which acquires a write lock, reads the current file, applies a mutation callback to the in-memory object, and writes it back atomically. A merge-based API (`updateMessage(id, { archive: ... })`) would require a read-then-write sequence outside the lock — a classic race condition. The callback pattern preserves the atomicity guarantees that OpenCode's own compaction code relies on (`compact.ts:649`, `compact.ts:684`).

**Diff size:** ~40 lines in `prompt.ts` (tool context construction), ~15 lines in type definitions.

**Risk:** Medium. Write access to messages is powerful. However:
- Tools already have `$` (shell access), which is far more dangerous
- This is the only write path available — the SDK client has no message write endpoints
- The `permission.ask` hook already exists for plugins that want to gate dangerous operations

---

## What These Two Changes Enable Together

With only these changes, a plugin can implement:

| Capability | Which Hook(s) |
|------------|---------------|
| Custom context compression/summarization | `tool` + `session` API + `chat.context` |
| RAG / document injection | `tool` + `chat.context` |
| Context window monitoring | `event` (existing — `message.updated` events include tokens) |
| Cost budget enforcement | `event` (existing) + `tool` |
| Message annotation/bookmarking | `tool` + `session` API |
| Conversation search | `tool` + `session` API |
| Prompt caching optimization | `chat.context` |
| Content redaction | `chat.context` |
| Token analytics | `event` (existing — assistant messages include token/cost data) |

For Context Bonsai specifically:
- **compact tool** → `tool` hook (existing) + `session` API (new) for reading messages and writing archive metadata
- **retrieve tool** → `tool` hook (existing) + `session` API (new) for reading archived content
- **archive rendering** → `chat.context` hook (new) to filter archived messages and inject summary placeholders
- **context gauge** → `event` hook (existing) to observe token usage after each turn
- **compaction mode** → plugin-internal state + `chat.context` to prefix message IDs when active

---

## What Is NOT Proposed (and Why)

| Omitted | Reason |
|---------|--------|
| `session.turn.after` hook | Redundant. The existing `event` hook receives `message.updated` events which include the full assistant message with tokens, cost, and model info. A plugin can filter for completed assistant messages to get the same data. Adding a typed convenience hook doesn't justify the API surface. |
| Overflow/compaction override hook | Not needed. If a plugin prunes context via `chat.context`, the model sees fewer tokens, the API reports lower usage, and `isOverflow()` won't trigger on the next turn. Built-in compaction acts as a safety net for cases where plugin pruning is insufficient — this is desirable, not a conflict. |
| Message schema changes (new fields on `MessageV2.Info`) | Not needed. The `updateMessage()` callback receives a mutable draft — plugins can set arbitrary fields. The `chat.context` hook can read those fields when deciding how to render messages. No schema changes required. |
| TUI tool renderer registration | Nice-to-have, not blocking. Tool results already render as text. Custom renderers are a cosmetic improvement that can come later. |
| Share/export filtering hook | Very niche. Can be handled by not adding sensitive parts in the first place. |
| System prompt modification hook | Already possible via `AGENTS.md` / `config.instructions`. The `chat.context` hook also provides the `system` array for programmatic modification. |
| Secondary LLM call API | Plugins already have the SDK `client` which can call `session.prompt()`. For direct `streamText()` access, that's a larger API surface discussion. The SDK client is sufficient for summarization use cases. |

---

## Implementation Effort

| Change | Files Modified | Lines Changed (est.) | Complexity |
|--------|---------------|---------------------|------------|
| `chat.context` hook | `prompt.ts`, `plugin/src/index.ts` | ~35 | Low — follows `chat.params` pattern exactly |
| Session API in ToolContext | `prompt.ts`, `plugin/src/tool.ts` | ~55 | Medium — delegates to existing `Storage.update` / `Session` functions |
| **Total** | **3 files** | **~90 lines** | **Low-Medium** |

All changes are additive. No existing behavior changes. No breaking changes to the plugin API. No new dependencies.

---

## Summary

Two changes, ~90 lines of code, zero breaking changes. In exchange, OpenCode's plugin system gains the ability to influence what the LLM actually sees — unlocking context management, RAG, compression, and analytics plugins that are currently impossible.

| Change | One-Liner | Pattern |
|--------|-----------|---------|
| `chat.context` | Transform `WithParts[]` messages before model conversion | Same as `chat.params` |
| Session API in `ToolContext` | Let tools atomically read/write session messages | Delegates to `Storage.update` |
