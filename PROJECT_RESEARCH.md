# Context Bonsai Plugin — Upstream Code Research

All references are against the `dev` branch (upstream: `anomalyco/opencode`).
The local `dev` is synced with `upstream/dev`.

---

## 1. Plugin System

### Plugin Interface

**File**: `packages/plugin/src/index.ts` (upstream/dev)

Plugins are npm packages exporting `Plugin` functions. They receive a
`PluginInput` and return `Hooks`:

```typescript
export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}
export type Plugin = (input: PluginInput) => Promise<Hooks>
```

### Available Hooks (upstream/dev)

| Hook | Input | Output (mutable) | Where triggered |
|------|-------|-------------------|-----------------|
| `event` | `{ event: Event }` | — | Bus system |
| `config` | `Config` | — | Startup |
| `tool` | — | Tool map | Startup |
| `auth` | — | Auth methods | Auth flow |
| `chat.message` | `{ sessionID, agent?, model?, messageID?, variant? }` | `{ message, parts }` | `prompt.ts:1208` (after user message created) |
| `chat.params` | `{ sessionID, agent, model, provider, message }` | `{ temperature, topP, topK, options }` | `prompt.ts` (before streamText) |
| `chat.headers` | `{ sessionID, agent, model, provider, message }` | `{ headers }` | Before LLM call |
| `permission.ask` | `Permission` | `{ status }` | Permission check |
| `command.execute.before` | `{ command, sessionID, arguments }` | `{ parts }` | Before slash commands |
| `tool.execute.before` | `{ tool, sessionID, callID }` | `{ args }` | `prompt.ts:730` (before tool execute) |
| `tool.execute.after` | `{ tool, sessionID, callID }` | `{ title, output, metadata }` | `prompt.ts:742` (after tool execute) |
| `shell.env` | `{ cwd }` | `{ env }` | Shell commands |
| **`experimental.chat.messages.transform`** | `{}` | `{ messages: { info, parts }[] }` | **`prompt.ts:620`** (before toModelMessages) |
| **`experimental.chat.system.transform`** | `{ sessionID?, model }` | `{ system: string[] }` | Before LLM system prompt |
| `experimental.session.compacting` | `{ sessionID }` | `{ context, prompt? }` | Before compaction LLM call |
| `experimental.text.complete` | `{ sessionID, messageID, partID }` | `{ text }` | Text completion |

### Plugin ToolContext

**File**: `packages/plugin/src/tool.ts` (upstream/dev)

```typescript
export type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
}
```

**Note**: The upstream plugin `ToolContext` is richer than the fork's — it
already has `directory`, `worktree`, `metadata()`, and `ask()`. But it still
lacks session message read/write and languageModel access.

### Internal Tool.Context (not exposed to plugins)

**File**: `packages/opencode/src/tool/tool.ts` (upstream/dev)

The internal context that built-in tools receive has MORE than the plugin
`ToolContext`:

```typescript
export type Context = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: any }
  messages: MessageV2.WithParts[]      // <-- plugins don't get this
  metadata(input: { title?: string; metadata?: M }): void
  ask(input: ...): Promise<void>
}
```

Key gap: internal tools get `messages` (the full conversation), plugins don't.

---

## 2. Message Transform Hook (CRITICAL)

**File**: `packages/opencode/src/session/prompt.ts` (upstream/dev, line ~620)

```typescript
// Ephemerally wrap queued user messages with a reminder to stay on track
if (step > 1 && lastFinished) {
  for (const msg of sessionMessages) {
    if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
    for (const part of msg.parts) {
      if (part.type !== "text" || part.ignored || part.synthetic) continue
      if (!part.text.trim()) continue
      part.text = [
        "<system-reminder>",
        "The user sent the following message:",
        part.text,
        "",
        "Please address this message and continue with your tasks.",
        "</system-reminder>",
      ].join("\n")
    }
  }
}

await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
```

**What this means**: A plugin can modify `sessionMessages` (which is
`MessageV2.WithParts[]`) in-place before it's passed to `toModelMessages()`.
This is the hook needed for archived message rendering.

**Pipeline order**:
1. Messages loaded from storage via `MessageV2.filterCompacted()`
2. `insertReminders()` adds synthetic system-reminder parts (`prompt.ts:540`)
3. Messages cloned into `sessionMessages`
4. System-reminder wrapping for queued user messages (step > 1)
5. **`experimental.chat.messages.transform` fires** (line 620)
6. `MessageV2.toModelMessages(sessionMessages, model)` converts to LLM format (line 629)
7. `streamText()` called

**Gap**: The hook input is `{}` — no sessionID, model info, or context limit.
The plugin would need to track this data from other hooks (e.g., `event`,
`chat.params`, `config`).

---

## 3. Conversation Construction

