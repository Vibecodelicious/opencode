# Proposal: Minimum Plugin Surface Area Changes for Context Management

## Motivation

OpenCode's plugin system is capable and well-designed, but it has a blind spot: **plugins cannot influence what the LLM sees**. They can add tools, modify parameters, and react to events — but they cannot transform the conversation context itself. This makes an entire category of plugins impossible: context compression, message summarization, RAG injection, prompt caching strategies, conversation branching, and more.

This proposal adds **three narrowly-scoped hooks** that close this gap. Each is broadly useful and follows the existing hook conventions exactly.

---

## Proposed Changes

### 1. `chat.context` Hook — Transform Messages Before LLM Submission

**What it does:** Lets plugins transform the `ModelMessage[]` array after OpenCode converts stored messages but before passing them to `streamText()`.

**Why it's general-purpose:**
- RAG plugins can inject retrieved documents as system/user messages
- Context compression plugins can summarize or truncate old turns
- Audit plugins can redact sensitive content before it reaches the LLM
- Prompt engineering plugins can rewrite or annotate messages
- Caching plugins can restructure messages for optimal cache hit rates

**Hook signature** (follows existing `(input, output) => Promise<void>` pattern):

```typescript
// In packages/plugin/src/index.ts, add to Hooks interface:

/**
 * Transform the messages array before it is sent to the LLM.
 * Called after messages are converted to model format but before streamText().
 * Plugins can filter, reorder, inject, or replace messages.
 */
"chat.context"?: (
  input: {
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
  },
  output: {
    system: string[]
    messages: ModelMessage[]
  },
) => Promise<void>
```

**Insertion point** — `packages/opencode/src/session/prompt.ts`, between message conversion and `streamText()`. Currently lines 705-728 are:

```typescript
// BEFORE (current code)
messages: [
  ...system.map(
    (x): ModelMessage => ({
      role: "system",
      content: x,
    }),
  ),
  ...MessageV2.toModelMessage(
    msgs.filter((m) => { ... }),
    { compactionModeEnabled: CompactionModeState.get(sessionID) },
  ),
],
```

Would become:

```typescript
// AFTER (proposed change)
// Build context, then let plugins transform it
const systemMessages = system
const modelMessages = MessageV2.toModelMessage(
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
)

const context = await Plugin.trigger(
  "chat.context",
  {
    sessionID,
    agent: lastUser.agent,
    model: { providerID: model.providerID, modelID: model.modelID },
  },
  {
    system: systemMessages,
    messages: modelMessages,
  },
)

// Then in streamText():
messages: [
  ...context.system.map(
    (x): ModelMessage => ({
      role: "system",
      content: x,
    }),
  ),
  ...context.messages,
],
```

**Diff size:** ~20 lines changed in `prompt.ts`, ~10 lines added to `packages/plugin/src/index.ts`.

**Risk:** Low. The hook follows the same `Plugin.trigger()` pattern as `chat.params`. If no plugins use it, behavior is identical — the output object passes through untouched. Plugins that do use it are explicitly opting in to context manipulation, which is no more dangerous than the existing `chat.params` hook that can already set temperature to 2.0.

---

### 2. `session.turn.after` Hook — Post-Turn Notification with Token Data

**What it does:** Fires after each assistant turn completes, providing the assistant message, token usage, and model info. Plugins can use this to make decisions, inject metadata, or trigger actions.

**Why it's general-purpose:**
- Cost tracking / budget enforcement plugins
- Token usage analytics and alerting
- Context window monitoring (percentage used)
- Automatic session management (fork when context is high)
- Post-turn logging or auditing

**Hook signature:**

```typescript
// In packages/plugin/src/index.ts, add to Hooks interface:

/**
 * Called after each assistant turn completes (after message is saved).
 * Provides token usage, model info, and the completed message.
 * This is a notification hook — modifications to output are not applied.
 */
"session.turn.after"?: (
  input: {
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
    message: {
      id: string
      parentID: string
      tokens: {
        input: number
        output: number
        reasoning: number
        cache: { read: number; write: number }
      }
      cost: number
      finish: string | undefined
    }
    contextLimit: number
  },
  output: {},
) => Promise<void>
```

**Insertion point** — `packages/opencode/src/session/prompt.ts`, after the context gauge injection at line 768, inside the `if (result === "continue")` block:

```typescript
// AFTER context gauge injection, add:
await Plugin.trigger(
  "session.turn.after",
  {
    sessionID,
    agent: lastUser.agent,
    model: { providerID: model.providerID, modelID: model.modelID },
    message: {
      id: processor.message.id,
      parentID: processor.message.parentID,
      tokens: processor.message.tokens,
      cost: processor.message.cost,
      finish: processor.message.finish,
    },
    contextLimit: model.info.limit.context,
  },
  {},
)
```

**Diff size:** ~20 lines in `prompt.ts`, ~20 lines in plugin types.

**Risk:** Very low. This is a read-only notification hook. The empty `output` object means plugins can't mutate anything — they can only observe. It follows the same pattern as the `event` hook but with structured, typed data rather than a generic event.

---

### 3. Expose Session API in `ToolContext` — Let Plugin Tools Read/Write Messages

**What it does:** Adds a `session` object to the `ToolContext` that plugin-defined tools receive, giving them read/write access to session messages and parts.

