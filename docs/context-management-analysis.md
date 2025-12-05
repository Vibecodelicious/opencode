# Context Management Analysis 🎯

**Generated:** 2025-12-03
**Focus:** LLM context building, token management, and context window mitigation
**Primary Component:** `packages/opencode/src/session/`

---

## Executive Summary

OpenCode implements a sophisticated **multi-layered context management strategy** to handle LLM context windows efficiently:

1. **Token Estimation**: Simple 4-char-per-token heuristic
2. **Overflow Detection**: Monitors usable context capacity
3. **Pruning**: Removes old tool outputs while preserving recent ones
4. **Compaction**: LLM-generated conversation summaries
5. **Summarization**: Small-model-powered title and body summaries

---

## Architecture Overview

### Core Components

```
session/
├── compaction.ts      ← Context window overflow handler
├── summary.ts         ← Message/session summarization
├── prompt.ts          ← Prompt assembly & token limits
├── message-v2.ts      ← Message conversion to ModelMessage
└── processor.ts       ← Stream processing
util/
├── token.ts           ← Token estimation utilities
└── context.ts         ← Async context management (not LLM context)
```

---

## 1. Token Estimation

**File:** `src/util/token.ts`

### Implementation

```typescript
export namespace Token {
  const CHARS_PER_TOKEN = 4

  export function estimate(input: string) {
    return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
  }
}
```

### Strategy

- **Simple heuristic**: 4 characters ≈ 1 token
- **Fast**: No external tokenizer required
- **Approximate**: Good enough for capacity planning
- **Trade-off**: Not model-specific, but consistent

---

## 2. Overflow Detection

**File:** `src/session/compaction.ts:32-40`

### Overflow Check Logic

```typescript
export function isOverflow(input: {
  tokens: MessageV2.Assistant["tokens"];
  model: ModelsDev.Model
}) {
  if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) return false

  const context = input.model.limit.context
  if (context === 0) return false

  const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
  const output = Math.min(
    input.model.limit.output,
    SessionPrompt.OUTPUT_TOKEN_MAX
  ) || SessionPrompt.OUTPUT_TOKEN_MAX
  const usable = context - output

  return count > usable
}
```

### Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `OUTPUT_TOKEN_MAX` | 32,000 | Maximum tokens reserved for model output |
| Model context limit | Varies | Provider-specific context window |

### Calculation

```
Usable Context = Model Context Limit - Output Reservation
Overflow = (Input + Cache Read + Output) > Usable Context
```

### Features

- **Disable flag**: `OPENCODE_DISABLE_AUTOCOMPACT` env var
- **Zero-check**: Handles models without context limits
- **Output reservation**: Always reserves space for response
- **Cache-aware**: Includes prompt caching reads in calculation

---

## 3. Tool Output Pruning

**File:** `src/session/compaction.ts:42-86`

### Constants

```typescript
export const PRUNE_MINIMUM = 20_000   // Minimum tokens to trigger pruning
export const PRUNE_PROTECT = 40_000   // Keep this many tokens of recent tools
```

### Pruning Algorithm

```
BACKWARDS iteration through messages:
  ├─ Skip last 2 user turns (keep recent context)
  ├─ Stop if encountering a summary message
  ├─ For each tool call part:
  │   ├─ If status === "completed" && not already compacted
  │   ├─ Accumulate token estimate
  │   ├─ If total > PRUNE_PROTECT (40k tokens):
  │   │   └─ Mark for pruning
  │   └─ Break if already compacted
  └─ If pruned total > PRUNE_MINIMUM (20k tokens):
      └─ Mark all pruned parts with compaction timestamp
```

### Implementation Details

