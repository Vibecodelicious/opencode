# Proposal: Context Bonsai as an OpenCode Plugin

## Summary

This proposal describes how to implement surgical context compaction ("Context
Bonsai") as a standalone OpenCode plugin distributed as an npm package. The
plugin gives the LLM the ability to selectively prune stale or problematic
context while preserving summaries, and to retrieve the original content later
within the same session. Pruned content remains retrievable until OpenCode's
built-in overflow compaction fires, at which point the originals are
destructively summarized and no longer recoverable. The goal is to avoid
triggering that built-in compaction by staying ahead of the context limit through
continuous, targeted pruning.

**The plugin requires five small upstream changes to OpenCode**: a `metadata`
bag on the message schema (for plugin data persistence), `languageModel` on
`ToolContext` (for summarization), `updateMessage(id, fn)` on `ToolContext`
(for writing metadata), `messages` formalized on the plugin `ToolContext`
(for reading the conversation), and `pluginID` on `ToolContext` (for consistent
metadata namespacing via a new `Plugin.listDetailed()` API). One additional
change is **recommended**: enriched transform hook input (for session/model
context without fragile side caches). The recommended change has a workaround
described below.

---

## What the Plugin Does

When installed, the plugin:

1. **Registers two tools** (`context-bonsai:prune` and `context-bonsai:retrieve`)
   that the LLM can call. Tool names are prefixed with the plugin name to avoid
   collisions — the runtime tool map (`prompt.ts:724`) is last-write-wins, so
   unprefixed names like `prune` risk silent override by other plugins or
   built-in tools
2. **Injects context gauges** into the conversation so the LLM sees its own
   token utilization and is prompted to prune when pressure builds
3. **Renders pruned messages as compact placeholders** in the conversation
   payload sent to the LLM, so pruned content doesn't consume tokens
4. **Notifies the user** whenever the LLM prunes content (always-on, no
   configuration)

### What the Plugin Does NOT Do

- **Gauge ramping** — no variable-frequency gauge logic; gauges are injected on
  a fixed cadence (see Feature 4)
- **User autonomy modes** — no ask/notify/silent selection; always notify
- **Post-compaction gauge reset** — relies on OpenCode's existing token
  recalculation after each turn

---

## How Each Feature Maps to Upstream Hooks

### Feature 1: Prune Tool

The LLM calls this tool to archive a range of messages. It operates in two
phases:

**Phase 1 — Enable message ID visibility.** The LLM calls `context-bonsai:prune`
with no arguments. The plugin sets an internal flag. On the next turn, the
message transform hook (see Feature 3) prefixes every message with its ID so the
LLM can see and reference them. The tool returns a message like "[Message IDs are
now visible. Identify the range to prune and call context-bonsai:prune again with
from_id and to_id.]"

**Phase 2 — Archive the range.** The LLM calls `context-bonsai:prune` with `from_id`,
`to_id`, and a `reason`. The plugin:
1. Reads the messages in the range from `ctx.messages` (the full conversation
   array already available on the tool context — see "Upstream State" below)
2. Calls `generateText()` using `ctx.languageModel` with a summarization prompt
   to produce a summary + index terms
3. Writes archive metadata onto the anchor message (the first in the range) via
   a single `ctx.updateMessage()` call (see "Archive Storage" below)
4. Clears the ID-visibility flag
5. Returns a notification to the user describing what was pruned and the summary

**Failure handling**: If the summarization LLM call fails (rate limit, network
error, provider outage), the prune operation aborts entirely. No archive
metadata is written. The tool returns an error message to the LLM.

**Atomicity**: The entire prune operation writes to exactly one file — the anchor
message — via a single `Storage.update()` call. Follower messages carry no
metadata; the transform hook identifies them by position between the anchor and
`rangeEnd`. This means a crash cannot leave partial state: either the anchor
write completes (full prune) or it doesn't (no prune).

**Input validation**: The tool must validate `from_id` and `to_id` before
proceeding: both IDs must exist in `ctx.messages`, `from_id` must precede
`to_id` chronologically, neither ID may fall within an already-pruned range, and
the range must contain at least one message. Invalid inputs return a descriptive
error to the LLM.

**Two-phase schema note**: Since phase 1 (enable visibility) takes no arguments
and phase 2 (archive range) requires `from_id`, `to_id`, and `reason`, all
parameters must be optional in the tool's Zod schema. The tool distinguishes
phases by checking whether arguments are present.

**Upstream hook used**: `tool` (existing — `packages/plugin/src/index.ts`)

**Upstream changes required**: `metadata` on message schema, `languageModel`
and `updateMessage()` on ToolContext. See "Required Upstream Changes" below.

### Feature 2: Retrieve Tool

The LLM calls `context-bonsai:retrieve` with an `anchor_id` argument (the ID of the anchor
message to restore). The LLM knows which anchors exist because the transform
hook renders placeholders with visible anchor and range-end IDs (see Feature 3).

The plugin:
1. Validates that `anchor_id` exists in `ctx.messages` and has archive metadata
2. Clears the archive metadata on the anchor via a single `ctx.updateMessage()`
   call, restoring the entire range to its un-pruned state
