# Proposal: Context Bonsai as an OpenCode Plugin

## Summary

This proposal describes how to implement surgical context compaction ("Context
Bonsai") as a standalone OpenCode plugin distributed as an npm package. The
plugin gives the LLM the ability to selectively prune stale or problematic
context while preserving summaries, and to retrieve the original content if
needed later. The goal is to avoid catastrophic batch compaction by staying ahead
of the context limit through continuous, targeted pruning.

**The plugin requires one upstream change to OpenCode**: exposing a
`languageModel` field on the plugin `ToolContext`. All other functionality maps
onto existing upstream plugin hooks, including message access that already leaks
through to plugins via the internal context.

---

## What the Plugin Does

When installed, the plugin:

1. **Registers two tools** (prune and retrieve) that the LLM can call
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

**Phase 1 — Enable message ID visibility.** The LLM calls `prune` with no
arguments. The plugin sets an internal flag. On the next turn, the message
transform hook (see Feature 3) prefixes every message with its ID so the LLM can
see and reference them. The tool returns a message like "[Message IDs are now
visible. Identify the range to prune and call prune again with from_id and
to_id.]"

**Phase 2 — Archive the range.** The LLM calls `prune` with `from_id`,
`to_id`, and a `reason`. The plugin:
1. Reads the messages in the range from `ctx.messages` (the full conversation
   array already available on the tool context — see "Upstream State" below)
2. Calls `generateText()` using `ctx.languageModel` with a summarization prompt
   to produce a summary + index terms
3. Writes archive metadata to the plugin's sidecar storage file (see "Archive
   Storage" below)
4. Clears the ID-visibility flag
5. Returns a notification to the user describing what was pruned and the summary

**Failure handling**: If the summarization LLM call fails (rate limit, network
error, provider outage), the prune operation aborts entirely. No archive
metadata is written. The tool returns an error message to the LLM. Since archive
metadata is written atomically in a single step after summarization succeeds,
there is no partial-write corruption risk.

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

**Upstream change required**: `languageModel` on ToolContext. See "Required
Upstream Change" below.

### Feature 2: Retrieve Tool