```typescript
export async function prune(input: { sessionID: string }) {
  if (Flag.OPENCODE_DISABLE_PRUNE) return

  const msgs = await Session.messages({ sessionID: input.sessionID })
  let total = 0
  let pruned = 0
  const toPrune = []
  let turns = 0

  // Go backwards through messages
  loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = msgs[msgIndex]
    if (msg.info.role === "user") turns++

    // Protect last 2 turns
    if (turns < 2) continue

    // Stop at summary messages
    if (msg.info.role === "assistant" && msg.info.summary) break loop

    // Process tool parts
    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type === "tool" && part.state.status === "completed") {
        if (part.state.time.compacted) break loop  // Already compacted

        const estimate = Token.estimate(part.state.output)
        total += estimate

        // Keep PRUNE_PROTECT tokens, prune rest
        if (total > PRUNE_PROTECT) {
          pruned += estimate
          toPrune.push(part)
        }
      }
    }
  }

  // Only prune if significant (>20k tokens)
  if (pruned > PRUNE_MINIMUM) {
    for (const part of toPrune) {
      part.state.time.compacted = Date.now()
      await Session.updatePart(part)
    }
  }
}
```

### Strategy

- **Recency bias**: Keeps last 40k tokens of tool results
- **Selective pruning**: Only removes old, irrelevant tool outputs
- **Threshold-based**: Only activates if saving >20k tokens
- **Metadata preservation**: Marks pruned parts with timestamp
- **Non-destructive**: Original data still in database, just flagged

---

## 4. Content Replacement in Messages

**File:** `src/session/message-v2.ts:621-648`

### Compaction Replacement Logic

```typescript
if (part.type === "tool") {
  if (part.state.status === "completed") {
    // ... handle attachments ...

    assistantMessage.parts.push({
      type: ("tool-" + part.tool) as `tool-${string}`,
      state: "output-available",
      toolCallId: part.callID,
      input: part.state.input,
      // 🎯 KEY LINE: Replace compacted content with placeholder
      output: part.state.time.compacted
        ? "[Old tool result content cleared]"
        : part.state.output,
      callProviderMetadata: part.metadata,
    })
  }
}
```

### Placeholder Strategy

| State | Output Value | Token Impact |
|-------|-------------|--------------|
| **Normal** | Full tool output | Original size |
| **Compacted** | `"[Old tool result content cleared]"` | ~8 tokens |

**Token Savings Example:**
- Original tool output: 5,000 tokens
- After compaction: 8 tokens
- **Savings: 4,992 tokens per tool call**

---

## 5. LLM-Powered Compaction

**File:** `src/session/compaction.ts:88-229`

### Compaction Process

When context overflows:

1. **Create summary message** with role "assistant" and `summary: true` flag
2. **Load system prompt** for compaction (provider-specific)
3. **Filter error messages** (keep only those with useful content)
4. **Send compaction prompt** to LLM:

```
System: [Compaction-specific system prompt]

[All previous messages in conversation]

User: "Summarize our conversation above. This summary will be the only
context available when the conversation continues, so preserve critical
information including: what was accomplished, current work in progress,
files involved, next steps, and any key user requests or constraints.
Be concise but detailed enough that work can continue seamlessly."
```

5. **Stream LLM response** as summary
6. **Optionally continue** with auto-generated "Continue if you have next steps" prompt

### System Prompt

```typescript
const system = [...SystemPrompt.compaction(model.providerID)]
```

Provider-specific system prompts loaded from `session/system.ts`

### Auto-Continue Feature

```typescript
if (result === "continue" && input.auto) {
  // Add synthetic user message: "Continue if you have next steps"
  // Keeps conversation flowing after compaction
}
```

---

## 6. Summarization System

**File:** `src/session/summary.ts`

### Two-Level Summarization

#### 6.1 Session-Level Summary