3. Returns a short status message (e.g., "Restored 5 messages from range
   msg_abc to msg_xyz. Original content is now visible.")

The full original message content was never deleted — the transform hook only
replaced it with placeholders in the ephemeral clone sent to the LLM. After the
retrieve tool clears the metadata, the transform hook on the next LLM turn sees
clean messages and passes them through unmodified. The original content
reappears naturally in the conversation.

**Same-step guard**: If the LLM calls `context-bonsai:prune` and then
`context-bonsai:retrieve` in the same response, the retrieve sees stale
`ctx.messages` without the prune's metadata (see "Within-step staleness" in
Operational Details). The retrieve tool must detect this and return an error:
"This archive was created in the current step. Call retrieve on the next turn."
The plugin tracks which anchors were pruned in the current step and checks
against this set before proceeding.

**Why the tool result is short**: All plugin tool output passes through
`Truncate.output()` in `fromPlugin()` (`registry.ts:73`) — capped at 2000 lines
/ 50KB, with no plugin opt-out. Small outputs pass through unmodified, but
returning large archived content as tool output would be truncated. The metadata-clearing approach avoids this entirely: the
tool result is just a status line, and the actual content restoration happens
through the transform hook pipeline on the immediate next turn.

**Timing**: Tool results trigger an LLM continuation that goes through the full
`context()` pipeline (`prompt.ts`), including the transform hook. So the restored
messages are visible to the LLM on the very next assistant turn — not delayed.

**Upstream hook used**: `tool` (existing)

**Upstream change required**: `updateMessage()` on ToolContext (same as Feature
1). The retrieve tool uses a single `ctx.updateMessage()` call on the anchor to
clear its metadata — followers carry no metadata, so no additional writes are
needed.

### Feature 3: Archived Message Rendering + Message ID Prefixing

This is the core mechanism that makes pruning effective. On every turn, before
the conversation is sent to the LLM, the plugin intercepts the message list and:

1. **Replaces anchor messages with placeholders.** For each message that has
   archive metadata in `metadata[ctx.pluginID].archive`, the plugin replaces
   its parts with a single text part:
   ```
   [PRUNED: msg_abc to msg_xyz]
   Summary: <the generated summary>
   Index: <comma-separated index terms>
   ```
2. **Removes follower messages.** Using the anchor's `rangeEnd`, the plugin
   identifies all messages between the anchor and the range-end ID by position
   in the array and removes them entirely. Follower messages carry no metadata —
   membership is determined solely by position relative to the anchor.
3. **Prefixes message IDs** when the ID-visibility flag is set (phase 1 of the
   prune flow), so the LLM can reference messages by ID.

**Follower identification edge cases**: Messages are ordered by monotonically
increasing IDs (`Identifier.ascending()` uses a hex-encoded timestamp prefix),
so chronological order is guaranteed under normal operation. Two edge cases to
handle:
- **`rangeEnd` missing** (e.g., message deleted via session revert, or filtered
  out by `filterCompacted()`): The plugin treats the anchor as a single-message
  archive — replace the anchor with a placeholder, but remove no followers. This is a safe fallback: no content is hidden beyond the anchor
  itself, and the summary is still useful context.
- **Multiple pruned ranges**: The transform hook must process all anchors in a
  single pass. It should collect the set of message indices to remove first, then
  filter the array once — not splice during iteration, which would shift indices
  and corrupt subsequent range boundaries.

**Upstream hook used**: `experimental.chat.messages.transform` (existing —
`packages/opencode/src/session/prompt.ts:620`)

This hook fires after messages are loaded from storage and after system-reminder
wrapping, but BEFORE `toModelMessages()` converts them to LLM format. The plugin
receives the `WithParts[]` array and modifies it in-place. The upstream
`toModelMessages()` function then converts the plugin's modified output to model
format — it doesn't need to know about archives.

**No upstream change required.**

**Feasibility reference**: The hook is already called at `prompt.ts:620`:
```typescript
await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
```
The output `messages` array is mutable. The plugin modifies it in-place before
`toModelMessages()` at line 629.

**Note on clone depth**: `sessionMessages` is produced by `clone(msgs)` (a
deep clone via `remeda`'s `clone()`, which recursively clones plain objects and
arrays). The plugin mutates this clone, not the original message data. This
needs to be verified during implementation — if the clone is shallow, the plugin
must defensively copy parts arrays before modifying them.

**Replacement part conformance**: Placeholder parts must conform to the
`TextPart` schema (with `id`, `sessionID`, `messageID`, `type: "text"`, `text`).
The plugin should generate valid part IDs and reference the correct
message/session from the original message being replaced.

### Feature 4: Context Gauges

The plugin injects token utilization information into the conversation so the
LLM can see context pressure and decide when to prune.

**Cadence**: The gauge is injected periodically (the exact cadence is a tuning
parameter internal to the plugin — turn interval, utilization threshold, or
both). The plugin tracks turn count per session via its internal state.

The gauge is injected as a `<system-reminder>`-tagged synthetic text part on the
last user message, following the same pattern OpenCode already uses for plan-mode
and build-switch reminders (`prompt.ts:1234`, `insertReminders()`):

```
<system-reminder>
[CONTEXT GAUGE: 67,000 / 100,000 tokens (67%)]
</system-reminder>
```

The gauge itself is just data — the behavioral guidance lives in the system prompt
(Feature 5).

**How the plugin gets token data**:
- **Token counts**: The `event` hook subscribes to `message.updated` events.
  Assistant messages include `tokens.input`, `tokens.output`, and cache counts.
  The plugin caches the latest values per session.
