# Proposal: Plugin ToolContext Enhancements for OpenCode

## Motivation

OpenCode's plugin system provides 16 hooks covering tool registration,
message/system transforms, event subscriptions, and more. Plugins can register
tools, modify the conversation before it reaches the LLM, inject system prompt
content, and subscribe to events.

The plugin `ToolContext` currently provides session/message IDs, abort signals,
and directory info — enough for tools that take input and return output. Plugins
that need to annotate messages, make side-effect-free LLM calls, or read the
conversation from within a tool need a few additional capabilities on the
`ToolContext`.

This proposal describes **5 small, general-purpose additions** (totaling ~40
lines of implementation) and **1 recommended quality-of-life improvement** that
extend the `ToolContext` to support these patterns. All changes are additive and
benefit any plugin that works with conversation data.

### Motivating Use Case

We're building a context management plugin ("Context Bonsai") that lets the LLM
selectively archive and retrieve stale conversation context, keeping sessions
under the context limit without triggering the built-in overflow compaction. It
needs to: read messages, write metadata onto them, call an LLM for
summarization, and namespace its data cleanly. Everything else — message
rendering, gauge injection, system prompt guidance — works today with existing
hooks. These five `ToolContext` gaps are the only blockers.

---

## Summary of Changes

| # | Change | Scope | Backward Compatible |
|---|--------|-------|---------------------|
| 1 | Add `metadata` bag to `MessageV2.Base` | 1 line + SDK regen | Yes — new optional field |
| 2 | Add `languageModel` to plugin `ToolContext` | ~10 lines / 4 files | Yes — additive |
| 3 | Add `updateMessage(id, fn)` to plugin `ToolContext` | ~15 lines / 2 files | Yes — additive |
| 4 | Formalize `messages` on plugin `ToolContext` | ~2 lines / 2 files | Yes — formalizes existing leak |
| 5 | Add `pluginID` to plugin `ToolContext` | ~15 lines / 3 files | Yes — new `listDetailed()` API; `list()` unchanged |
| 6 | *(Recommended)* Enrich transform hook input | 2 lines / 2 files | Yes — additional input fields |

All changes are additive. No existing APIs, types, or call sites are modified
(except Change 4, which makes an already-leaking field explicit). No breaking
changes for existing plugins.

---

## Change 1: Add `metadata` to Message Schema

**What**: Give plugins a way to persist custom data alongside messages. Currently,
any keys outside the Zod schema are stripped by `.parse()`, so data added by
plugins is lost when messages pass through `Session.updateMessage()` →
`fn(MessageV2.Info, ...)` (`util/fn.ts:5`). A schema-level extension point
makes plugin data a first-class citizen.

**Solution**: Add a general-purpose metadata bag to `MessageV2.Base`:

```typescript
// packages/opencode/src/session/message-v2.ts
const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
  metadata: z.record(z.unknown()).optional(),  // new
})
```

**Why this works**: As a known Zod field, `metadata` survives all existing
parsing paths — including `Session.updateMessage()` which wraps inputs through
`fn(MessageV2.Info, ...)`. Plugins namespace by their package name within the
bag (e.g., `metadata["my-plugin"]`), each validating their own namespace with
their own Zod schemas on read. The upstream schema imposes no structure beyond
`z.record(z.unknown())`.

**Storage round-trip**: `Storage.read()` (`storage/storage.ts:174`) loads
message JSON via `Bun.file().json()` with an `as T` cast — no Zod parse on
read. So metadata survives storage regardless, but having it in the schema means
it also survives any code path that *does* parse through Zod.

**SDK types**: The SDK `Message` types (`packages/sdk/js/src/v2/gen/types.gen.ts`)
are generated. After adding `metadata` to the schema, re-running the automated
build script (`packages/sdk/js/script/build.ts`) propagates the type to the SDK.
Plugin hooks typed with SDK `Message` (e.g., `experimental.chat.messages.transform`
at `plugin/src/index.ts:197`) then see `metadata` at the type level.

**Scope**: 1 line in `message-v2.ts`, plus automated SDK regeneration.

**Use cases beyond our plugin**: bookmarking, annotations, message tagging,
cross-plugin data sharing, debug metadata, analytics markers.

---

## Change 2: Add `languageModel` to Plugin ToolContext

**What**: Give plugin tools access to the session's pre-configured
`LanguageModelV2` instance for side-effect-free LLM calls (summarization,
classification, extraction). The instance already exists — `Provider.getLanguage()`
resolves it with all provider configuration applied (base URLs, auth tokens,
headers, middleware). Exposing it on `ToolContext` lets plugins use it directly.