```typescript
async function summarizeSession(input: {
  sessionID: string;
  messages: MessageV2.WithParts[]
}) {
  // Extract files from patches
  const files = new Set(
    input.messages
      .flatMap((x) => x.parts)
      .filter((x) => x.type === "patch")
      .flatMap((x) => x.files)
      .map((x) => path.relative(Instance.worktree, x))
  )

  // Compute diffs between snapshots
  const diffs = await computeDiff({ messages: input.messages })
    .then((x) => x.filter((x) => files.has(x.file)))

  // Update session with summary stats
  await Session.update(input.sessionID, (draft) => {
    draft.summary = {
      additions: diffs.reduce((sum, x) => sum + x.additions, 0),
      deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
      files: diffs.length,
    }
  })

  // Store full diffs
  await Storage.write(["session_diff", input.sessionID], diffs)
}
```

**Output:** File change statistics (additions, deletions, file count)

#### 6.2 Message-Level Summary

```typescript
async function summarizeMessage(input: {
  messageID: string;
  messages: MessageV2.WithParts[]
}) {
  // Get small model for efficiency
  const small = await Provider.getSmallModel(assistantMsg.providerID)
    ?? await Provider.getModel(assistantMsg.providerID, assistantMsg.modelID)

  // Generate title (20 tokens max, or 1500 for reasoning models)
  if (textPart && !userMsg.summary?.title) {
    const result = await generateText({
      maxOutputTokens: small.info.reasoning ? 1500 : 20,
      model: small.language,
      messages: [
        ...SystemPrompt.title(small.providerID),
        {
          role: "user",
          content: `The following is the text to summarize:
            <text>${textPart?.text ?? ""}</text>`
        }
      ],
    })
    userMsg.summary.title = result.text
  }

  // Generate body summary (100 tokens max)
  // First, prune tool outputs
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.state.status === "completed") {
        part.state.output = "[TOOL OUTPUT PRUNED]"
      }
    }
  }

  const result = await generateText({
    model: small.language,
    maxOutputTokens: 100,
    messages: [
      ...SystemPrompt.summarize(small.providerID),
      ...MessageV2.toModelMessage(messages),
      {
        role: "user",
        content: `Summarize the above conversation according to your system prompts.`
      }
    ],
  })
  userMsg.summary.body = result.text
}
```

### Small Model Strategy

- **Title generation**: 20 tokens (1500 for reasoning models)
- **Body summary**: 100 tokens
- **Tool pruning**: Replace outputs with "[TOOL OUTPUT PRUNED]" before summarization
- **Fallback**: Uses main model if no small model available

### System Prompts

| Prompt Type | Function | Purpose |
|-------------|----------|---------|
| `SystemPrompt.title()` | Title generation | Extract concise title from message |
| `SystemPrompt.summarize()` | Body summary | Create 100-token conversation summary |
| `SystemPrompt.compaction()` | Full compaction | Detailed summary for context continuation |

---

## 7. Prompt Assembly

**File:** `src/session/prompt.ts`

### Key Configuration

```typescript
export const OUTPUT_TOKEN_MAX = 32_000  // Maximum output reservation
```

### Message Structure

Messages consist of typed parts:

```typescript
type PromptInput = {
  sessionID: string
  messageID?: string
  model?: { providerID: string; modelID: string }
  agent?: string
  noReply?: boolean
  system?: string
  tools?: Record<string, boolean>
  parts: (TextPart | FilePart | AgentPart | SubtaskPart)[]
}
```

### Part Types

| Part Type | Purpose | Content |
|-----------|---------|---------|
| **Text** | User text input | Raw text |
| **File** | File attachments | File URL + MIME type |
| **Agent** | Agent handoff | Agent identifier |
| **Subtask** | User tool execution | Tool metadata |
| **Compaction** | Trigger summary | "What did we do so far?" |

---

## 8. Context Window Management Flow

### Full Lifecycle