- **Model context limit**: The `chat.params` hook receives `model: Model` which
  includes `limit.context` and `limit.input`. The plugin caches this per session.

**Upstream hook used**: `experimental.chat.messages.transform` (existing) for
injecting the gauge text into the message array. `event` (existing) and
`chat.params` (existing) for data collection.

**Upstream change recommended**: Change 6 (enrich transform hook input with
`{ sessionID, model }`). Without this change, the plugin must maintain per-session
caches for session identity and model limits populated from `chat.params` — see
Change 6 for the full rationale and the workaround if this change is deferred.

**Token budget note**: The gauge text and system prompt guidance (Feature 5)
consume tokens from the context window. The gauge is ~30 tokens per injection;
the system prompt guidance is a fixed cost (estimated ~800-1000 tokens given the
detailed behavioral policy). These are small relative to a typical 128K+ context
window. The plugin's gauge calculation should account for its own injected tokens
to avoid slightly over-reporting available space.

**Gauge staleness**: Token counts come from `message.updated` events on the
*previous* turn's assistant message. The gauge is always one turn behind — this
is a known limitation of the event-driven approach, not a bug. There is currently
no hook that provides the current turn's token count before the LLM responds; a
future upstream change could expose this, but the plugin does not depend on it.
After a prune operation, the gauge will still show the pre-prune token count until
the next LLM response fires a new `message.updated` event. The LLM already sees
the pruned message placeholders in its context, so it can infer that utilization
has decreased even if the gauge hasn't updated yet.

**Event dispatch timing**: Plugin event handlers are invoked without `await`
(`plugin/index.ts:132`) — the bus fires them as fire-and-forget. If the plugin's
event handler updates its token cache asynchronously, the cache update could race
with the next transform hook invocation.

**Strategy**: The plugin's event handler must use **synchronous mutation** of its
cache data structure — no `await` between reading the event payload and writing
to the cache. Concretely: the `event` hook handler extracts token counts from
`message.updated` events and writes them to a `Map<sessionID, TokenData>` in a
single synchronous assignment. Since JavaScript is single-threaded, a synchronous
write cannot be interleaved with a transform hook read. This eliminates the race
regardless of whether the event handler's outer `async` wrapper is awaited. As a
**fallback**, if the gauge cache has no data for the current session (e.g., first
turn, or edge case where the event hasn't fired yet), the gauge injection is
simply skipped for that turn — the LLM operates without a gauge until the next
turn when the cache is populated. This degrades gracefully rather than showing
stale or incorrect numbers.

### Feature 5: System Prompt Guidance

The plugin injects behavioral instructions into the system prompt that tell the
LLM how to use the prune/retrieve tools, how to interpret context gauges, and
**when and how aggressively to prune**. This guidance is the primary driver of
pruning behavior — the gauge (Feature 4) provides data, but the system prompt
defines the decision-making policy.

The guidance below is derived from the `surgical_compaction` branch
(`packages/opencode/src/tool/compact.txt`), adapted for the plugin architecture.

**Proactive pruning triggers (any gauge level):**

The LLM must prune **immediately** when it detects these patterns, regardless of
context utilization percentage:

1. **Completed task blocks** — bug investigation concluded and fix applied, plan
   written and approved, code review finished, feature implemented and tested,
   research/exploration completed with findings captured, any task where the LLM
   has moved on to something different
2. **Project/repo switches** — when the conversation shifts to a different
   codebase or project, archive the previous project's context before diving in
3. **Multiple gauges seen without pruning** — if the LLM has seen 2+ context
   gauges in a session and hasn't pruned, it is being too conservative; review
   completed work and archive it

**Do not wait for high context utilization to prune completed work.** A 25%
context with finished debugging sessions should be pruned. Keeping stale
completed work wastes context space that could be used for the current task.

**Gauge-based escalation:**

- **<30%**: Prune completed work only; no need to prune ongoing work
- **30-50%**: Prune completed work; monitor ongoing discussions for completion
- **50-80%**: Actively look for pruning opportunities; completed work should
  already be archived
- **>80%**: Strongly consider pruning; prioritize content where learnings are
  already captured; multiple ranges may be appropriate to maximize space freed

**Content detection patterns:**

- Voluminous tool outputs (file reads, grep results, command output) — IF key
  insights are captured in the LLM's prior responses
- Completed discussions where decisions are made and documented
- Reference material already incorporated into working context

**Quality gate — verify learnings are preserved before pruning:**

Raw content can be archived when the *meaning* is captured elsewhere: in the
LLM's prior responses/analysis, in the pruning summary the LLM will generate,
in code/artifacts created as a result, or in decisions already documented. Do NOT
prune just because content was read — prune when the insights are safe.

**Loop/iteration detection:**

When working through debugging, retrying, or iterating: prior iterations may be
pruned once a new iteration begins and the LLM has learned from the previous
ones. The summary MUST capture what was tried in each iteration, what was learned
(errors, insights, partial successes), any constraints discovered, and the
current hypothesis. "Debugging session for authentication issues" is an
unacceptable summary — it loses the debugging insights that a future retrieve
would need.

**Range partitioning:**

Split a contiguous range into multiple prune calls when different topics are
intermixed (separate summaries enable targeted retrieval), when the user might
want partial retrieval, or when a single summary would lose important
distinctions between sub-topics.

**Upstream hook used**: `experimental.chat.system.transform` (existing —
`packages/plugin/src/index.ts`). Input includes `{ sessionID?, model }`, so the
plugin can tailor guidance per provider if needed.

**No upstream change required.**

### Feature 6: Notify Mode

When the LLM prunes content, the tool result includes a human-readable summary
of what was pruned. This is visible to the user in the TUI as a normal tool
result. No special rendering is needed — the existing tool result display
handles it.

**No upstream hook or change required.** This is just the tool's return value.

---

## Upstream State: What Already Works

### Messages Already Leak Through to Plugin Tools

The internal `Tool.Context` type (`packages/opencode/src/tool/tool.ts:23`)
includes a `messages: MessageV2.WithParts[]` field. This is populated at
`prompt.ts:691`:

```typescript
messages: input.messages,
```

Plugin tools are constructed in `registry.ts:fromPlugin()` (line 60), which
spreads the internal context into the plugin context:

```typescript
const pluginCtx = {
  ...ctx,
  directory: Instance.directory,
  worktree: Instance.worktree,
} as unknown as PluginToolContext
```

The `as unknown as PluginToolContext` cast means all internal `Tool.Context`
fields — including `messages` — are present on the object at runtime, even
though they're not in the plugin `ToolContext` type definition. Plugin tools can
already access `(ctx as any).messages` today.

**Implication**: The plugin can read the full conversation today via the leak.
Formalizing `messages` on the plugin `ToolContext` requires both a type definition
and an explicit runtime mapping in `fromPlugin()` — see Change 4 below.

---

## Archive Storage: Namespaced Message Metadata

The plugin stores archive data in a `metadata` bag on the message schema — a
general-purpose extension point for plugins. Each plugin namespaces its data by
package name, preventing cross-plugin clobbering.

**How it works**: When the prune tool archives a range, it makes a single
`ctx.updateMessage()` call on the anchor message (the first in the range):

```typescript
await ctx.updateMessage(fromId, (draft) => {
  draft.metadata ??= {}
  draft.metadata[ctx.pluginID] = {
    archive: {
      summary: "Debugging attempts - tried token refresh, session storage...",
      indexTerms: ["auth", "debugging", "middleware"],
      rangeEnd: toId,
    },
  }
})
```

Follower messages (between anchor and `rangeEnd`) carry no metadata. The
transform hook identifies them by position in the message array relative to
the anchor. This makes the write truly atomic — one file, one
`Storage.update()` call, no partial-state risk on crash.

**Why metadata survives** (after Change 1 is applied): Once `metadata` is added
to `MessageV2.Base` as `z.record(z.unknown()).optional()`, Zod preserves it
through parsing. Any code path that parses messages through the schema — including
`Session.updateMessage()` (`session/index.ts:378`), which wraps inputs through
`fn(MessageV2.Info, ...)` (`util/fn.ts:5`) — will carry the field through because
it's a known schema field. No schema bypass needed.

The plugin's `ctx.updateMessage()` uses `Storage.update()` (atomic
read-modify-write) for safe concurrent writes, but this is just good practice —
not a workaround for schema issues.