### toModelMessages

**File**: `packages/opencode/src/session/message-v2.ts` (upstream/dev, line 445)

`toModelMessages(input: WithParts[], model: Provider.Model): ModelMessage[]`

This is the function that converts internal messages to LLM format. In upstream,
it does **NOT** handle `archive`/`archivedBy` fields — it has no awareness of
them. It handles:
- User text parts (filtered by `!part.ignored`)
- File attachments
- Compaction parts → `"What did we do so far?"`
- Subtask parts → `"The following tool was executed by the user"`
- Assistant text, reasoning, tool results
- Tool result media extraction for providers that don't support media in results
- Compacted tool outputs → `"[Old tool result content cleared]"`

**Key insight**: Since the `experimental.chat.messages.transform` hook fires
BEFORE `toModelMessages()`, the plugin can filter/modify the `WithParts[]`
array directly. It doesn't need `toModelMessages()` to understand archives —
the plugin handles that in the transform hook by replacing archived messages
with summary placeholder messages.

### Message Schema (upstream)

**File**: `packages/opencode/src/session/message-v2.ts` (upstream/dev)

The upstream `Base` message schema does NOT have `archive` or `archivedBy`:
```typescript
const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
})
```

The upstream Part union includes `CompactionPart` but NOT `ContextGaugePart`.

**Implication**: The plugin stores archive metadata in a `metadata` bag on the
message schema (see Section 9, Change 1). Adding `metadata:
z.record(z.unknown()).optional()` to `MessageV2.Base` gives plugins a blessed
extension point that survives Zod parsing and all existing code paths. Plugins
namespace by `ctx.pluginID` (e.g., `metadata[ctx.pluginID]`).

---

## 4. Storage Layer

**File**: `packages/opencode/src/storage/storage.ts` (upstream/dev)

```typescript
export async function read<T>(key: string[]) {
  using _ = await Lock.read(target)
  const result = await Bun.file(target).json()
  return result as T
}

export async function update<T>(key: string[], fn: (draft: T) => void) {
  using _ = await Lock.write(target)
  const content = await Bun.file(target).json()
  fn(content)
  await Bun.write(target, JSON.stringify(content, null, 2))
  return content as T
}

export async function write<T>(key: string[], content: T) {
  using _ = await Lock.write(target)
  await Bun.write(target, JSON.stringify(content, null, 2))
}
```

**Key insight**: `Storage.update()` is atomic (write-lock, read, mutate, write
back). `Storage.write()` is a blind overwrite with write-lock. The storage is
raw JSON — no runtime Zod validation on read or write. This means custom fields
(like `archive`/`archivedBy`) added by a plugin would survive the storage
round-trip, BUT `Session.updateMessage()` (see below) uses `Storage.write()`
(blind overwrite), which would clobber any fields not in the object being
written. `Storage.update()` (atomic read-modify-write) would preserve them.

### Session.updateMessage (upstream)

**File**: `packages/opencode/src/session/index.ts` (upstream/dev, line 378)

```typescript
export const updateMessage = fn(MessageV2.Info, async (msg) => {
  await Storage.write(["message", msg.sessionID, msg.id], msg)
  Bus.publish(MessageV2.Event.Updated, { info: msg })
  return msg
})
```

This uses `Storage.write()` — it completely overwrites the message.

**Resolution**: Adding `metadata: z.record(z.unknown()).optional()` to the
`MessageV2.Base` schema (see Section 9, Change 1) solves this structurally.
Since `metadata` is a known Zod field, it survives `Session.updateMessage()`'s
`fn()` wrapper which parses inputs through `MessageV2.Info.parse()`. Plugin
data stored in `msg.metadata[ctx.pluginID]` is preserved through all existing
code paths. The plugin uses `ctx.updateMessage()` (which delegates to
`Storage.update()` for atomic read-modify-write) to write metadata.

---

## 5. System Reminders

### Existing Pattern

**File**: `packages/opencode/src/session/prompt.ts` (upstream/dev, lines 600-615)

System reminders are injected as ephemeral `<system-reminder>` tag wrappers on
user message text parts. They are NOT persisted — only added at conversation
construction time.

```typescript
part.text = [
  "<system-reminder>",
  "The user sent the following message:",
  part.text,
  "",
  "Please address this message and continue with your tasks.",
  "</system-reminder>",
].join("\n")
```

### insertReminders

**File**: `packages/opencode/src/session/prompt.ts` (upstream/dev, line 1234)

`insertReminders()` adds synthetic text parts to the last user message for plan
mode notifications and build-switch reminders. These use `synthetic: true`:

```typescript
userMessage.parts.push({
  id: Identifier.ascending("part"),
  messageID: userMessage.info.id,
  sessionID: userMessage.info.sessionID,
  type: "text",
  text: PROMPT_PLAN,
  synthetic: true,
})
```