```
┌─────────────────────────────────────────────────────┐
│ 1. User sends message with file attachments         │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ 2. Token estimation (4 chars/token heuristic)       │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│ 3. Check overflow: isOverflow()                     │
│    (input + cache + output) > usable context?       │
└──────────────────┬──────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
     NO │                  YES│
        │                     │
        ▼                     ▼
┌─────────────┐      ┌──────────────────────┐
│ 4a. Normal  │      │ 4b. Trigger pruning  │
│  processing │      │     and compaction   │
└─────────────┘      └──────────┬───────────┘
                                │
                                ▼
                     ┌──────────────────────────┐
                     │ 5. Prune old tool outputs│
                     │    Keep last 40k tokens  │
                     │    Remove rest if >20k   │
                     └──────────┬───────────────┘
                                │
                                ▼
                     ┌──────────────────────────┐
                     │ 6. Mark pruned with      │
                     │    compacted timestamp   │
                     └──────────┬───────────────┘
                                │
                                ▼
                     ┌──────────────────────────┐
                     │ 7. LLM-powered compaction│
                     │    Generate summary      │
                     └──────────┬───────────────┘
                                │
                                ▼
                     ┌──────────────────────────┐
                     │ 8. Replace tool outputs  │
                     │    with placeholders in  │
                     │    toModelMessage()      │
                     └──────────┬───────────────┘
                                │
                ┌───────────────┴────────────────┐
                │                                │
                ▼                                ▼
     ┌──────────────────┐           ┌──────────────────────┐
     │ 9a. Continue     │           │ 9b. Session summary  │
     │     conversation │           │     File diffs       │
     └──────────────────┘           │     Message titles   │
                                    └──────────────────────┘
```

---

## 9. Context Optimization Techniques

### 9.1 Prompt Caching

**Evidence:** In `isOverflow()`, cache reads are included in token count:

```typescript
const count = input.tokens.input + input.tokens.cache.read + input.tokens.output
```

**Strategy:**
- System prompts likely cached
- Tool definitions likely cached
- Reduces effective input token count for repeated content

### 9.2 Tool Output Management

**Strategies:**

1. **Recent preservation**: Keep 40k tokens of recent tool outputs
2. **Compaction flagging**: Mark old outputs for replacement
3. **Placeholder replacement**: "[Old tool result content cleared]" (8 tokens)
4. **Summarization prep**: "[TOOL OUTPUT PRUNED]" before generating summaries

### 9.3 Small Model Usage

**Efficiency optimization:**

```typescript
const small = await Provider.getSmallModel(providerID)
```

- **Title generation**: Use cheapest model, 20 tokens
- **Summaries**: Use small model, 100 tokens
- **Cost savings**: Significant for frequent summarization

### 9.4 Message Filtering

**In compaction process:**

```typescript
input.messages.filter((m) => {
  // Remove error messages unless they have useful content
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
})
```

**Purpose:** Don't send failed/aborted messages to compaction unless they contain useful parts

---

## 10. Configuration Flags

### Environment Variables

| Flag | Default | Purpose |
|------|---------|---------|
| `OPENCODE_DISABLE_AUTOCOMPACT` | false | Disable automatic compaction |
| `OPENCODE_DISABLE_PRUNE` | false | Disable tool output pruning |

**Usage:**

```bash
export OPENCODE_DISABLE_AUTOCOMPACT=true  # Prevent auto-compaction
export OPENCODE_DISABLE_PRUNE=true        # Prevent tool pruning
```

---

## 11. Performance Characteristics

### Token Savings Analysis

| Technique | Savings per Item | Trigger Threshold |
|-----------|------------------|-------------------|
| **Tool pruning** | ~4,992 tokens/tool | >20k total savings |
| **Compaction** | Variable, often 50-80% | Context overflow |
| **Small model summaries** | N/A (cost savings) | Every message |

### Example Scenario

**Before optimization:**
- 10 tool calls × 5,000 tokens each = 50,000 tokens
- Context limit: 200,000 tokens
- Usable: 168,000 tokens (minus 32k output reservation)

**After pruning (keeping last 40k):**
- Recent 8 tools: 40,000 tokens (preserved)
- Old 2 tools: 16 tokens (2 × "[Old tool result content cleared]")
- **Total: 40,016 tokens (saved 9,984 tokens)**