**Namespacing**: Each plugin writes only to its own key within `metadata`
(e.g., `metadata["context-bonsai"]`), using `ctx.pluginID` (see Change 5) rather
than hardcoded strings. Other plugins use their own keys. No enforcement
mechanism is needed — plugins already have shell access, so the trust boundary is
established at the plugin installation level. This follows the same convention as
npm `package.json` keys, Kubernetes annotations, and HTTP headers.

**Plugin-local schema validation**: The upstream `metadata` bag is untyped
(`z.record(z.unknown())`). The plugin defines its own strict Zod schema for its
namespace and validates on read:

```typescript
const ArchiveSchema = z.object({
  archive: z.object({
    summary: z.string(),
    indexTerms: z.array(z.string()),
    rangeEnd: z.string(),
  }).optional(),
})
// On read:
const data = ArchiveSchema.parse(msg.info.metadata?.[ctx.pluginID] ?? {})
```

This gives the plugin type safety without requiring upstream to know about the
plugin's data shape.

**How it's used**:
- The **prune tool** writes archive data via `ctx.updateMessage()` into
  `metadata[ctx.pluginID]`
- The **retrieve tool** finds anchor messages via `ctx.messages`, then clears
  their metadata via `ctx.updateMessage()` to restore the range
- The **transform hook** finds anchor messages with archive metadata, replaces
  them with placeholders, and removes followers by position between anchor
  and `rangeEnd`

---

## Required Upstream Changes

### Change 1: Add `metadata` to Message Schema

**What**: Add a general-purpose metadata bag to the message base schema so
plugins can persist custom data alongside messages.

**Schema change** (in `packages/opencode/src/session/message-v2.ts`):

```typescript
const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
  metadata: z.record(z.unknown()).optional(),  // <-- new
})
```

**Estimated scope**: 1 line in `message-v2.ts`, plus SDK type regeneration. The
SDK `Message` types (`packages/sdk/js/src/v2/gen/types.gen.ts`) are generated and
currently lack `metadata`. The plugin hooks (`experimental.chat.messages.transform`
at `packages/plugin/src/index.ts:197`) are typed with the SDK `Message`, so
plugins won't see `metadata` at the type level until the SDK is regenerated. The
regeneration is automated (`./packages/sdk/js/script/build.ts`) — no manual SDK
editing required.

