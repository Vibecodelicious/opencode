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
    model: Model  // Full Model type — includes limit.context for gauge computation
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
    model: model.info,  // Full ModelsDev.Model — includes limit.context, limit.output
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

**Note on `<system-reminder>` tags:** OpenCode already uses `<system-reminder>`-tagged synthetic text parts to inject system signals into the conversation. The `insertReminders()` function (`prompt.ts:1251-1277`) pushes these onto the last user message for plan mode and build-switch notifications. The system prompts for Claude, Qwen (fallback for all other models), and Polaris explicitly prime the model to attend to these tags. Plugins using `chat.context` should follow the same pattern when injecting signals the model needs to act on (e.g., context gauge checkpoints). The hook fires after `insertReminders()`, so plugin-injected parts appear alongside OpenCode's own reminders.

---

### 2. Expose Session API in `ToolContext` — Let Plugin Tools Read/Write Messages

**What it does:** Adds a `session` object to the `ToolContext` that plugin-defined tools receive, giving them read/write access to session messages and parts.

**Why this is a hard requirement, not a convenience:** The SDK client (`PluginInput.client`) only exposes read-only endpoints for messages — `GET /session/{id}/message` (list) and `GET /session/{id}/message/{messageID}` (single). There are no PATCH/PUT/POST endpoints for updating message metadata. A plugin tool that needs to write to messages (e.g., marking them as archived) has no path to do so today. The `ToolContext.session` API is the *only* write path available to plugins.

**Why it's general-purpose:**
- Any tool that needs to reference prior conversation (search tools, citation tools)
- Tools that annotate messages with metadata
- Tools that create synthetic message parts (summaries, bookmarks)
- Tools that need side-effect-free LLM calls (summarization, classification, extraction)
- Tools that need to fork or branch conversations
- Tools that request user confirmation before dangerous operations (via `askPermission`)
- Debugging tools that inspect conversation state

