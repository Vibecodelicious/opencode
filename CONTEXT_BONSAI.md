# Context Bonsai: Surgical Context Compaction for LLM Harnesses

## Overview

Context Bonsai is a feature that gives an LLM the ability to **selectively prune
stale or low-value messages** from its own context window while preserving
summaries, and to **retrieve the original content** later within the same
session. Pruned content remains retrievable until the harness's built-in overflow
compaction fires, at which point originals are destructively summarized and no
longer recoverable.

The goal is to stay ahead of the context limit through continuous, targeted
pruning — so the harness's blunt overflow compaction rarely triggers.

---

## Core Concepts

### Pruning vs. Compaction

| Term | Meaning |
|------|---------|
| **Pruning** (this feature) | Selective, LLM-initiated archiving of a message range. Original content is preserved and retrievable. The LLM decides what to prune and when. |
| **Compaction** (built-in) | Harness-level overflow protection. Destructively summarizes messages when the context window is nearly full. Originals are lost. |

Pruning reduces context pressure so compaction fires less often. When compaction
does fire, it acts as a hard safety net — this is expected, not a failure.

### Archive Anatomy

A pruned range consists of:

- **Anchor message**: The first message in the range. Carries all archive
  metadata (summary, index terms, range boundary).
- **Follower messages**: All messages between the anchor and the range end.
  Carry no metadata — membership is determined by position relative to the
  anchor.
- **Range end**: The ID of the last message in the range, stored on the anchor.

This single-write design ensures atomicity: either the anchor write completes
(full prune) or it doesn't (no prune). No partial state on crash.

### Two-Phase Prune Flow

Pruning operates in two phases because the LLM cannot see message IDs by
default:

1. **Phase 1 — Enable ID visibility.** The LLM calls the prune tool with no
   arguments. The system sets a flag that causes message IDs to be prefixed onto
   each message on the next turn. The tool returns instructions to identify the
   range and call again.

2. **Phase 2 — Archive the range.** The LLM calls the prune tool with
   `from_id`, `to_id`, and a `reason`. The system generates a summary via LLM,
   writes archive metadata onto the anchor message, clears the visibility flag,
   and returns a notification of what was pruned.

### Retrieval

The LLM calls the retrieve tool with an `anchor_id`. The system clears the
archive metadata on the anchor, restoring the entire range. The original message
content was never deleted — only replaced with placeholders in the ephemeral view
sent to the LLM. After metadata is cleared, the messages reappear naturally on
the next turn.

---

## Features

### Feature 1: Prune Tool

A tool the LLM can call to archive a range of messages.

**Parameters** (all optional — phase is determined by presence):

| Parameter | Type | Description |
|-----------|------|-------------|
| `from_id` | string | First message ID in the range (required for phase 2) |
| `to_id` | string | Last message ID in the range (required for phase 2) |
| `reason` | string | Why this content is being archived (required for phase 2) |

**Phase 1 behavior** (no arguments):
- Set the ID-visibility flag for the current session
- Return: "Message IDs are now visible. Identify the range to prune and call
  again with from_id and to_id."

**Phase 2 behavior** (with arguments):
1. **Validate** — both IDs exist, `from_id` precedes `to_id`, neither falls
   within an existing pruned range, range contains at least one message
2. **Summarize** — call an LLM with the message content to produce a concise
   summary and semantic index terms
3. **Write metadata** — store archive data on the anchor message (atomic
   single-message write):
   ```
   {
     summary: "...",
     indexTerms: ["auth", "debugging", "middleware"],
     rangeEnd: "<to_id>"
   }
   ```
4. **Clear** the ID-visibility flag
5. **Return** a human-readable notification of what was pruned

**Failure handling**: If the summarization LLM call fails, the prune aborts
entirely. No metadata is written. The tool returns an error.

### Feature 2: Retrieve Tool

A tool the LLM can call to restore previously pruned content.

**Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `anchor_id` | string | The ID of the anchor message to restore (required) |

**Behavior**:
1. Validate that `anchor_id` exists and has archive metadata
2. Clear the archive metadata on the anchor (single atomic write)
3. Return a short status message (e.g., "Restored 5 messages from msg_abc to
   msg_xyz")

The actual content restoration happens through the message rendering pipeline
(Feature 3) on the next turn — the tool result is intentionally short.

**Same-step guard**: If the LLM prunes and then retrieves the same range within
a single response, the retrieve must detect this and return an error: "This
archive was created in the current step. Call retrieve on the next turn." The
system tracks which anchors were pruned in the current step.

### Feature 3: Archived Message Rendering

Before the conversation is sent to the LLM each turn, the system transforms the
message list:

1. **Replace anchor messages with placeholders.** For each message with archive
   metadata, replace its content with:
   ```
   [PRUNED: msg_abc to msg_xyz]
   Summary: <the generated summary>
   Index: <comma-separated index terms>
   ```

2. **Remove follower messages.** Using the anchor's `rangeEnd`, identify all
   messages between the anchor and the range-end by position and remove them.

3. **Prefix message IDs** when the ID-visibility flag is set (phase 1 of the
   prune flow).

**Edge cases**:
- **`rangeEnd` missing** (e.g., message deleted or filtered out): Treat as a
  single-message archive — replace the anchor, remove no followers.
- **Multiple pruned ranges**: Collect all indices to remove first, then filter
  once — do not splice during iteration.

### Feature 4: Context Gauges

The system periodically injects token utilization information into the
conversation so the LLM sees context pressure and can decide when to prune.

**Format**:
```
[CONTEXT GAUGE: 67,000 / 100,000 tokens (67%)]
When utilization exceeds 60%, look for opportunities to prune stale content.
```

**Cadence**: Injected every N turns (tunable, e.g., every 3 turns), or whenever
token utilization exceeds a threshold (e.g., 50%). Exact values are
implementation-tunable.

**Data sources**:
- **Token counts**: Derived from the previous turn's LLM response metadata
  (input tokens, output tokens, cache counts). Always one turn behind — this is
  inherent to the event-driven approach, not a bug.
- **Context limit**: From the model's declared context window size.

**Staleness**: After a prune, the gauge still shows pre-prune counts until the
next LLM response. The LLM can infer reduced utilization from seeing the
placeholders.

### Feature 5: System Prompt Guidance

The system injects instructions into the LLM's system prompt explaining:
- What the prune and retrieve tools do
- How to interpret context gauges
- When to consider pruning (utilization thresholds, stale content patterns)
- The two-phase prune flow

### Feature 6: Notify Mode

When the LLM prunes content, the tool result includes a human-readable summary
of what was pruned. This is displayed to the user through the harness's normal
tool result rendering. Always on — no user configuration.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              LLM Harness Core Loop                    │
│                                                       │
│  Each turn:                                           │
│    1. Load messages from storage                      │
│    2. ── Transform pipeline ────────────────────────  │
│    │     • Find messages with archive metadata         │
│    │     • Replace anchors with summary placeholders   │
│    │     • Remove followers (anchor → rangeEnd)        │
│    │     • Prefix IDs if visibility flag is set         │
│    │     • Inject context gauge (if cadence met)        │
│    3. Convert to LLM message format                   │
│    4. Send to LLM                                     │
│    5. Process LLM response + tool calls               │
│                                                       │
│  Tool execution:                                      │
│    • prune tool                                       │
│      - Reads full conversation                        │
│      - Calls LLM for summarization                    │
│      - Writes anchor metadata (atomic)                │
│    • retrieve tool                                    │
│      - Reads conversation (checks archive metadata)   │
│      - Clears anchor metadata (atomic)                │
│      - Content restored by transform pipeline         │
│                                                       │
│  Data flow:                                           │
│    • Token counts ← previous turn's response metadata │
│    • Context limit ← model configuration              │
│    • Archive metadata ← message storage               │
└──────────────────────────────────────────────────────┘
```

---

## Archive Metadata Schema

Archive data is stored on the anchor message in a plugin/feature-namespaced
metadata bag:

```
message.metadata[NAMESPACE] = {
  archive: {
    summary: string,      // LLM-generated summary of the pruned range
    indexTerms: string[],  // Semantic terms for future retrieval decisions
    rangeEnd: string,      // ID of the last message in the pruned range
  }
}
```

Follower messages carry no metadata. Their membership in a pruned range is
determined solely by position between the anchor and `rangeEnd`.

---

## Harness Integration Requirements

To implement Context Bonsai, an LLM harness must provide the following
capabilities to the feature (whether as a plugin, extension, or built-in):

### Required Capabilities

| # | Capability | Why |
|---|-----------|-----|
| 1 | **Register custom tools** the LLM can call | Prune and retrieve tools |
| 2 | **Read the full conversation** from within a tool execution | Tools need to validate IDs, read message content for summarization |
| 3 | **Write metadata onto messages** (atomic, survives storage round-trips) | Archive data must persist across turns and process restarts |
| 4 | **Call an LLM** from within a tool execution (side-effect-free, no conversation impact) | Summarization during prune |
| 5 | **Transform messages before sending to the LLM** (per-turn hook or middleware) | Replace pruned messages with placeholders, inject gauges, prefix IDs |
| 6 | **Inject into the system prompt** | Guidance for the LLM on how to use prune/retrieve |
| 7 | **Access token usage from the previous turn** | Context gauge data |
| 8 | **Access the model's context window size** | Context gauge percentage calculation |

### Nice-to-Have Capabilities

| # | Capability | Workaround if absent |
|---|-----------|---------------------|
| 9 | **Session/model context passed to the transform pipeline** | Cache from other lifecycle events; adds complexity |
| 10 | **Feature-namespaced identity** (harness tells the feature its own namespace) | Hardcode the namespace string |

---

## Operational Invariants

### Atomicity

All prune/retrieve operations write to exactly one message (the anchor). A crash
during a write either completes the operation or leaves the previous state
intact. No partial archives.

### Ephemerality of Rendering

The transform pipeline operates on an ephemeral copy of the messages. Original
message content is never modified by rendering. Pruning only writes metadata —
the original text, tool calls, and tool results remain in storage unchanged.

### Same-Step Consistency

All tool calls within a single LLM response operate on a snapshot of the
conversation taken at the start of that response. A prune followed by a retrieve
in the same response will see stale data. The system must detect and reject
same-step retrieve-after-prune with a clear error.

### Gauge Lag

Token counts in the context gauge are always one turn behind. This is inherent
and acceptable. The LLM can observe the rendered placeholders to infer that
pruning reduced utilization even before the gauge updates.

### Interaction with Built-in Compaction

When the harness's built-in overflow compaction fires:
- It reads original message content, not the plugin's placeholders
- It may redundantly summarize content the plugin already summarized (harmless)
- After compaction, pruned originals are no longer retrievable
- This is expected behavior — compaction is the hard safety net

### Process Restart

Ephemeral state (token caches, visibility flags, turn counters) is lost on
restart. Archive metadata is durable (stored on messages). After restart:
- Gauges are not shown until the first LLM response provides token data
- ID visibility defaults to off (safe; user re-triggers if needed)
- All pruned ranges remain intact and render correctly

---

## What This Spec Does NOT Cover

- Implementation-ready code for any specific harness
- TUI/UI rendering of pruned messages beyond tool result text
- Share/export filtering for pruned content
- Configuration UI or user settings
- Performance benchmarks or token-savings estimates
- Gauge ramping (variable frequency based on utilization)
- User autonomy modes (ask/notify/silent) — always notify