**Why this is needed**: Plugins need to persist data alongside messages (archive
summaries, index terms, pruning markers). Without a schema-blessed field, custom
data would be stripped by Zod's default `.parse()` behavior (which removes
unknown keys). By adding `metadata` to the schema, plugin data survives all
existing code paths — including `Session.updateMessage()` which wraps inputs
through `fn(MessageV2.Info, ...)` (`util/fn.ts:5`).

**Why this is general-purpose**: Any plugin that needs to annotate messages
benefits. The `z.record(z.unknown())` type imposes no structure — each plugin
validates its own namespace when reading. If upstream later wants per-plugin
schema validation, they can evolve toward a hook-based schema registration
system without breaking the existing convention.

**Session resumption safety**: `Storage.read()` (`storage/storage.ts:174`) loads
message JSON via `Bun.file().json()` with an `as T` cast — no Zod parse on the
read path. Custom metadata fields survive storage round-trips regardless of
schema, but having `metadata` in the schema means they also survive any code
path that does parse messages through Zod.

### Change 2: Add `languageModel` to Plugin ToolContext

**What**: Expose the session's pre-configured `LanguageModelV2` instance on the
plugin `ToolContext`.

**Type definition** (in `packages/plugin/src/tool.ts`):

```typescript
import type { LanguageModelV2 } from "ai"

export type ToolContext = {
  // ... existing fields ...
  languageModel: LanguageModelV2
}
```

**Implementation site**: The internal `Tool.Context` (built in `prompt.ts:684`,
the `context()` helper inside `resolveTools()`) does not currently include
`languageModel`. It would need to be added there. The `model` parameter is
available in `resolveTools()` scope (`input.model`, which is a
`Provider.Model`), and `Provider.getLanguage(model)` (`provider/provider.ts:1110`)
returns the `LanguageModelV2` instance. This is an async call, so it should be
resolved once in `resolveTools()` and threaded through. For the same reasons
as Change 4 (`messages`), `languageModel` should be explicitly mapped onto
`pluginCtx` in `fromPlugin()` rather than relying on the `...ctx` spread.

**Files changed**:

| File | Change |
|------|--------|
| `packages/plugin/src/tool.ts` | Add `languageModel: LanguageModelV2` to `ToolContext` type |
| `packages/opencode/src/tool/tool.ts` | Add `languageModel: LanguageModelV2` to internal `Tool.Context` type |
| `packages/opencode/src/session/prompt.ts` | Resolve `languageModel` in `resolveTools()`, add to `context()` helper |
| `packages/opencode/src/tool/registry.ts` | Add explicit `languageModel: ctx.languageModel` to `pluginCtx` |

**Estimated scope**: ~10 lines across 4 files.

**Why the plugin needs this**: The prune tool calls the LLM to generate
summaries. The `LanguageModelV2` instance from `Provider.getLanguage()` has all
provider configuration already applied (base URLs, auth tokens, headers,
middleware). The plugin calls the AI SDK directly:

```typescript
import { generateText } from "ai"
const { text } = await generateText({
  model: ctx.languageModel,
  system: summarizationPrompt,
  messages: rangeToBeSummarized,
})
```

This is side-effect-free — no session messages created, no conversation loop
triggered, no events emitted.

**Why this is general-purpose**: Any plugin tool that needs side-effect-free LLM
calls benefits from this. Examples: summarization, classification, content
extraction, automated labeling.

### Change 3: Add `updateMessage()` to Plugin ToolContext

**What**: Expose an atomic message update function on the plugin `ToolContext`.

**Type definition** (in `packages/plugin/src/tool.ts`):

```typescript
export type ToolContext = {
  // ... existing fields ...
  updateMessage(id: string, fn: (draft: MessageInfo) => void): Promise<void>
}
```

**Implementation site**: `registry.ts:fromPlugin()` (line 60). The function
constructs the plugin context by spreading `...ctx`. Since `updateMessage` is
not on the internal `Tool.Context`, it must be added explicitly. The
implementation delegates to `Storage.update()`:

```typescript
const pluginCtx = {
  ...ctx,
  directory: Instance.directory,
  worktree: Instance.worktree,
  messages: ctx.messages,          // Change 4: explicit mapping
  languageModel: ctx.languageModel, // Change 2: explicit mapping
  pluginID: pluginName,            // Change 5: from plugin loading pipeline
  updateMessage: async (id: string, fn: (draft: any) => void) => {
    const updated = await Storage.update(["message", ctx.sessionID, id], (draft) => {
      const before = { id: draft.id, sessionID: draft.sessionID, role: draft.role }
      fn(draft)
      if (draft.id !== before.id || draft.sessionID !== before.sessionID || draft.role !== before.role)
        throw new Error("plugin mutated identity fields")
      MessageV2.Info.parse(draft) // required-field type check before write
    })
    // Note: this event may reach the plugin's own `event` hook handler.
    // The plugin must guard against re-entrant processing (e.g., ignore
    // events for messages it just wrote).
    Bus.publish(MessageV2.Event.Updated, { info: updated })
  },
} as unknown as PluginToolContext
```