**API surface** (minimal — message R/W + LLM access):

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

    /**
     * The session's pre-configured LanguageModel instance.
     *
     * This is the same model object that OpenCode uses internally for
     * the session's LLM calls (via Provider.getModel()). All provider
     * configuration is already applied: custom base URLs, auth tokens,
     * headers, middleware, and plugin auth loader output.
     *
     * Use with the AI SDK for side-effect-free inference:
     *   const { text } = await generateText({
     *     model: ctx.session.languageModel,
     *     system: "...",
     *     messages: [...],
     *   })
     */
    languageModel: LanguageModel

    /**
     * Request user permission via the native TUI dialog.
     *
     * Wraps Permission.ask() with the current session/message context
     * pre-filled. If the user denies, throws Permission.RejectedError.
     * If a plugin's permission.ask hook overrides the decision to "allow",
     * returns immediately without showing the dialog.
     *
     * This is the same mechanism that core tools (write, edit, bash, compact)
     * use to request permission before dangerous operations.
     */
    askPermission(input: {
      type: string
      title: string
      metadata?: Record<string, any>
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
      // Atomic write: acquires Lock.write(), reads, mutates, writes back.
      const updated = await Storage.update<MessageV2.Info>(
        ["message", input.sessionID, id],
        fn,
      )
      // Publish event so TUI, event hooks, and share system see the change.
      // This mirrors Session.updateMessage (session/index.ts:344-349)
      // but with atomic read-modify-write instead of blind overwrite.
      Bus.publish(MessageV2.Event.Updated, { info: updated })
    },
    async addPart(part) {
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: input.sessionID,
        ...part,
      } as any)
    },
    // Pre-configured LanguageModel from Provider.getModel()
    // (resolved once at tool setup, reused across calls)
    languageModel: (await Provider.getModel(input.model.providerID, input.model.modelID)).language,

    // Permission dialog — wraps Permission.ask() with session context pre-filled
    async askPermission({ type, title, metadata = {} }) {
      await Permission.ask({
        type,
        title,
        sessionID: input.sessionID,
        messageID: input.processor.message.id,
        callID: options.toolCallId,
        metadata,
      })
    },
  },
})
```

**Why `(draft) => void` instead of `Record<string, unknown>`:** OpenCode's storage layer provides atomic updates via `Storage.update()`, which acquires a write lock, reads the current file, applies a mutation callback to the in-memory object, and writes it back atomically. A merge-based API (`updateMessage(id, { archive: ... })`) would require a read-then-write sequence outside the lock — a classic race condition. The callback pattern preserves the atomicity guarantees that OpenCode's own compaction code relies on (`compact.ts:649`, `compact.ts:684`).

**Diff size:** ~50 lines in `prompt.ts` (tool context construction + `askPermission` wrapper), ~20 lines in type definitions.

**Risk:** Medium. Write access to messages is powerful. However:
- Tools already have `$` (shell access), which is far more dangerous
- This is the only write path available — the SDK client has no message write endpoints
- The `permission.ask` hook already exists for plugins that want to gate dangerous operations
- The `askPermission()` method lets plugin tools request user confirmation through the same native TUI dialog that core tools use, ensuring consistent UX

---

### Session Write API: Stability Contract

The `ToolContext.session` API exposes raw mutation power over messages. For upstreamability, the contract must be explicit about what plugins can and cannot do, and what side effects they should expect.

**What `updateMessage` guarantees:**
- **Atomicity** — the callback runs inside `Storage.update()`, which acquires `Lock.write()` before reading current state. No concurrent writer can interleave.
- **Event publishing** — after the atomic write completes, `Bus.publish(MessageV2.Event.Updated, { info })` fires. This means the TUI, the `event` plugin hook, and the share/sync system all see the change. This mirrors `Session.updateMessage` (`session/index.ts:344-349`) but adds atomicity.
- **No validation** — the callback receives the raw `MessageV2.Info` draft. OpenCode does **not** validate the object after mutation. The entire storage layer is raw JSON — `Storage.read()` returns `Bun.file().json()` with a type assertion, and `Storage.update()` reads, mutates, and writes back without validation. Zod schemas exist for type generation but are never applied to the read or write path. This matches the existing compact tool's behavior (`compact.ts:649-684`), which sets arbitrary fields like `archive` and `archivedBy` via `Storage.update`.

**What plugins are allowed to mutate:**
- **Any field on `MessageV2.Info`** — including custom metadata fields. OpenCode's storage is JSON-file-based with no runtime validation. Custom fields survive the full read/write cycle by design. The compact tool relies on this today.
- The proposal does **not** constrain which fields plugins may set. This is intentional — the same "anything goes" model applies to the existing compact tool, and restricting it would require a field-level ACL that doesn't exist anywhere in the codebase.

**What plugins must NOT do:**
- **Delete or overwrite core identity fields** (`id`, `sessionID`, `role`, `parentID`) — doing so would corrupt the message graph.

**Recommended: identity-field guard.** The `updateMessage` implementation should snapshot `id`, `sessionID`, `role`, and `parentID` before invoking the callback, then assert they are unchanged after. This is a ~5-line guard that prevents the most dangerous class of mutation (message graph corruption) without requiring full schema validation:

```typescript
async updateMessage(id: string, fn: (draft: MessageInfo) => void) {
  await Storage.update<MessageV2.Info>(
    ["message", input.sessionID, id],
    (draft) => {
      const frozen = { id: draft.id, sessionID: draft.sessionID, role: draft.role, parentID: draft.parentID }
      fn(draft)
      if (draft.id !== frozen.id || draft.sessionID !== frozen.sessionID ||
          draft.role !== frozen.role || draft.parentID !== frozen.parentID) {
        throw new Error("updateMessage callback must not modify identity fields (id, sessionID, role, parentID)")
      }
    },
  )
  Bus.publish(MessageV2.Event.Updated, { info: updated })
}
```

This is strictly better than the current `Session.updateMessage` contract (which has no enforcement at all) and makes the API safer for arbitrary plugin authors without adding a field-level ACL.

**What `addPart` guarantees:**
- Delegates to `Session.updatePart()` (`session/index.ts:379-388`), which writes via `Storage.write` and publishes `MessageV2.Event.PartUpdated`. This is the same path used by the TUI and internal tools.
- Part types are not constrained — plugins can create custom part types. The TUI will render unrecognized types as text fallbacks.
- **Scope limitation:** `addPart()` is only available during tool execution (via `ToolContext`), not during event handling.

---

## What These Two Changes Enable Together

With only these changes, a plugin can implement:

| Capability | Which Hook(s) |
|------------|---------------|
| Custom context compression/summarization | `tool` + `session` API (`languageModel` + message R/W) + `chat.context` |
| RAG / document injection | `tool` + `chat.context` |
| Context window monitoring | `event` (existing — `message.updated` events include tokens) + `chat.context` (`model.limit.context` for percentage) |
| Cost budget enforcement | `event` (existing) + `tool` |
| Message annotation/bookmarking | `tool` + `session` API |
| Conversation search | `tool` + `session` API |
| Prompt caching optimization | `chat.context` |
| Content redaction | `chat.context` |
| Token analytics | `event` (existing — assistant messages include token/cost data) |

For Context Bonsai specifically:
- **compact tool** → `tool` hook (existing) + `session` API (new) for message R/W and `languageModel` for summarization
- **retrieve tool** → `tool` hook (existing) + `session` API (new) for reading archived content
- **archive rendering** → `chat.context` hook (new) to filter archived messages and inject summary placeholders
- **context gauge** → `event` hook (existing) for token data + `chat.context` hook (new) to inject `<system-reminder>`-tagged gauge text; `model.limit.context` (from `chat.context` input) for percentage computation
- **user control modes** → `askPermission()` on `session` API for "ask" mode (native TUI dialog); "notify"/"silent" modes are plugin-internal
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
| Side-effect-free LLM inference (`infer()`) | Not needed. The `ToolContext.session.languageModel` field exposes the pre-configured `LanguageModel` instance from `Provider.getModel()`. A plugin imports the AI SDK (`"ai"` package) and calls `generateText({ model: ctx.session.languageModel, ... })` directly — fully side-effect-free (no session messages, no `loop()`, no events). All provider configuration (base URLs, auth, headers, middleware) is already applied. This pattern is already used in production: `session/summary.ts:89-111` calls `generateText({ model: small.language, ... })` directly with the `LanguageModel` from `Provider.getModel()`. A separate `infer()` API would be redundant. |

---

## Implementation Effort

| Change | Files Modified | Lines Changed (est.) | Complexity |
|--------|---------------|---------------------|------------|
| `chat.context` hook | `prompt.ts`, `plugin/src/index.ts` | ~35 | Low — follows `chat.params` pattern exactly |
| Session API in ToolContext | `prompt.ts`, `plugin/src/tool.ts` | ~70 | Medium — delegates to existing `Storage.update` / `Session` / `Permission` functions |
| **Total** | **3 files** | **~105 lines** | **Low-Medium** |

All changes are additive. No existing behavior changes. No breaking changes to the plugin API. No new dependencies.

---

## Summary

Two changes, ~105 lines of code, zero breaking changes. In exchange, OpenCode's plugin system gains the ability to influence what the LLM actually sees and make side-effect-free LLM calls — unlocking context management, RAG, compression, summarization, and analytics plugins that are currently impossible.

| Change | One-Liner | Pattern |
|--------|-----------|---------|
| `chat.context` | Transform `WithParts[]` messages before model conversion | Same as `chat.params` |
| Session API in `ToolContext` | Let tools atomically read/write session messages | Delegates to `Storage.update` |