**Solution**: Add `languageModel` to the plugin `ToolContext` type and thread it
through from `resolveTools()`:

```typescript
// packages/plugin/src/tool.ts
import type { LanguageModelV2 } from "ai"

export type ToolContext = {
  // ... existing fields ...
  languageModel: LanguageModelV2
}
```

**Implementation**:

| File | Change |
|------|--------|
| `packages/plugin/src/tool.ts` | Add `languageModel: LanguageModelV2` to `ToolContext` type |
| `packages/opencode/src/tool/tool.ts` | Add `languageModel: LanguageModelV2` to internal `Tool.Context` type |
| `packages/opencode/src/session/prompt.ts` | Resolve via `Provider.getLanguage(model)` in `resolveTools()`, add to `context()` helper |
| `packages/opencode/src/tool/registry.ts` | Explicit mapping: `languageModel: ctx.languageModel` in `fromPlugin()` |

The `model` parameter is already available in `resolveTools()` scope
(`input.model`). `Provider.getLanguage(model)` (`provider/provider.ts:1110`)
returns the `LanguageModelV2` instance. Resolve it once, thread it through.

Plugins use it with the AI SDK directly:

```typescript
import { generateText } from "ai"
const { text } = await generateText({
  model: ctx.languageModel,
  system: "Summarize the following content...",
  messages: [...],
})
```

This is side-effect-free — no session messages created, no conversation loop
triggered, no events emitted.

**Scope**: ~10 lines across 4 files.

**Use cases**: summarization, classification, content extraction, automated
labeling, translation, any plugin that needs LLM reasoning as a subroutine.

---

## Change 3: Add `updateMessage(id, fn)` to Plugin ToolContext

**What**: Give plugin tools an atomic message update function. The `ToolContext`
provides `sessionID` and `messageID` for identity; adding a mutation API
completes the read/write story, especially in combination with the `metadata`
bag from Change 1.

**Solution**: Expose an atomic message update function on the plugin `ToolContext`:

```typescript
// packages/plugin/src/tool.ts
export type ToolContext = {
  // ... existing fields ...
  updateMessage(id: string, fn: (draft: MessageInfo) => void): Promise<void>
}
```

**Implementation** (in `registry.ts:fromPlugin()`):

The function delegates to `Storage.update()` (`storage/storage.ts:179`) —
atomic read-modify-write with a write lock — rather than
`Session.updateMessage()` (`session/index.ts:378`), which uses `Storage.write()`
(blind overwrite). `Storage.update()` reads the current state from disk before
applying the mutation, so concurrent writes to the same message don't clobber
each other.

**Safety guards** (applied in the wrapper before writing):

1. **Identity-field immutability**: Capture `id`, `sessionID`, and `role` before
   calling `fn(draft)`. Throw if any differ afterward.
2. **Required-field type check**: Parse the draft through `MessageV2.Info` after
   the callback. This catches missing or wrong-typed required fields without
   stripping extra fields (metadata entries pass through).

After a successful write, publish `MessageV2.Event.Updated` to keep the event
bus consistent.

**Trust model**: Plugins already have shell access (`$` via `BunShell` in
`PluginInput`), so message write access doesn't expand the trust boundary.
The identity guards prevent accidental corruption of structural fields.

**Scope**: ~15 lines across 2 files (`plugin/src/tool.ts`,
`tool/registry.ts`).

**Use cases**: persisting plugin state on messages (bookmarks, annotations,
archive markers, review status), any plugin that needs durable per-message data.

---

## Change 4: Formalize `messages` on Plugin ToolContext

**What**: Make `messages` an explicit part of the plugin `ToolContext` contract.
Plugin tools already receive the full `messages` array at runtime — it comes
through the `...ctx` spread and `as unknown as PluginToolContext` cast in
`registry.ts:fromPlugin()` (line 67-71), since the internal `Tool.Context`
(`tool/tool.ts:23`) includes `messages: MessageV2.WithParts[]`. Adding it to
the plugin `ToolContext` type and mapping it explicitly in `fromPlugin()` turns
this into a stable API with compile-time guarantees if the internals change.

**Solution**: Add `messages` to the plugin `ToolContext` type and map it
explicitly in `fromPlugin()`:

```typescript
// packages/plugin/src/tool.ts
export type ToolContext = {
  // ... existing fields ...
  messages: Array<{ info: MessageInfo; parts: Part[] }>
}
```

```typescript
// registry.ts:fromPlugin() — explicit, not relying on spread
const pluginCtx = {
  ...ctx,
  directory: Instance.directory,
  worktree: Instance.worktree,
  messages: ctx.messages,  // explicit mapping
}
```