This uses `Storage.update()` (`storage/storage.ts:179`) — atomic
read-modify-write with a write lock. The callback wraps the plugin's `fn(draft)`
with identity guards and `MessageV2.Info` Zod schema validation. If either
check fails, `Storage.update()` throws before writing — the file on disk is
unchanged. Note that Zod's `.parse()` catches missing or wrong-typed required
fields (e.g., deleting `time` or setting `role` to a number) but does not strip
extra fields from the draft — it returns a new object while the original draft is
what gets written. This means the guard is a **required-field type check**, not a
full sanitizer. Extra fields (like `metadata` entries) pass through, which is the
desired behavior for plugin data.

This is preferred over `Session.updateMessage()` (`session/index.ts:378`) for two
reasons: (1) `Storage.update()` reads the current state from disk before applying
the mutation, avoiding stale writes if multiple operations target the same
message, and (2) `Session.updateMessage()` is wrapped by `fn(MessageV2.Info, ...)`
(`util/fn.ts:5`) which calls `schema.parse(input)` and passes the *parsed* result
to the callback — meaning Zod's default stripping of unknown keys would drop any
fields not yet in the schema.

**Files changed**:

| File | Change |
|------|--------|
| `packages/plugin/src/tool.ts` | Add `updateMessage` to `ToolContext` type |
| `packages/opencode/src/tool/registry.ts` | Implement `updateMessage` in `fromPlugin()` |

**Estimated scope**: ~15 lines across 2 files.

**Safety guards**: Since `Storage.update()` (`storage/storage.ts:179`) writes raw
JSON, the `updateMessage` wrapper must validate after the callback runs:

1. **Identity-field immutability**: Capture `id`, `sessionID`, and `role` before
   calling `fn(draft)` and throw if any differ afterward.
2. **Required-field type check**: Parse the draft through `MessageV2.Info` (Zod
   discriminated union) after the callback. This catches missing or wrong-typed
   required fields (e.g., a plugin deleting `time` or setting `role` to a
   number). It does not strip extra fields — that's intentional, since plugin
   metadata is stored as extra data within the `metadata` bag.

### Change 4: Formalize `messages` on Plugin ToolContext

As described in "Upstream State" above, plugin tools already receive the
`messages` array at runtime through the unsafe cast in `fromPlugin()`. The
plugin's entire read path depends on this — both the prune and retrieve tools
read from `ctx.messages`, and the transform hook checks messages for archive
metadata. Relying on an undocumented leak for a core capability is fragile; if
upstream ever changes the internal `Tool.Context` shape, the plugin breaks
silently.

**Type definition** (in `packages/plugin/src/tool.ts`):

```typescript
export type ToolContext = {
  // ... existing fields ...
  messages: Array<{ info: MessageInfo; parts: Part[] }>
}
```

**Estimated scope**: 1 line of implementation plus the type definition. The field
currently leaks through the `...ctx` spread and `as unknown as PluginToolContext`
cast in `registry.ts:fromPlugin()` (line 67-71), but relying on a cast for
runtime behavior is fragile — if upstream ever renames or removes `messages` from
the internal `Tool.Context`, the plugin breaks silently. The implementation must
explicitly map `messages` onto `pluginCtx`, the same way `directory` and
`worktree` are already explicit:

```typescript
const pluginCtx = {
  ...ctx,
  directory: Instance.directory,
  worktree: Instance.worktree,
  messages: ctx.messages,  // <-- explicit, not relying on spread
  // ... updateMessage (from Change 3) ...
} as unknown as PluginToolContext
```

This makes the runtime contract explicit. If the internal `Tool.Context` shape
changes, the explicit mapping produces a compile-time error rather than a silent
runtime break.

**Files changed**:

| File | Change |
|------|--------|
| `packages/plugin/src/tool.ts` | Add `messages` to `ToolContext` type |
| `packages/opencode/src/tool/registry.ts` | Add explicit `messages: ctx.messages` to `pluginCtx` |

### Change 5: Add `pluginID` to Plugin ToolContext

**What**: Expose the plugin's package name on the tool context so plugins can
namespace metadata without hardcoding strings.

**Type definition** (in `packages/plugin/src/tool.ts`):

```typescript
export type ToolContext = {
  // ... existing fields ...
  pluginID: string
}
```

**Implementation**: `Plugin.list()` (`plugin/index.ts:118`) currently returns
`Hooks[]` with no source identity. Changing its return type would break 5
existing call sites that expect `Hooks[]` (`registry.ts:50`,
`provider.ts:861`, `auth.ts:13`, `cli/cmd/auth.ts:310`, `cli/cmd/auth.ts:326`). Instead, add a new `Plugin.listDetailed()`
API that returns `Array<{ name: string; hooks: Hooks }>`, associating each
`Hooks` entry with its source plugin name — the npm package name for installed
plugins (`pkg` at `plugin/index.ts:60`), or the filename namespace for custom
tools (`registry.ts:43`). Only `registry.ts:50` (tool registration) switches to
`listDetailed()`; all other call sites continue using `list()` unchanged. The
name is threaded to `fromPlugin()` and set explicitly on `pluginCtx`.

**Why this is general-purpose**: Any plugin that uses the `metadata` bag benefits
from a framework-provided identity rather than hardcoded strings. It also
enables future upstream tooling — e.g., a debug view that shows which plugin
owns which metadata keys, or enforced namespacing that rejects writes outside a
plugin's own key.