### Model Priming for system-reminder Tags

System prompts for Claude (`anthropic.txt`) and the fallback (`qwen.txt`) tell
the model to attend to `<system-reminder>` tags. Other providers (GPT, Gemini)
don't include this priming, but `insertReminders()` injects on all models
regardless — the inconsistency already exists upstream.

### Plugin Access to System Prompts

The `experimental.chat.system.transform` hook lets plugins modify the system
prompt array. Input includes `{ sessionID?, model }`, giving the plugin access
to model info for provider-specific behavior.

---

## 6. Token Tracking / Context Utilization

### Where Token Data Lives

**File**: `packages/opencode/src/session/index.ts` (upstream/dev, line 441+)

`Session.getUsage()` computes token counts from the LLM response metadata. Token
data is stored on assistant messages:

```typescript
// MessageV2.Assistant includes:
tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number, write: number }
}
```

### Overflow Detection

**File**: `packages/opencode/src/session/compaction.ts` (upstream/dev)

```typescript
export async function isOverflow(input: { tokens, model }) {
  const count = input.tokens.total ||
    input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  const reserved = config.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - ProviderTransform.maxOutputTokens(input.model)
  return count >= usable
}
```

### Context Limit

Model context limit is available via `model.limit.context` and
`model.limit.input` on the `Provider.Model` type.

### How a Plugin Gets Token Data

1. **`event` hook**: Subscribe to `message.updated` events — assistant messages
   include `tokens` with input/output/reasoning/cache counts.
2. **`chat.params` hook**: Receives `model: Model` which includes `limit.context`.
3. **`experimental.chat.system.transform`**: Receives `{ model: Model }`.
4. **`experimental.chat.messages.transform`**: Receives `{}` — NO model info.

**Gap**: The message transform hook (where gauge injection would happen) doesn't
provide model info. The plugin must cache model info from another hook.

---

## 7. Provider / LanguageModel Access

**File**: `packages/opencode/src/provider/provider.ts` (upstream/dev)

```typescript
export async function getModel(providerID: string, modelID: string) { ... }
export async function getLanguage(model: Model): Promise<LanguageModelV2> { ... }
```

`Provider.getModel()` returns a `Provider.Model` which includes the language
model instance with all provider config applied. This is what the plugin would
need for summarization LLM calls.

**Not exposed to plugins**. Plugins have the SDK client but no access to
`Provider.getModel()` or the `LanguageModelV2` instance.

---

## 8. Feasibility Assessment: What Can Be Done With ZERO Upstream Changes

Using only existing upstream hooks:

| Plugin Feature | Feasible? | How |
|---------------|-----------|-----|
| Register `context-bonsai:prune` / `context-bonsai:retrieve` tools | YES | `tool` hook |
| Modify messages before LLM | YES | `experimental.chat.messages.transform` |
| Inject system prompt guidance | YES | `experimental.chat.system.transform` |
| Track token usage | YES | `event` hook (message.updated events) |
| Get model context limit | YES | `chat.params` or `experimental.chat.system.transform` (cache it) |
| Read session messages from tool | **NO** | ToolContext has no message access |
| Write archive metadata to messages | **NO** | ToolContext has no Storage/Session API |
| Make LLM call for summarization | **NO** | ToolContext has no languageModel |
| Inject context gauge | **PARTIAL** | Transform hook can add parts, but input lacks model info (must cache from other hooks) |

### The Hard Blocker

The **prune tool** and **retrieve tool** cannot function without session message
read/write access and an LLM for summarization. The transform hook handles
rendering, and gauge data can be cached — but the tools themselves are dead in
the water without ToolContext enhancements.

---

## 9. Minimum Upstream Changes Required

### Change 1: Add `metadata` to Message Schema

Add to `MessageV2.Base` in `packages/opencode/src/session/message-v2.ts`:

```typescript
const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
  metadata: z.record(z.unknown()).optional(),  // <-- new
})
```

This is a general-purpose extension point for plugins. Each plugin namespaces
its data by `ctx.pluginID` (e.g., `metadata[ctx.pluginID]`). Since `metadata`
is a known Zod field, it survives `Session.updateMessage()` which parses inputs
through `fn(MessageV2.Info, ...)` (`util/fn.ts:5`). No schema bypass needed.

**Scope**: 1 line.

### Change 2: Add `languageModel` to Plugin ToolContext

Add to `packages/plugin/src/tool.ts` ToolContext:

```typescript
languageModel: LanguageModelV2
```

**Implementation site**: `packages/opencode/src/session/prompt.ts`,
`resolveTools()` function (line ~680), inside the `context()` helper. Delegates
to `Provider.getLanguage(model)` (already resolved in `resolveTools` scope).
Must be explicitly mapped in `registry.ts:fromPlugin()` (line 67) as
`languageModel: ctx.languageModel` — not leaked through the unsafe `...ctx`
spread + cast.