This follows the same pattern as `directory` and `worktree`, which are already
explicitly mapped rather than leaked through the spread.

**Scope**: Type definition + 1 line of explicit mapping in `fromPlugin()`.

**Use cases**: any plugin tool that needs to reason about the conversation —
context analysis, search, message referencing, metadata inspection.

---

## Change 5: Add `pluginID` to Plugin ToolContext

**What**: Give plugins a framework-provided identity for metadata namespacing.
Plugins that write to the `metadata` bag (Change 1) need a namespace key.
Providing it on `ToolContext` means plugins don't hardcode their own name, and
the framework can introspect or enforce namespacing in the future.

**Solution**: Add `pluginID` to the plugin `ToolContext`:

```typescript
// packages/plugin/src/tool.ts
export type ToolContext = {
  // ... existing fields ...
  pluginID: string
}
```

**Implementation**: `Plugin.list()` (`plugin/index.ts:118`) returns `Hooks[]`
with no source identity. Changing its return type would break 5 existing call
sites (`registry.ts:50`, `provider.ts:861`, `auth.ts:13`,
`cli/cmd/auth.ts:310`, `cli/cmd/auth.ts:326`). Instead, add a **new
`Plugin.listDetailed()` API** returning `Array<{ name: string; hooks: Hooks }>`.
The name comes from the npm package name (`pkg` at `plugin/index.ts:60`) for
installed plugins, or the filename namespace (`registry.ts:43`) for custom
tools. Only `registry.ts:50` (tool registration) switches to `listDetailed()`;
all other call sites remain on `list()` unchanged.

**Scope**: ~15 lines across 3 files (`plugin/src/tool.ts`, `plugin/index.ts`,
`tool/registry.ts`).

**Use cases**: metadata namespacing, debug tooling ("which plugin owns this
data?"), future enforced namespace isolation, plugin identity in logs.

---

## Recommended: Enrich Transform Hook Input

This is not a hard blocker — it has a straightforward workaround — but it
simplifies plugin development for any plugin using
`experimental.chat.messages.transform`.

**What**: The transform hook at `prompt.ts:620` currently passes `{}` as input:

```typescript
await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
```

Plugins that need session identity or model context in the transform hook
currently maintain per-session caches populated from other hooks (`chat.params`,
`event`). Passing `{ sessionID, model }` directly eliminates this boilerplate
and the associated ordering dependencies.

**Solution**: Pass the already-in-scope variables:

```typescript
await Plugin.trigger("experimental.chat.messages.transform", { sessionID, model }, { messages: sessionMessages })
```

And update the hook's type in `plugin/src/index.ts:198` from `input: {}` to
`input: { sessionID: string; model: Model }`.

Both `sessionID` and `model` are already local variables at the call site.
Existing plugins that ignore the input are unaffected.

**Workaround if deferred**: Plugins cache `sessionID` and `model.limit.context`
from `chat.params` and correlate by session. Works fine, just more boilerplate
than passing the already-in-scope values.

**Scope**: 2 lines across 2 files.

---

## Implementation Notes

### Backward Compatibility

All changes are additive. Existing plugins continue to work without
modification:

- `metadata` is optional — messages without it parse identically to today
- New `ToolContext` fields are additions — existing plugins that don't use them
  are unaffected
- `Plugin.list()` is unchanged — only `registry.ts:50` uses the new
  `listDetailed()` API
- The transform hook input change (Change 6) adds fields — plugins ignoring
  input are unaffected

### The `fromPlugin()` Cast

`registry.ts:fromPlugin()` currently builds the plugin context via:

```typescript
const pluginCtx = {
  ...ctx,
  directory: Instance.directory,
  worktree: Instance.worktree,
} as unknown as PluginToolContext
```

The `as unknown as PluginToolContext` cast means internal `Tool.Context` fields
are available to plugins at runtime even when not in the plugin type. Changes
2–5 should be **explicitly mapped** in `fromPlugin()` rather than relying on
the spread, so the runtime contract matches the type contract. This way, if the
internal `Tool.Context` is ever refactored, explicit mappings produce
compile-time errors rather than silent mismatches.

### Trust Model

Plugins already receive `$` (BunShell) in `PluginInput`, giving them arbitrary
shell access. The additions here — message read, message write, LLM access —
don't expand the trust boundary. The `updateMessage` safety guards (identity
immutability + required-field validation) prevent accidental structural
corruption, not malicious access.

---

## Total Scope

~42 lines of implementation across 6 files, plus automated SDK type
regeneration. No existing APIs modified. No breaking changes. Each change is
independently useful and can be reviewed/merged separately, though they compose
naturally for plugins that need the full set.