**Why it's general-purpose:**
- Any tool that needs to reference prior conversation (search tools, citation tools)
- Tools that annotate messages with metadata
- Tools that create synthetic message parts (summaries, bookmarks)
- Tools that need to fork or branch conversations
- Debugging tools that inspect conversation state

**API surface** (minimal — just what's needed, nothing more):

```typescript
// In packages/plugin/src/tool.ts or packages/opencode/src/tool/tool.ts:

export type Context<M extends Metadata = Metadata> = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  metadata(input: { title?: string; metadata?: M }): void

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

    /** Update message metadata (merge with existing) */
    updateMessage(id: string, update: Record<string, unknown>): Promise<void>

    /** Add a part to a message */
    addPart(part: {
      messageID: string
      type: string
      [key: string]: unknown
    }): Promise<void>
  }
}
```

**Implementation** — `packages/opencode/src/session/prompt.ts`, in the `resolveTools()` function where tool execution context is built (around line 852). The `session` object would delegate to existing `Session.messages()`, `Session.updateMessage()`, and `Session.updatePart()` functions that already exist:

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
      const msgs = []
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (msg.info.id === id) return { info: msg.info, parts: msg.parts }
      }
      return undefined
    },
    async updateMessage(id: string, update: Record<string, unknown>) {
      // Fetch, merge, save
      for await (const msg of MessageV2.stream(input.sessionID)) {
        if (msg.info.id === id) {
          await Session.updateMessage({ ...msg.info, ...update } as any)
          return
        }
      }
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

**Diff size:** ~40 lines in `prompt.ts` (tool context construction), ~15 lines in type definitions.

**Risk:** Medium. Write access to messages is powerful. However:
- Tools already have `$` (shell access), which is far more dangerous
- The SDK `client` already exposes session APIs over HTTP
- This just removes the indirection of tools calling back to their own HTTP server
- The `permission.ask` hook already exists for plugins that want to gate dangerous operations

**Alternative (lower risk):** Expose only read access initially. Tools could use the SDK `client` (already in `PluginInput`) for writes. But the SDK client goes through HTTP, which is awkward for a tool running in-process.

---

## What These Three Hooks Enable Together

With only these changes, a plugin can implement:

| Capability | Which Hook(s) |
|------------|---------------|
| Custom context compression/summarization | `tool` + `session` API + `chat.context` |
| RAG / document injection | `tool` + `chat.context` |
| Context window monitoring | `session.turn.after` |
| Cost budget enforcement | `session.turn.after` + `tool` |
| Message annotation/bookmarking | `tool` + `session` API |
| Conversation search | `tool` + `session` API |
| Prompt caching optimization | `chat.context` |
| Content redaction | `chat.context` |
| Token analytics | `session.turn.after` + `event` |

For Context Bonsai specifically:
- **compact tool** → `tool` hook (existing) + `session` API (new) for reading messages and writing archive metadata
- **retrieve tool** → `tool` hook (existing) + `session` API (new) for reading archived content
- **archive rendering** → `chat.context` hook (new) to replace archived messages with placeholders
- **context gauge** → `session.turn.after` hook (new) to monitor token usage, `tool` to surface it
- **compaction mode** → plugin-internal state + `chat.context` to prefix message IDs when active

---

## What Is NOT Proposed (and Why)

| Omitted | Reason |
|---------|--------|
| Message schema changes (new fields on `MessageV2.Info`) | Not needed. Plugins can use `updateMessage()` to store arbitrary metadata on messages via the existing schema's flexibility, or store state externally. The `chat.context` hook handles rendering. |
| TUI tool renderer registration | Nice-to-have, not blocking. Tool results already render as text. Custom renderers are a cosmetic improvement that can come later. |
| Share/export filtering hook | Very niche. Can be handled by not adding sensitive parts in the first place. |
| Overflow detection hook | The `session.turn.after` hook provides token data — plugins can compute overflow themselves. |
| System prompt modification hook | Already possible via `AGENTS.md` / `config.instructions`. The `chat.context` hook also provides the `system` array for programmatic modification. |
| Secondary LLM call API | Plugins already have the SDK `client` which can call `session.prompt()`. For direct `streamText()` access, that's a larger API surface discussion. The SDK client is sufficient for summarization use cases. |

---

## Implementation Effort

| Change | Files Modified | Lines Changed (est.) | Complexity |
|--------|---------------|---------------------|------------|
| `chat.context` hook | `prompt.ts`, `plugin/src/index.ts` | ~30 | Low — follows `chat.params` pattern exactly |
| `session.turn.after` hook | `prompt.ts`, `plugin/src/index.ts` | ~40 | Low — notification-only, no mutation |
| Session API in ToolContext | `prompt.ts`, `tool/tool.ts`, `plugin/src/tool.ts` | ~55 | Medium — delegates to existing `Session` functions |
| **Total** | **3-5 files** | **~125 lines** | **Low-Medium** |

All changes are additive. No existing behavior changes. No breaking changes to the plugin API. No new dependencies.

---

## Summary

Three hooks, ~125 lines of code, zero breaking changes. In exchange, OpenCode's plugin system gains the ability to influence what the LLM actually sees — unlocking context management, RAG, compression, and analytics plugins that are currently impossible.

| Hook | One-Liner | Pattern |
|------|-----------|---------|
| `chat.context` | Transform messages before LLM sees them | Same as `chat.params` |
| `session.turn.after` | Get notified with token data after each turn | Same as `event` but typed |
| Session API in `ToolContext` | Let tools read/write session messages | Delegates to existing `Session.*` |