**After compaction:**
- Summary message: ~500-2,000 tokens
- Previous conversation: replaced by summary
- **Savings: Often 50,000+ tokens on long conversations**

---

## 12. Key Insights

### Strengths

1. **Multi-layered approach**: Pruning → Compaction → Summarization
2. **Recency-biased**: Preserves recent context, removes old
3. **Selective**: Only removes irrelevant tool outputs
4. **LLM-powered**: Intelligent summarization maintains coherence
5. **Cost-efficient**: Uses small models for summaries
6. **Configurable**: Environment flags for debugging
7. **Non-destructive**: Original data preserved in database

### Trade-offs

1. **Token estimation**: 4-char heuristic is approximate
2. **Fixed thresholds**: 20k/40k may not suit all use cases
3. **Compaction latency**: LLM call adds delay
4. **Context loss**: Summaries may lose nuance
5. **No re-expansion**: Once compacted, can't retrieve original

### Comparison to Industry

| Approach | OpenCode | Typical LLM Apps |
|----------|----------|------------------|
| **Token counting** | 4-char heuristic | tiktoken/actual tokenizer |
| **Pruning strategy** | Selective tool output removal | Full message removal |
| **Summarization** | LLM-powered | Manual or none |
| **Recency bias** | 40k token window | Often FIFO |
| **Cost optimization** | Small model for summaries | Often same model |
| **Transparency** | Placeholder markers | Often hidden |

---

## 13. Recommendations

### For Developers

1. **Monitor compaction frequency**: High frequency may indicate aggressive thresholds
2. **Tune PRUNE_PROTECT**: Adjust 40k based on typical tool output size
3. **Consider tokenizer**: Replace 4-char heuristic with model-specific tokenizer
4. **A/B test summaries**: Compare small vs. main model quality
5. **Add metrics**: Track token savings, compaction frequency, user impact

### For Users

1. **Be concise**: Less verbose tool outputs = less pruning needed
2. **Use file tools wisely**: Large file reads trigger faster pruning
3. **Review summaries**: Check compaction messages for accuracy
4. **Leverage recent context**: Last 40k tokens of tools always available

---

## 14. Related Files

### Core Session Management

- `session/index.ts` - Session CRUD operations
- `session/processor.ts` - Stream processing and tool execution
- `session/message.ts` - Legacy message handling
- `session/message-v2.ts` - Current message system
- `session/system.ts` - System prompt definitions
- `session/retry.ts` - Retry logic
- `session/revert.ts` - Conversation reversion
- `session/status.ts` - Session status tracking
- `session/todo.ts` - Todo management

### Supporting Utilities

- `util/log.ts` - Logging
- `util/fn.ts` - Function utilities
- `provider/provider.ts` - LLM provider abstraction
- `provider/transform.ts` - Provider-specific transformations
- `snapshot/` - Filesystem snapshot diffing
- `storage/` - Persistent storage layer

---

## 15. Future Optimization Opportunities

### Short Term

1. **Actual tokenizer integration**: Use tiktoken or model-specific tokenizers
2. **Adaptive thresholds**: Adjust PRUNE_PROTECT based on conversation dynamics
3. **Compression before pruning**: Gzip tool outputs before storing
4. **Metrics dashboard**: Track token usage, savings, compaction frequency

### Long Term

1. **Semantic pruning**: Use embeddings to identify truly irrelevant content
2. **Hierarchical summaries**: Multi-level summaries for very long conversations
3. **RAG integration**: Move old context to vector store, retrieve on-demand
4. **Delta encoding**: Store only changes between tool outputs
5. **Streaming summaries**: Generate summaries incrementally vs. all at once

---

**End of Analysis**

This documentation provides a comprehensive view of OpenCode's context management system, revealing a sophisticated multi-layered approach to handling LLM context window constraints through intelligent pruning, compaction, and summarization strategies.