**Without this change**: The plugin hardcodes its own name (e.g.,
`metadata["context-bonsai"]`) instead of using `ctx.pluginID`. This works but
is fragile — if the package is renamed, all hardcoded strings must be updated
manually.

**Estimated scope**: ~15 lines across 3 files (`plugin/src/tool.ts`,
`plugin/index.ts`, `tool/registry.ts`). The new `listDetailed()` API wraps the
existing loading pipeline with name tracking. `Plugin.list()` remains unchanged,
avoiding regressions in auth/provider flows.

---

## Recommended Upstream Change

Change 6 improves developer ergonomics but is not a hard blocker. The plugin
functions without it, using the workaround described below.

### Change 6: Enrich Transform Hook Input

**What**: Change `prompt.ts:620` from:
```typescript
await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
```
to:
```typescript
await Plugin.trigger("experimental.chat.messages.transform", { sessionID, model }, { messages: sessionMessages })
```

**Why this is needed**: The transform hook currently receives `{}` as its input —
no session or model context. Any plugin that needs session-specific or
model-specific logic in the transform hook (gauge injection, provider-aware
rendering, budget calculations) must maintain side caches populated from other
hooks:

- Cache model/limits from `chat.params`
- Cache token usage from `event` (`message.updated`)
- Key all cached data by session ID (derived from other hooks)

This creates fragile ordering dependencies (transform depends on other hooks
having fired first), silent degradation when cache misses occur (e.g., after
process restart or if an event is dropped), and multi-session bookkeeping
complexity that every plugin must implement independently.

Passing `{ sessionID, model }` directly to the transform hook eliminates these
caches for session identity and model limits. Token usage caching from `event`
hooks is still required (no hook provides current-turn token counts yet), but
the most error-prone caches — session identity and model context — become
unnecessary.

**Without this change**: The Context Bonsai plugin still works, but must maintain
per-session caches for `sessionID` and `model.limit.context` populated from
`chat.params` and correlated by session. Other plugins doing message
transformation face the same burden. The plugin's Feature 4 (Context Gauges)
describes this workaround.

**Estimated scope**: 2 lines across 2 files. The runtime change is 1 line at
`prompt.ts:620` (the `sessionID` and `model` variables are already in scope).
The type change is 1 line in `plugin/src/index.ts:198` — updating the hook's
`input` type from `{}` to `{ sessionID: string; model: Model }` so plugin
authors get a typed contract. Backward compatible — existing plugins that ignore
the input are unaffected.

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────┐
│                    OpenCode Core                         │
│                                                          │
│  prompt.ts loop:                                         │
│    1. Load messages from storage                         │
│    2. insertReminders()                                  │
│    3. Clone messages                                     │
│    4. System-reminder wrapping                           │
│    5. ── Plugin: messages.transform ──────────────────── │
│    │     • Check messages for archive metadata            │
│    │     • Replace anchor msgs with placeholders          │
│    │     • Remove followers by position (anchor→rangeEnd)│
│    │     • Prefix IDs if visibility flag set              │
│    │     • Inject context gauge on last user msg          │
│    6. toModelMessages()                                  │
│    7. streamText() → LLM                                 │
│                                                          │
│  resolveTools():                                         │
│    ── Plugin: tool hook ──────────────────────────────── │
│    │   • prune tool (two-phase)                          │
│    │     - reads ctx.messages                            │
│    │     - calls ctx.languageModel for summarization     │
│    │     - writes anchor metadata via ctx.updateMessage    │
│    │   • retrieve tool                                   │
│    │     - reads ctx.messages (checks archive metadata)   │
│    │     - clears metadata via ctx.updateMessage()        │
│    │     - returns short status (content restored by hook)│
│                                                          │
│  system prompt:                                          │
│    ── Plugin: system.transform ──────────────────────── │
│    │   • Inject prune/retrieve guidance                  │
│    │   • Explain context gauges                          │
│                                                          │
│  event bus:                                              │
│    ── Plugin: event hook ────────────────────────────── │
│    │   • Track token counts from message.updated         │
│                                                          │
│  chat params:                                            │
│    ── Plugin: chat.params hook ──────────────────────── │
│    │   • Cache model.limit.context for gauge %           │
└─────────────────────────────────────────────────────────┘

Archive metadata lives on anchor messages only:
  msg.metadata[pluginID] = { archive: { summary, indexTerms, rangeEnd } }
  Followers carry no metadata — identified by position between anchor and rangeEnd