The LLM calls this tool to restore previously pruned content. The plugin:
1. Reads the archive metadata from the plugin's sidecar storage
2. Finds the original messages from `ctx.messages` (the messages are still in
   storage — they're just rendered as placeholders by the transform hook)
3. Returns the original content as the tool result, appended to the current
   context (preserving LLM cache)

The archived messages remain marked in sidecar storage — retrieval doesn't undo
the pruning. But the LLM now has access to the original content for the
remainder of the session.

**Upstream hook used**: `tool` (existing)

**Upstream change required**: None beyond what Feature 1 requires. The retrieve
tool only needs read access to messages (`ctx.messages`) and the sidecar file.

### Feature 3: Archived Message Rendering + Message ID Prefixing

This is the core mechanism that makes pruning effective. On every turn, before
the conversation is sent to the LLM, the plugin intercepts the message list and:

1. **Replaces archived messages with placeholders.** For each message whose ID
   appears in the plugin's sidecar archive index, the plugin replaces its parts
   with a single text part:
   ```
   [PRUNED: msg_abc to msg_xyz]
   Summary: <the generated summary>
   Index: <comma-separated index terms>
   ```
2. **Removes follower messages.** Messages within an archived range (between
   the anchor and range-end IDs) are removed from the array entirely.
3. **Prefixes message IDs** when the ID-visibility flag is set (phase 1 of the
   prune flow), so the LLM can reference messages by ID.

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

**Cadence**: The gauge is injected once every N turns (e.g., every 3 turns), or
whenever the cached token utilization exceeds a threshold (e.g., 50% of context
limit). The exact cadence is a tuning parameter internal to the plugin. The
plugin tracks turn count per session via its internal state.

The gauge is injected as a `<system-reminder>`-tagged synthetic text part on the
last user message, following the same pattern OpenCode already uses for plan-mode
and build-switch reminders (`prompt.ts:1234`, `insertReminders()`):

```
<system-reminder>
[CONTEXT GAUGE: 67,000 / 100,000 tokens (67%)]
When context utilization exceeds 60%, look for opportunities to prune stale
content using the prune tool.
</system-reminder>
```

**How the plugin gets token data**:
- **Token counts**: The `event` hook subscribes to `message.updated` events.
  Assistant messages include `tokens.input`, `tokens.output`, and cache counts.
  The plugin caches the latest values per session.
- **Model context limit**: The `chat.params` hook receives `model: Model` which
  includes `limit.context` and `limit.input`. The plugin caches this per session.

**Upstream hook used**: `experimental.chat.messages.transform` (existing) for
injecting the gauge text into the message array. `event` (existing) and
`chat.params` (existing) for data collection.

**No upstream change required.** The hook input is `{}` (no session/model info),
but the plugin works around this by caching data from other hooks.

**Nice-to-have upstream improvement**: Enrich the transform hook input from `{}`
to `{ sessionID, model }`. This would eliminate the need for the plugin to
maintain cached state, making the gauge logic simpler and less fragile. This is a
one-line change at `prompt.ts:620`.

**Token budget note**: The gauge text and system prompt guidance (Feature 5)
consume tokens from the context window. The gauge is ~30 tokens; the system
prompt guidance is a fixed ~200 tokens. These are small relative to a typical
128K+ context window. The plugin's gauge calculation should account for its own
injected tokens to avoid slightly over-reporting available space.

**Gauge staleness**: Token counts come from `message.updated` events on the
*previous* turn's assistant message. The gauge is always one turn behind. After a
prune operation, the gauge will still show the pre-prune token count until the
next LLM response fires a new `message.updated` event. This is acceptable — the
LLM already sees the pruned message placeholders in its context, so it can infer
that utilization has decreased even if the gauge hasn't updated yet.

### Feature 5: System Prompt Guidance

The plugin injects instructions into the system prompt that tell the LLM about
the prune/retrieve tools, how to interpret context gauges, and when to consider
pruning.

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

**Implication**: The plugin can read the full conversation without any upstream
change. Formalizing `messages` on the plugin `ToolContext` type is a type-only
change with zero implementation work.

---

## Archive Storage: Sidecar Approach

The plugin maintains its own JSON file for archive metadata rather than writing
to OpenCode's message storage. This eliminates the metadata clobber risk
entirely.

**Storage location**: A JSON file per session in the plugin's data directory
(e.g., `~/.config/opencode/plugin-data/context-bonsai/<sessionID>.json`).

**Schema**:
```json
{
  "archives": {
    "msg_abc": {
      "summary": "Debugging attempts - tried token refresh, session storage...",
      "indexTerms": ["auth", "debugging", "middleware"],
      "rangeEnd": "msg_xyz"
    }
  }
}
```

**How it's used**:
- The **prune tool** writes to this file after successful summarization
- The **retrieve tool** reads from this file
- The **transform hook** reads from this file every turn to identify which
  messages to replace with placeholders

**Advantages over writing to message JSON**:
- No risk of OpenCode's `Session.updateMessage()` (`session/index.ts:378`,
  which uses `Storage.write()` — a blind overwrite) clobbering plugin fields
- No dependency on `Storage.update()` being exposed to plugins
- The plugin fully owns its data lifecycle
- Reduces the upstream change footprint (no `updateMessage` needed)

**Trade-off**: One extra file read per turn in the transform hook. Since the
sidecar is small JSON and local disk, this is negligible.

---

## Required Upstream Change

### Add `languageModel` to Plugin ToolContext

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

**Implementation site**: `packages/opencode/src/tool/registry.ts`,
`fromPlugin()` function (line 60). This function constructs the plugin tool
context by spreading the internal `Tool.Context`. The `languageModel` needs to
be added to this spread.

The internal `Tool.Context` (built in `prompt.ts:684`, the `context()` helper
inside `resolveTools()`) does not currently include `languageModel`. It would
need to be added there. The `model` parameter is available in `resolveTools()`
scope (`input.model`, which is a `Provider.Model`), and
`Provider.getLanguage(model)` (`provider/provider.ts:1110`) returns the
`LanguageModelV2` instance. This is an async call, so it should be resolved once
in `resolveTools()` and threaded through.

**Files changed**:

| File | Change |
|------|--------|
| `packages/plugin/src/tool.ts` | Add `languageModel: LanguageModelV2` to `ToolContext` type |
| `packages/opencode/src/tool/tool.ts` | Add `languageModel: LanguageModelV2` to internal `Tool.Context` type |
| `packages/opencode/src/session/prompt.ts` | Resolve `languageModel` in `resolveTools()`, add to `context()` helper |
| `packages/opencode/src/tool/registry.ts` | Already passes through via `...ctx` spread — no change needed |

**Estimated scope**: ~10 lines across 3 files.

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

### Optional: Formalize `messages` on Plugin ToolContext

As described in "Upstream State" above, plugin tools already receive the
`messages` array at runtime through the unsafe cast in `fromPlugin()`. Making
this official is a type-only change:

```typescript
export type ToolContext = {
  // ... existing fields ...
  messages: Array<{ info: MessageInfo; parts: Part[] }>
}
```

This is zero implementation work — the field is already present on the runtime
object. It would make the plugin API honest about what's available and reduce the
need for `(ctx as any).messages` hacks.

### Optional: Enrich Transform Hook Input

Change `prompt.ts:620` from:
```typescript
await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: sessionMessages })
```
to:
```typescript
await Plugin.trigger("experimental.chat.messages.transform", { sessionID, model }, { messages: sessionMessages })
```

This gives the transform hook session and model context, eliminating the need for
plugins to cache this data from other hooks.

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
│    │     • Read sidecar archive index                    │
│    │     • Replace archived msgs with placeholders       │
│    │     • Remove range-follower messages                │
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
│    │     - writes to sidecar archive file                │
│    │   • retrieve tool                                   │
│    │     - reads ctx.messages + sidecar file              │
│    │     - returns original content as tool result        │
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

Sidecar storage (plugin-owned):
  ~/.config/opencode/plugin-data/context-bonsai/<sessionID>.json
  Contains: archive metadata (summaries, index terms, ranges)
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

The durable sidecar archive file is NOT affected by restarts — all pruned data is
preserved.

### Transform Hook / Tool Execution Ordering

The transform hook and the prune/retrieve tools operate on different data views:

1. The **transform hook** fires at `prompt.ts:620` and modifies the ephemeral
   clone (`sessionMessages`) used to build the LLM payload.
2. The **prune/retrieve tools** execute during a turn and read from `ctx.messages`
   which is the pre-clone, pre-transform original populated at `prompt.ts:691`.

These never conflict: the transform hook produces the view the LLM sees, while the
tools access the underlying data. A prune executed on turn N writes to the sidecar
file; the transform hook on turn N+1 reads the updated sidecar file and renders
the newly-pruned messages as placeholders. There is no race.

### Concurrent Sessions

Plugin state is keyed by session ID (one state map per session). Sidecar files
are per-session (`<sessionID>.json`). Concurrent sessions in the same process
operate on independent state and independent files with no cross-contamination.

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

3. **Transform hook input is empty**: The `experimental.chat.messages.transform`
   input is `{}`, so the plugin must cache session/model info from other hooks.
   This adds complexity but is not a blocker. The optional upstream improvement
   (adding `{ sessionID, model }` to the input) would simplify this.

4. **Plugin state reliability**: The plugin holds state in module-level variables
   (token counts, model limits, ID-visibility flags per session). Plugins are
   loaded once at startup and persist for the process lifetime, so this is
   reliable. But if OpenCode ever supports plugin hot-reloading, state would be
   lost. The sidecar file provides durability for archive metadata.

5. **Interaction with built-in compaction**: If the plugin doesn't prune
   aggressively enough, OpenCode's built-in overflow compaction
   (`compaction.ts:isOverflow`) will still trigger. This is desirable — the
   built-in compaction acts as a safety net, not a conflict. The plugin's pruning
   reduces token counts, so the built-in threshold is less likely to fire.
   However, if built-in compaction fires and summarizes a range that includes
   plugin-pruned messages, the compaction LLM sees the **original** message
   content (not the plugin's placeholders), because compaction reads from the
   original `msgs` array (`prompt.ts:510-516`) rather than the transform hook's
   ephemeral clone. This means compaction may redundantly summarize content the
   plugin already summarized. This is acceptable — redundant summarization is
   harmless, and the plugin's sidecar metadata remains valid regardless.

6. **Sidecar file lifecycle**: The sidecar archive file must be cleaned up when
   sessions are deleted. The plugin can subscribe to session deletion events via
   the `event` hook and remove the corresponding sidecar file.

7. **Unsafe cast in `fromPlugin()`**: Plugin tools already receive internal
   fields (including `messages`, `callID`, `extra`) through the
   `as unknown as PluginToolContext` cast in `registry.ts:67-71`. This is an
   undocumented leak. If upstream ever changes the internal `Tool.Context` shape,
   plugins relying on leaked fields will break silently. Formalizing `messages`
   on the plugin ToolContext type (the optional upstream change) eliminates this
   fragility.

---

## What's NOT In This Proposal

- Implementation-ready code or a complete plugin package
- TUI rendering for pruned messages (tool results render as text, which is
  sufficient)
- Share/export filtering for pruned content
- Configuration UI or user settings
- Performance benchmarks or token-savings estimates