**Note on `messages`**: Plugin tools already receive the `messages` array at
runtime through the `...ctx` spread and `as unknown as PluginToolContext` cast
in `registry.ts:67-71`. This must be formalized with both a type definition on
`ToolContext` AND explicit runtime mapping (`messages: ctx.messages`) in
`fromPlugin()` to avoid depending on an undocumented leak.

### Change 3: Add `updateMessage()` to Plugin ToolContext

Add to `packages/plugin/src/tool.ts` ToolContext:

```typescript
updateMessage(id: string, fn: (draft: MessageInfo) => void): Promise<void>
```

**Implementation site**: `packages/opencode/src/tool/registry.ts`,
`fromPlugin()` function (line 60). Unlike `languageModel`, this cannot be added
to the internal `Tool.Context` and spread through — it must be implemented
directly in `fromPlugin()`, delegating to:

- `Storage.update(["message", ctx.sessionID, id], fn)` — atomic read-modify-write
- `Bus.publish(MessageV2.Event.Updated, ...)` — notify subscribers

`Storage.update()` (`storage/storage.ts:179`) is preferred over
`Session.updateMessage()` (`session/index.ts:378`) for atomic read-modify-write
semantics, avoiding stale writes if multiple operations target the same message.

**Risk**: This exposes write access to messages. Mitigated by:
- Plugins already have shell access (`$`) which is more dangerous
- Identity-field guard can prevent corruption (throw if id/sessionID/role change)

### Change 4: Formalize `messages` on Plugin ToolContext

Add to `packages/plugin/src/tool.ts` ToolContext:

```typescript
messages: Array<{ info: Message; parts: Part[] }>
```

**Implementation site**: `packages/opencode/src/tool/registry.ts`,
`fromPlugin()` function (line 60). Requires explicit runtime mapping
(`messages: ctx.messages`) — must not rely on the unsafe `...ctx` spread + cast
that currently leaks internal fields.

**Scope**: Type definition + 1 line in `fromPlugin()`.

### Change 5: Add `pluginID` to Plugin ToolContext

Add to `packages/plugin/src/tool.ts` ToolContext:

```typescript
pluginID: string
```

**Implementation**: `Plugin.list()` (`plugin/index.ts:118`) currently returns
`Hooks[]` with no source identity. The loading pipeline must change to return
`Array<{ name: string; hooks: Hooks }>` (or equivalent), associating each
`Hooks` entry with its npm package name (`pkg` at `plugin/index.ts:60`) or
filename namespace (`registry.ts:43`). This name is threaded to `fromPlugin()`
and set explicitly on `pluginCtx`.

**Scope**: ~15 lines across 3 files (`plugin/src/tool.ts`, `plugin/index.ts`,
`tool/registry.ts`).

### Change 6: Enrich `experimental.chat.messages.transform` Input

Current: `input: {}`
Proposed: `input: { sessionID: string; model: Model }`

This gives the transform hook the session context and model info needed for
gauge computation without requiring the plugin to maintain fragile side caches
populated from other hooks.

**Without this change**: The plugin still works, but must cache `sessionID` and
`model.limit.context` from `chat.params` and correlate by session. See the
proposal's Feature 4 for the workaround.

**Scope**: 2 lines across 2 files — 1 line at `prompt.ts:620` (runtime) +
1 line in `plugin/src/index.ts:198` (type: `input: {}` →
`input: { sessionID: string; model: Model }`).

---

## 10. Open Questions

1. **Metadata persistence**: ~~RESOLVED.~~ Adding `metadata:
   z.record(z.unknown()).optional()` to the `MessageV2.Base` schema (see Section
   9, Change 1) solves this structurally. Since `metadata` is a known Zod field,
   it survives `Session.updateMessage()` which parses inputs through
   `fn(MessageV2.Info, ...)` (`util/fn.ts:5`). Plugins namespace by package name
   within `metadata` to avoid cross-plugin conflicts. No schema bypass or
   call-site auditing needed.

2. **The `experimental` prefix**: Both transform hooks are marked
   `experimental`. Could they be removed or changed in a future upstream
   release? The proposal should acknowledge this risk.

3. **Plugin state across turns**: The transform hook fires every turn. The
   plugin needs state (cached model info, compaction mode flag, token tracking).
   Plugins can hold state in module-level variables since they're loaded once at
   startup. Need to confirm this pattern is reliable.

4. **Message ordering in transform hook**: `sessionMessages` is a clone of
   `msgs` which comes from `MessageV2.filterCompacted()`. Need to confirm the
   ordering (chronological) and that the clone is deep enough for safe mutation.