```

---

## Lifecycle and Ordering Concerns

### Process Restart

The plugin holds ephemeral state in module-level variables: cached token counts,
cached model limits, ID-visibility flags, and turn counters. All of this is lost
when the OpenCode process restarts. State reconstruction on restart:

- **Token counts**: Re-derived from the first `message.updated` event on the next
  LLM response. Until then, the gauge has no data and is simply not injected.
- **Model limits**: Re-cached on the next `chat.params` hook invocation (fires
  every turn before the LLM call).
- **ID-visibility flag**: Defaults to `false` (safe default). If the process
  restarts between phase 1 and phase 2 of a prune, the user would need to
  re-trigger phase 1.
- **Turn counter for gauge cadence**: Resets to 0 (acceptable — means the gauge
  fires sooner after restart, which is harmless).

Archive metadata is stored directly on messages in OpenCode's storage and is NOT
affected by restarts — all pruned data is preserved.

### Transform Hook / Tool Execution Ordering

The transform hook and the prune/retrieve tools operate on different data views:

1. The **transform hook** fires at `prompt.ts:620` and modifies the ephemeral
   clone (`sessionMessages`) used to build the LLM payload.
2. The **prune/retrieve tools** execute during a turn and read from `ctx.messages`
   which is the pre-clone, pre-transform original populated at `prompt.ts:691`.

These never conflict: the transform hook produces the view the LLM sees, while the
tools access the underlying data. A prune executed on turn N writes archive
metadata to the messages via `ctx.updateMessage()`; the transform hook on turn
N+1 sees the metadata on the freshly-loaded messages and renders them as
placeholders. There is no race.

**Within-step tool snapshot (defined behavior)**: Messages are loaded from
storage once per step iteration (`prompt.ts:285`) and assigned to the tool
context at `prompt.ts:691`. All tool calls in the same step share this snapshot.
This is **by design, not a bug** — it means tool calls within a single LLM
response operate on a consistent view of the conversation.

The consequence: if the LLM calls `context-bonsai:prune` and then
`context-bonsai:retrieve` in the same response, the retrieve sees `ctx.messages`
without the prune's metadata changes. The plugin enforces deterministic behavior
with a **same-step guard** (see Feature 2):

- The plugin tracks which anchors were pruned in the current step
- `context-bonsai:retrieve` checks this set before proceeding
- If the anchor was pruned in the current step, retrieve returns a deterministic
  error: "This archive was created in the current step. Call
  context-bonsai:retrieve on the next turn."
- The LLM retries on the next turn, when messages are reloaded from storage and
  the prune metadata is visible

This eliminates ambiguous behavior — every same-step prune/retrieve sequence
produces a clear, actionable error rather than silent inconsistency.

**Reminder injection visibility**: `insertReminders()` (`prompt.ts:540`) modifies
`msgs` *before* the clone at line 599. Since `ctx.messages` references `msgs`,
tool calls see messages with injected reminders (plan-mode, build-switch, etc.).
The prune tool's summarization prompt should account for this — reminder text
mixed into messages could pollute summaries if not filtered.

### Concurrent Sessions

Plugin ephemeral state is keyed by session ID (one state map per session).
Archive metadata lives on the messages themselves (already scoped to a session by
OpenCode's storage layout). Concurrent sessions in the same process operate on
independent state with no cross-contamination.

---

## Risks and Considerations

1. **Experimental hooks**: Both `experimental.chat.messages.transform` and
   `experimental.chat.system.transform` carry the `experimental` prefix. They
   could change or be removed in a future upstream release. The plugin should pin
   to a known-good OpenCode version and track upstream changes.

2. **Transform hook clone depth**: The plugin mutates `sessionMessages` in the
   transform hook. This is a clone of the original messages, but the clone depth
   must be verified during implementation. If it's shallow, mutating parts arrays
   could corrupt the original data. The plugin should defensively copy any arrays
   it modifies.

3. **Transform hook input enrichment dependency**: Change 6 (recommended, not
   required) enriches the transform hook input from `{}` to `{ sessionID, model }`.
   Without it, the plugin caches session/model info from other hooks (see
   Change 6 "Without this change" section). This adds complexity and fragility
   but the plugin functions correctly with the workaround.

4. **Plugin state reliability**: The plugin holds ephemeral state in module-level
   variables (token counts, model limits, ID-visibility flags per session).
   Plugins are loaded once at startup and persist for the process lifetime, so
   this is reliable. But if OpenCode ever supports plugin hot-reloading, ephemeral
   state would be lost. Archive metadata is durable (stored directly on messages)
   and unaffected by hot-reloading.

5. **Interaction with built-in compaction**: If the plugin doesn't prune
   aggressively enough, OpenCode's built-in overflow compaction
   (`compaction.ts:isOverflow`) will still trigger. This is expected and
   desirable — built-in compaction is the hard safety net, and the plugin's
   pruning reduces token counts so the built-in threshold is less likely to fire.
   When built-in compaction does fire, it destructively summarizes messages and
   the original content is **no longer retrievable** — this matches user
   expectations for built-in compaction and is not something the plugin should
   try to prevent or work around. If the compacted range includes plugin-pruned
   messages, the compaction LLM sees the **original** message content (not the
   plugin's placeholders), because compaction reads from the original `msgs`
   array (`prompt.ts:510-516`) rather than the transform hook's ephemeral clone.
   This means compaction may redundantly summarize content the plugin already
   summarized, which is harmless.

6. **Unsafe cast in `fromPlugin()`**: Plugin tools already receive internal
   fields (including `messages`, `callID`, `extra`) through the
   `as unknown as PluginToolContext` cast in `registry.ts:67-71`. This is an
   undocumented leak. If upstream ever changes the internal `Tool.Context` shape,
   plugins relying on leaked fields will break silently. Formalizing `messages`
   on the plugin ToolContext type (Change 4) eliminates this fragility.

---

## What's NOT In This Proposal

- Implementation-ready code or a complete plugin package
- TUI rendering for pruned messages (tool results render as text, which is
  sufficient)
- Share/export filtering for pruned content
- Configuration UI or user settings
- Performance benchmarks or token-savings estimates
