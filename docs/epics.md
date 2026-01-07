---
stepsCompleted: [0, 1, 2, 3]
workflowType: 'epics-and-stories'
project_name: 'opencode_context_management'
user_name: 'Basil'
date: '2025-12-04'
status: 'complete'
---

# opencode_context_management - Epic Breakdown

**Author:** Basil
**Date:** 2025-12-04
**Project Level:** Feature Enhancement (Brownfield)
**Target Scale:** MVP

---

## Overview

This document provides the complete epic and story breakdown for Intelligent Context Compaction with Retrieval, decomposing the requirements from the [PRD](./prd.md) into implementable stories with technical context from the [Architecture](./architecture.md).

**Living Document Notice:** Stories are implementation-ready with full technical details from Architecture decisions.

---

## Context Validation

**Input Documents Loaded:**
- ✅ PRD (`docs/prd.md`) - 24 Functional Requirements, 8 Non-Functional Requirements
- ✅ Architecture (`docs/architecture.md`) - Complete technical decisions
- ○ UX Design - Not applicable (CLI tool)

**PRD Scope:** MVP - Problem-Solving approach to eliminate catastrophic compaction

**Key Technical Constraints from Architecture:**
- Use existing `msg_xxx` message ID format
- Archive metadata stored on first message, `archivedBy` reference on subsequent
- Separate LLM call for compaction (not TaskTool subagent)
- Context gauge as new part type with ramping frequency
- `[SMART_ARCHIVED]` placeholder format
- Standard Tool.define() pattern for Compact/Retrieve tools

---

## Functional Requirements Inventory

### Message Identity (2 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR1 | System assigns unique, stable IDs to all messages | MVP |
| FR2 | Message IDs persist when sessions are resumed | MVP |

### Context Visibility (3 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR3 | System inserts token utilization checkpoints every ~10,000 tokens | MVP |
| FR4 | Token checkpoints are append-only (never modified) | MVP |
| FR5 | LLM can see token utilization checkpoints in context | MVP |

### Compaction (8 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR6 | User can compact a message range via slash command | MVP |
| FR7 | User can compact via natural language request | MVP |
| FR8 | LLM can autonomously decide to compact content | MVP |
| FR9 | Compaction generates summary of archived content | MVP |
| FR10 | Compaction generates semantic index terms | MVP |
| FR11 | Compaction stores original content to persistent storage | MVP |
| FR12 | Compaction replaces original messages with placeholder | MVP |
| FR13 | Placeholder displays summary, index terms, message range | MVP |

### Retrieval (3 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR14 | User can retrieve archived content by message ID | MVP |
| FR15 | LLM can autonomously retrieve archived content when relevant | MVP |
| FR16 | Retrieved content is appended to conversation context | MVP |

### Configuration (4 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR17 | User can configure compaction mode (ask/notify/silent) | MVP |
| FR18 | In "ask" mode, LLM requests permission before compacting | MVP |
| FR19 | In "notify" mode, LLM notifies user after compacting | MVP |
| FR20 | In "silent" mode, LLM compacts without notification | MVP |

### Persistence (2 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR21 | Archived content persists across session resume | MVP |
| FR22 | Archived content maintains data integrity over time | MVP |

### Message ID Privacy (2 FRs)
| ID | Requirement | Scope |
|----|-------------|-------|
| FR23 | Message IDs are hidden from LLM during normal conversation by default | MVP |
| FR24 | Compact tool can enable message ID visibility via session flag (two-phase compaction) | MVP |

### Non-Functional Requirements (8 NFRs)
| ID | Requirement | Category |
|----|-------------|----------|
| NFR1 | Compact/Retrieve tools integrate with existing tool system | Integration |
| NFR2 | Storage uses existing file-based Storage API | Integration |
| NFR3 | Configuration integrates with existing config system | Integration |
| NFR4 | Message IDs integrate with existing MessageV2 architecture | Integration |
| NFR5 | Archived content is never lost due to system errors | Reliability |
| NFR6 | Retrieval returns exact original content (no corruption) | Reliability |
| NFR7 | Placeholders maintain valid references to archived content | Reliability |
| NFR8 | Storage operations are atomic (no partial writes) | Reliability |

---

## Epic Structure Plan

### Summary

| Epic | Title | User Value | FRs Covered |
|------|-------|------------|-------------|
| 1 | Foundation & Context Awareness | LLM sees context utilization, makes informed decisions | FR3-5, FR17 |
| 2 | Smart Compaction | Archive content with intelligent summaries | FR6-13, FR21-22 |
| 3 | Content Retrieval | Get archived content back when needed | FR14-16 |
| 4 | Autonomous Behavior Control | Control LLM autonomy level | FR18-20 |
| 5 | Message ID Privacy | Prevent LLM from hallucinating fake message IDs | FR23 |

### Technical Context per Epic

**Epic 1 - Architecture References:**
- `ContextGaugePart` type (Architecture: Context Gauge Part Type)
- Ramping frequency (Architecture: Token Checkpoints)
- Schema extension: `archive`, `archivedBy` fields (Architecture: Message Schema Extension)
- `archive-context.ts` for ID-prefixed context (Architecture: Sub-Agent Context Format)

**Epic 2 - Architecture References:**
- Compact tool pattern (Architecture: Tool Implementation)
- Separate LLM call for compaction (Architecture: Compaction Architecture)
- Archive metadata on first message (Architecture: Archive Storage Design)
- `[SMART_ARCHIVED]` placeholder (Architecture: Placeholder Formats)

**Epic 3 - Architecture References:**
- Retrieve tool pattern (Architecture: Tool Implementation)
- Content retrieval flow (Architecture: Retrieval Architecture)

**Epic 4 - Architecture References:**
- Config extension (Architecture: File Responsibilities - config.ts)
- Mode-based behavior in tool execution

**Epic 5 - Architecture References:**
- `toModelMessage()` in `message-v2.ts` (normal conversation context)
- `toModelMessageWithIDs()` in `archive-context.ts` (compaction-only context)
- `prefixWithId()` function usage patterns

---

## Epic 1: Foundation & Context Awareness

**Goal:** Establish the infrastructure that enables the LLM to see context utilization and make informed compaction decisions. After this epic, the system has all foundational pieces needed for smart compaction.

**User Value:** LLM becomes aware of context window utilization through visible checkpoints, enabling informed decisions about when compaction would help.

**FRs Covered:** FR3, FR4, FR5, FR17

---

### Story 1.1: Context Gauge Part Type

As a developer,
I want to define a new ContextGaugePart schema,
So that token utilization checkpoints can be stored as permanent message parts.

**Acceptance Criteria:**

**Given** the MessageV2 schema in `session/message-v2.ts`
**When** I add the ContextGaugePart type
**Then** the schema includes:
```typescript
export const ContextGaugePart = PartBase.extend({
  type: z.literal("context-gauge"),
  tokenCount: z.number(),
  contextLimit: z.number(),
  percentage: z.number(),
}).meta({ ref: "ContextGaugePart" })
```

**And** ContextGaugePart is added to the Part discriminated union
**And** the part can be serialized/deserialized correctly
**And** existing message loading continues to work (backwards compatible)

**Technical Notes:**
- Location: `packages/opencode/src/session/message-v2.ts`
- Follow existing part type patterns (TextPart, ToolCallPart, etc.)
- Part is stored permanently (append-only per FR4)

**Prerequisites:** None

---

### Story 1.2: Context Gauge Injection Logic

As a user,
I want the system to automatically insert context gauge checkpoints as the conversation grows,
So that the LLM can see how full the context window is.

**Acceptance Criteria:**

**Given** a conversation with growing token count
**When** the token count crosses a checkpoint threshold (as percentage of context limit)
**Then** a ContextGaugePart is appended to the current assistant message

**And** checkpoint frequency ramps up as context fills (percentage-based for model independence):
| Utilization | Checkpoint Interval |
|-------------|---------------------|
| 0% - 30% | Every 30% of context |
| 30% - 60% | Every 15% of context |
| 60% - 80% | Every 10% of context |
| 80%+ | Every 5% of context |

**And** checkpoints are never modified after creation (append-only)
**And** the gauge renders in context as: `[CONTEXT GAUGE: 45,000 / 100,000 tokens (45%)]`
**And** gauge injection does not invalidate prompt cache (appended, not inserted)

**Technical Notes:**
- Location: `packages/opencode/src/session/compaction.ts` (extend existing)
- Use `util/token.ts` for token estimation
- **Injection target**: Append gauge to the assistant message (runs after response completion)
- **State tracking**: Derive last checkpoint by scanning existing ContextGaugeParts in session (follows existing pattern where compaction tracks via `time.compacted` in parts). No separate state storage needed.
- **Threshold constants**: Store as percentages (0.30, 0.15, 0.10, 0.05) - works with any model's context limit
- Get model's context limit from `ModelsDev.Model` configuration

**Prerequisites:** Story 1.1

---

### Story 1.3: Message Schema Extension for Archive Fields

As a developer,
I want to extend the message schema with archive metadata fields,
So that messages can be marked as archived with summary and index terms.

**Acceptance Criteria:**

**Given** the MessageV2 schema
**When** I extend the message type
**Then** messages support optional `archive` field on first message of range:
```typescript
archive: z.object({
  summary: z.string(),
  indexTerms: z.array(z.string()),
  rangeEnd: z.string(),  // ID of last message in archived range
}).optional()
```

**And** messages support optional `archivedBy` field on subsequent messages:
```typescript
archivedBy: z.string().optional()  // Points to first message's ID
```

**And** existing messages without these fields load correctly
**And** messages can be queried by archive status

**Technical Notes:**
- Location: `packages/opencode/src/session/message-v2.ts`
- Archive metadata persists with message (uses existing Storage API)
- No separate archive storage namespace needed
- Original message content stays in place (not moved)

**Prerequisites:** None

---

### Story 1.4: ID-Annotated Context Builder

As a developer,
I want a function that builds context with message IDs prefixed to content,
So that the compaction LLM can reference specific messages by ID.

**Acceptance Criteria:**

**Given** an array of messages
**When** I call `toModelMessageWithIDs(messages)`
**Then** each message's text content is prefixed with `[msg_xxx]`

**Example output:**
```typescript
// User message
{ role: "user", content: [{ type: "text", text: "[msg_abc] Fix the login page" }] }

// Assistant message
{ role: "assistant", content: [{ type: "text", text: "[msg_def] Let me read the file first" }] }
```

**And** tool call parts retain their structure (ID prefix on text parts only)
**And** the function follows existing `toModelMessage()` patterns
**And** archived messages show placeholder instead of original content

**Technical Notes:**
- Location: `packages/opencode/src/session/archive-context.ts` (NEW)
- Variant of existing `toModelMessage()` in `message-v2.ts`
- Used only for compaction LLM call, not main conversation
- Must handle all part types correctly

**Prerequisites:** Story 1.3

---

### Story 1.5: Configuration Extension for Compaction Mode

As a user,
I want to configure my preferred compaction mode,
So that I can control how autonomous the LLM is with compaction decisions.

**Acceptance Criteria:**

**Given** OpenCode's configuration system
**When** I add compaction settings
**Then** the config supports:
```typescript
compaction: {
  mode: "ask" | "notify" | "silent",  // default: "notify"
  enabled: boolean,  // default: true
}
```

**And** settings persist across sessions
**And** settings can be changed via config file or CLI
**And** invalid values are rejected with helpful error messages

**Technical Notes:**
- Location: `packages/opencode/src/config/config.ts`
- Follow existing config patterns
- Default to "notify" mode (balance of control and convenience)
- Mode affects Compact tool behavior (implemented in Epic 4)

**Prerequisites:** None

---

### Story 1.6: Tool Registration Setup

As a developer,
I want placeholder registrations for Compact and Retrieve tools,
So that the tool infrastructure is ready for implementation.

**Acceptance Criteria:**

**Given** the tool registry in `tool/registry.ts`
**When** I add Compact and Retrieve tool registrations
**Then** both tools appear in the `all()` function return
**And** each tool has:
- Stub implementation that returns "Not yet implemented"
- Tool description file (`.txt`) with basic description
- Proper TypeScript types

**And** tools are available to the LLM in tool lists
**And** existing tools continue to work

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`, `retrieve.ts`, `registry.ts`
- Follow existing tool patterns (Tool.define())
- Tool descriptions refined in Epic 2/3

**Prerequisites:** None

---

**Epic 1 Complete**

**Stories Created:** 6
**FR Coverage:** FR3, FR4, FR5, FR17
**Architecture Sections Used:** Context Gauge Part Type, Token Checkpoints, Message Schema Extension, Sub-Agent Context Format, Tool Implementation

---

## Epic 2: Smart Compaction

**Goal:** Implement the Compact tool that archives message ranges with intelligent summaries and semantic index terms, replacing original content with smart placeholders.

**User Value:** Users can archive verbose or stale content. The LLM can autonomously compact when it detects content that's voluminous or no longer immediately relevant. Placeholders show what was archived and enable retrieval.

**FRs Covered:** FR6, FR7, FR8, FR9, FR10, FR11, FR12, FR13, FR21, FR22

---

### Story 2.1: Compact Tool Basic Structure

As a developer,
I want the Compact tool to accept message range parameters,
So that users and the LLM can specify what to compact.

**Acceptance Criteria:**

**Given** the Compact tool stub from Epic 1
**When** I implement parameter handling
**Then** the tool accepts an array of ranges (supports partitioning in single call):
```typescript
{
  ranges: Array<{
    startMessageId: string,  // e.g., "msg_abc"
    endMessageId?: string,   // e.g., "msg_xyz" (optional, defaults to startMessageId)
  }>
}
```

**And** the tool validates for each range:
- Both message IDs exist in current session
- Start message comes before end message chronologically
- Messages are not already archived (note: when building this story, ask for
  clarification. There may be a range that includes previously-archived
  messages; this is acceptable, but if the range starts or ends in
  already-compacted messges, then the range is invalid)
- Range contains at least one message
- Ranges do not overlap with each other

**And** invalid parameters return clear error messages
**And** the tool description (`.txt`) explains parameters clearly
**And** single-range compaction is just an array with one element

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Message lookup via session message store
- Process ranges in order; each gets its own summary/indexTerms via Story 2.2
- Natural language parsing ("compact the auth discussion") handled by LLM, tool just needs IDs

**Prerequisites:** Story 1.6

---

### Story 2.2: Compaction LLM Call for Summary Generation

As a user,
I want compaction to generate an intelligent summary of archived content,
So that the placeholder helps me understand what was archived.

**Acceptance Criteria:**

**Given** one or more message ranges to compact
**When** the Compact tool executes
**Then** it makes a separate LLM call with:
- Full conversation context via `toModelMessageWithIDs()`
- System prompt instructing summary and index term generation
- All ranges to summarize (LLM generates summary/terms for each)

**And** the LLM returns a map keyed by startMessageId:
```typescript
Record<string, {        // Key is startMessageId (e.g., "msg_abc")
  summary: string,      // 1-3 sentence summary
  indexTerms: string[], // 3-7 semantic keywords
}>
```

**Rationale:** Using startMessageId as key (not array index) is more robust - results are self-describing and can be matched regardless of order or if LLM skips/reorders entries.

**And** the summary captures the essence of the archived content
**And** index terms enable future retrieval by keyword

**System prompt must instruct:**
```
Generate a concise summary (1-3 sentences) and 3-7 index terms for retrieval.

CRITICAL FOR DEBUGGING/ITERATION CONTENT:
If the content contains debugging attempts, iterations, or trial-and-error:
- Summarize WHAT WAS TRIED and WHAT WAS LEARNED
- Include specific error messages or insights discovered
- Note any constraints or requirements discovered
- Don't just say "debugging session" - capture the knowledge gained

Example good summary: "Debugged auth failure across 3 iterations. Tried: token refresh
(tokens valid), session storage (sessions persisting). Found: middleware order causing
session loss before auth check. Solution: move session middleware before auth."

Example bad summary: "Debugging session for authentication issues."
```

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Follow existing compaction pattern: separate `streamText()` call
- Use same model as main conversation (or configurable smaller model)
- System prompt emphasizes conciseness, keyword extraction, AND knowledge preservation
- Consider: detect "debugging-like" patterns and adjust prompt emphasis

**Prerequisites:** Story 1.4, Story 2.1

---

### Story 2.3: Archive Metadata Storage

As a user,
I want archived content metadata to be stored reliably,
So that I can retrieve the original content later.

**Acceptance Criteria:**

**Given** a successful compaction with summary and index terms
**When** the Compact tool stores archive metadata
**Then** the first message in range gets `archive` field:
```typescript
{
  archive: {
    summary: "Discussed authentication architecture...",
    indexTerms: ["auth", "JWT", "security"],
    rangeEnd: "msg_xyz"
  }
}
```

**And** subsequent messages in range get `archivedBy` field:
```typescript
{
  archivedBy: "msg_abc"  // Points to first message
}
```

**And** original message content remains unchanged in storage
**And** metadata persists across session resume (FR21)
**And** storage operations are atomic - no partial updates (NFR8)

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Use existing message update patterns
- Consider transaction-like behavior: update all or none
- Original parts[] content stays in place
- **Correlation**: Match summary results to ranges via startMessageId key:
  ```typescript
  for (const [startId, messages] of validatedRanges) {
    const summary = summaryResults[startId];  // Direct lookup by key
    await updateFirstMessage(startId, { archive: { summary, indexTerms, rangeEnd } });
    for (const msg of messages.slice(1)) {
      await updateMessage(msg.id, { archivedBy: startId });
    }
  }
  ```

**Prerequisites:** Story 1.3, Story 2.2

---

### Story 2.4: Placeholder Generation and Context Display

As a user,
I want archived messages to display as smart placeholders in conversation,
So that I can see what was archived and how to retrieve it.

**Acceptance Criteria:**

**Given** messages marked with `archive` or `archivedBy` metadata
**When** context is built for the LLM (via `toModelMessage()`)
**Then** archived messages are replaced with placeholder:

**Single message:**
```
[SMART_ARCHIVED: msg_abc]
Summary: Discussed auth architecture with JWT approach...
Index: auth, JWT, security, token rotation
```

**Range:**
```
[SMART_ARCHIVED: msg_abc to msg_xyz]
Summary: Discussed auth architecture with JWT approach...
Index: auth, JWT, security, token rotation
```

**And** only the first message shows the full placeholder
**And** subsequent messages in range are omitted from context entirely
**And** placeholder is concise (minimizes token usage)
**And** non-archived messages render normally

**Technical Notes:**
- Location: `packages/opencode/src/session/message-v2.ts` (modify `toModelMessage()`)
- Check for `archive` field → render placeholder
- Check for `archivedBy` field → skip message entirely
- Placeholder format matches Architecture spec

**Prerequisites:** Story 2.3

---

### Story 2.5: User-Directed Compaction via Tool Call

As a user,
I want to direct the LLM to compact specific messages,
So that I can manually manage my context when needed.

**Acceptance Criteria:**

**Given** I want to compact a message range
**When** I say "compact messages msg_abc to msg_xyz" or use natural language like "archive our earlier auth discussion"
**Then** the LLM calls the Compact tool with appropriate parameters

**And** the LLM can interpret natural language requests:
- "Compact the authentication discussion" → LLM identifies relevant message range
- "Archive everything before this" → LLM determines appropriate range
- "Compact msg_abc to msg_xyz" → Direct ID specification

**And** after compaction, I see:
- Confirmation of what was archived
- The placeholder in conversation history
- Token savings achieved

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.txt` (tool description)
- Natural language interpretation is LLM's job - tool just needs IDs
- Tool description should explain how to identify message ranges
- Consider including message ID hints in context gauge output

**Prerequisites:** Story 2.4

---

### Story 2.6: LLM Autonomous Compaction Decision

As a user,
I want the LLM to autonomously decide when to compact,
So that I don't have to manually manage context.

**Acceptance Criteria:**

**Given** the LLM sees context gauge checkpoints showing high utilization
**When** the LLM identifies content that is:
- Voluminous (large tool outputs, long discussions)
- No longer immediately relevant to current task
- Repeated or redundant information
- Part of a completed iteration in a loop/retry pattern

**Then** the LLM can autonomously call the Compact tool
**And** the decision respects the configured compaction mode (ask/notify/silent)
**And** the LLM explains its reasoning when in ask/notify modes

**Tool description guidance:**
```
Use this tool when you notice:
- Context gauge shows >60% utilization
- Large blocks of content (>5000 tokens) not relevant to current task
- Completed discussions that may be needed later but not now
- Verbose tool outputs (logs, file contents) already analyzed

LOOP/ITERATION DETECTION:
When following instructions in a loop (debugging, retrying, iterating):
- Prior iterations may be compacted once a new iteration begins
- CRITICAL: Before compacting loop iterations, identify what must propagate:
  - What was tried in each iteration
  - What was learned (errors, insights, partial successes)
  - Any constraints discovered that affect future attempts
- The summary MUST capture these learnings, not just "tried X, failed"
- Example: "Iteration 1-3: Tried fixing auth via token refresh (failed - tokens valid),
  session storage (failed - sessions persisting), found root cause in middleware order"

RANGE PARTITIONING:
Consider splitting a contiguous range into multiple archives when:
- Different topics/tasks are intermixed (separate summaries more useful)
- User might want to retrieve only a portion (e.g., just the API discussion, not the DB part)
- A single summary would lose important distinctions between sub-topics
When partitioning, provide multiple ranges in the single compact call (tool accepts an array).
```

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.txt`
- Autonomous behavior enabled by tool description guidance
- Mode handling implemented in Epic 4
- LLM uses context gauge to inform decisions
- Loop detection is LLM judgment based on conversation patterns
- Compaction system prompt should emphasize extracting "tried/learned" for debugging sessions

**Prerequisites:** Story 1.2, Story 2.5

---

### Story 2.7: Data Integrity and Persistence Guarantees

As a user,
I want archived content to be reliably preserved,
So that I never lose data due to compaction.

**Acceptance Criteria:**

**Given** content has been archived
**When** the session is resumed later
**Then** archive metadata is correctly loaded
**And** original content is still accessible
**And** placeholders render correctly

**And** given a system crash during compaction
**When** the session is recovered
**Then** either:
- Compaction completed fully (all metadata saved), OR
- Compaction did not happen (no partial state)

**And** archived content maintains integrity indefinitely (FR22)
**And** no data corruption occurs during storage operations

**Technical Notes:**
- Leverage existing Storage API reliability
- Consider: write archive metadata to all messages in single operation
- Test: interrupt compaction mid-operation, verify clean state
- Original content never deleted, only metadata added

**Prerequisites:** Story 2.3

---

**Epic 2 Complete**

**Stories Created:** 7
**FR Coverage:** FR6, FR7, FR8, FR9, FR10, FR11, FR12, FR13, FR21, FR22
**NFRs Addressed:** NFR1, NFR2, NFR5, NFR7, NFR8
**Architecture Sections Used:** Compaction Architecture, Archive Storage Design, Placeholder Formats, Tool Implementation

---

## Epic 3: Content Retrieval

**Goal:** Implement the Retrieve tool that fetches archived content back into active context when needed.

**User Value:** Users can get archived content back when they need it. The LLM can autonomously retrieve when it detects that archived content is relevant to the current task.

**FRs Covered:** FR14, FR15, FR16

---

### Story 3.1: Retrieve Tool Implementation

As a user,
I want to retrieve archived content by its archive ID,
So that I can access original content when needed.

**Acceptance Criteria:**

**Given** content has been archived with ID `msg_abc`
**When** the Retrieve tool is called with `{ archiveId: "msg_abc" }`
**Then** the tool:
1. Finds the message with matching ID and `archive` field
2. Collects all messages from `msg_abc` to `archive.rangeEnd`
3. Returns original content as tool result

**And** the returned content includes:
```
Retrieved content from archive msg_abc to msg_xyz:

[Original message contents here, with message IDs for reference]
```

**And** invalid archive IDs return clear error message
**And** retrieved content is appended to context (standard tool result)
**And** archive metadata remains in place (content stays archived)

**Technical Notes:**
- Location: `packages/opencode/src/tool/retrieve.ts`
- Read original `parts[]` from messages in range
- Format output for LLM readability
- Does NOT remove archive metadata (retrieval is non-destructive)
- **Update compact.txt**: Remove "(not yet implemented)" from retrieval hint once this story is complete

**Prerequisites:** Epic 2 complete

---

### Story 3.2: LLM Autonomous Retrieval

As a user,
I want the LLM to autonomously retrieve archived content when relevant,
So that important context is restored without manual intervention.

**Acceptance Criteria:**

**Given** the conversation contains `[SMART_ARCHIVED]` placeholders
**When** the LLM detects that archived content may be relevant:
- User asks about topics matching index terms
- Current task relates to archived discussion
- LLM needs details from archived content

**Then** the LLM autonomously calls the Retrieve tool
**And** the LLM explains why it's retrieving (in ask/notify modes)
**And** retrieved content is used to inform the response

**Tool description guidance:**
```
Use this tool when you see a [SMART_ARCHIVED] placeholder and:
- The current question/task relates to the archived content
- Index terms in the placeholder match current discussion
- You need specific details that were in the archived content
- User explicitly asks about something that was archived
```

**Technical Notes:**
- Location: `packages/opencode/src/tool/retrieve.txt`
- Retrieval does not require mode permission (it's restoring, not removing)
- LLM uses placeholder summary/index to decide relevance
- Consider: partial retrieval (single message from range) for future

**Prerequisites:** Story 3.1

---

**Epic 3 Complete**

**Stories Created:** 2
**FR Coverage:** FR14, FR15, FR16
**NFRs Addressed:** NFR6 (exact retrieval)
**Architecture Sections Used:** Retrieval Architecture, Tool Implementation

---

## Epic 4: Autonomous Behavior Control

**Goal:** Implement the three compaction modes that give users control over LLM autonomy.

**User Value:** Users control how much autonomy the LLM has for compaction decisions - from requiring explicit permission to fully silent operation.

**FRs Covered:** FR18, FR19, FR20

---

### Story 4.1: Ask Mode Implementation

As a user in "ask" mode,
I want the LLM to request permission before compacting,
So that I approve every compaction decision.

**Acceptance Criteria:**

**Given** compaction mode is set to "ask"
**When** the LLM decides to compact content
**Then** instead of executing immediately, the tool:
1. Presents what will be archived (message range, estimated tokens)
2. Shows the proposed summary
3. Asks: "Proceed with compaction? (yes/no)"
4. Waits for user response

**And** if user says yes → compaction proceeds
**And** if user says no → compaction is cancelled, conversation continues
**And** the interaction is conversational (not a modal/dialog)

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Check config mode before execution
- Use tool's ability to request clarification/confirmation
- Store pending compaction state if needed

**Prerequisites:** Story 1.5, Story 2.6

---

### Story 4.2: Notify Mode Implementation

As a user in "notify" mode,
I want the LLM to compact and then tell me what it did,
So that I'm informed without interrupting my flow.

**Acceptance Criteria:**

**Given** compaction mode is set to "notify"
**When** the LLM executes compaction
**Then** the tool:
1. Performs compaction immediately
2. Returns a notification in the tool result:
```
Archived messages msg_abc to msg_xyz (4,500 tokens)
Summary: [generated summary]
Index terms: [terms]
Use retrieve tool with archiveId "msg_abc" to restore if needed.
```

**And** the notification is concise but informative
**And** user sees what was archived and how to retrieve it
**And** conversation continues without requiring response

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Default mode per Story 1.5
- Notification included in tool result (LLM will relay to user)

**Prerequisites:** Story 1.5, Story 2.6

---

### Story 4.3: Silent Mode Implementation

As a user in "silent" mode,
I want the LLM to compact without any notification,
So that my workflow is completely uninterrupted.

**Acceptance Criteria:**

**Given** compaction mode is set to "silent"
**When** the LLM executes compaction
**Then** the tool:
1. Performs compaction immediately
2. Returns minimal confirmation (for LLM's awareness only)
3. Does not generate user-facing notification

**And** the LLM does not mention the compaction to the user
**And** compaction is logged for debugging (not displayed)
**And** user only notices via placeholder in history (if they scroll back)

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Tool result is terse: "Compaction complete: msg_abc to msg_xyz"
- LLM instruction (in tool description): do not mention silent compactions
- Logging for audit/debugging purposes

**Prerequisites:** Story 1.5, Story 2.6

---

**Epic 4 Complete**

**Stories Created:** 3
**FR Coverage:** FR18, FR19, FR20
**Architecture Sections Used:** Config extension, mode-based behavior

---

## Epic 5: Message ID Privacy & Two-Phase Compaction

**Goal:** Fix a bug where message IDs are exposed to the LLM during normal conversation, causing the LLM to hallucinate fake message IDs. Implement two-phase compaction so the LLM can still access message IDs when it needs to select compaction targets.

**User Value:** Users can trust that message IDs shown in the UI correspond to real, actionable messages. The LLM no longer generates fake message ID references. Autonomous compaction still works because the LLM can enable ID visibility when needed.

**Bug Report:** During testing, the LLM's responses were found to contain message ID prefixes (e.g., `[msg_b9621c3530011d998346apfpEa]`) that don't correspond to any stored message. When users attempted to compact these IDs, the operation failed with "Message not found". Root cause: `toModelMessage()` was prefixing all messages with `[msg_xxx]` IDs, teaching the LLM the pattern which it then mimicked incorrectly.

**Solution:** Two-phase compaction:
1. Hide message IDs by default (FR23)
2. Compact tool can enable ID visibility via session flag (FR24)
3. When LLM calls compact with no ranges, flag flips, tool responds, context rebuilds with IDs visible
4. LLM can then call compact again with specific message ID ranges

**FRs Covered:** FR23, FR24

---

### Story 5.1: Conditional ID Prefixing Based on Compaction Mode Flag

As a user,
I want message IDs to be hidden from the LLM during normal conversation,
So that the LLM doesn't learn and hallucinate the `[msg_xxx]` pattern.

**Acceptance Criteria:**

**Given** a normal conversation with `compactionModeEnabled: false`
**When** context is built via `toModelMessage()`
**Then** message text is NOT prefixed with `[msg_xxx]` IDs

**And** user messages render as: `{ role: "user", content: "Fix the login page" }`
**And** assistant messages render without ID prefix
**And** context-gauge parts render without ID prefix
**And** archived placeholders still show their archive IDs (for retrieval reference)

**Given** compaction mode is enabled with `compactionModeEnabled: true`
**When** context is built via `toModelMessage()`
**Then** message text IS prefixed with `[msg_xxx]` IDs (same as current behavior)

**Technical Notes:**
- Location: `packages/opencode/src/session/message-v2.ts`
- Add `compactionModeEnabled` flag check to `toModelMessage()`
- When flag is false: render without ID prefixes
- When flag is true: render with ID prefixes (current behavior)
- Keep `toModelMessageWithIDs()` in `archive-context.ts` for summarization LLM call
- Flag is stored in session state (accessible during context building)

**Prerequisites:** None

---

### Story 5.2: Compact Tool Prepare Mode (Two-Phase Entry Point)

As an LLM,
I want to call the compact tool with no ranges to enable message ID visibility,
So that I can see message IDs and then call compact again with specific ranges.

**Acceptance Criteria:**

**Given** the compact tool is called with no ranges (or `mode: "prepare"`)
**When** the tool executes
**Then** it sets the session flag: `compactionModeEnabled = true`
**And** it returns a tool response:
```
Message IDs are now visible in the conversation (e.g., [msg_abc123]).

IMPORTANT: Do NOT mimic or generate message IDs in your responses. These IDs are
injected by the system and correspond to real stored messages. Only reference IDs
you can see prefixed on actual messages.

Call compact again with specific message ID ranges to archive content.
```

**And** when the tool response is sent to the LLM:
- The system rebuilds context for the continuation
- The flag is now true, so `toModelMessage()` includes ID prefixes
- The LLM sees all messages with `[msg_xxx]` prefixes

**And** the LLM can then call compact with specific ranges:
```typescript
compact({
  ranges: [
    { startMessageId: "msg_abc", endMessageId: "msg_xyz" }
  ]
})
```

**Given** compact tool is called with valid ranges
**When** compaction completes successfully
**Then** the flag is reset: `compactionModeEnabled = false`
**And** subsequent context builds hide message IDs again

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- Detect "prepare mode" by checking if `ranges` is empty or undefined
- Flag is stored in session state (must be accessible to `toModelMessage()`)
- Flag reset happens after successful compaction execution
- Update tool description (`compact.txt`) to include:
  - Two-phase flow explanation
  - "Message IDs are NOT visible by default. Call compact with no ranges first to enable ID visibility."
  - "Do not generate or guess message IDs - only use IDs visible in the conversation after prepare phase."

**Prerequisites:** Story 5.1

---

### Story 5.3: Verify Compaction Summarization Uses ID-Annotated Context

As a developer,
I want to verify the compact tool correctly uses `toModelMessageWithIDs()` for summarization,
So that the summarization LLM can reference message IDs when generating summaries and index terms.

**Acceptance Criteria:**

**Given** the Compact tool executes with valid ranges (phase 2)
**When** it builds context for the summarization LLM call
**Then** it uses `toModelMessageWithIDs()` from `archive-context.ts`

**And** the compaction LLM sees messages prefixed with IDs:
```
[msg_abc123] Fix the login page
[msg_def456] Let me read the file first
```

**And** the compaction LLM can correctly reference these IDs in its response
**And** all referenced IDs correspond to actual stored messages

**Technical Notes:**
- Location: `packages/opencode/src/tool/compact.ts`
- This is a separate LLM call from the main conversation
- Uses `toModelMessageWithIDs()` (not the flag-based `toModelMessage()`)
- Verify this still works correctly after Story 5.1 changes

**Prerequisites:** Story 5.2

---

### Story 5.4: Add Integration Tests for Message ID Privacy and Two-Phase Flow

As a developer,
I want automated tests to prevent regression of message ID visibility behavior,
So that future changes don't reintroduce the ID leak bug or break two-phase compaction.

**Acceptance Criteria:**

**Test case 1: Default ID hiding**
**Given** `compactionModeEnabled: false`
**When** `toModelMessage()` is called
**Then** no message text contains `[msg_` prefix pattern

**Test case 2: Flag-enabled ID visibility**
**Given** `compactionModeEnabled: true`
**When** `toModelMessage()` is called
**Then** all message text IS prefixed with `[msg_xxx]` pattern

**Test case 3: Summarization context always has IDs**
**Given** any flag state
**When** `toModelMessageWithIDs()` is called
**Then** all message text IS prefixed with `[msg_xxx]` pattern

**Test case 4: Two-phase flow**
**Given** compact tool is called with no ranges
**When** tool executes
**Then** `compactionModeEnabled` flag is set to true
**And** tool response includes "Message IDs are now visible"

**Test case 5: Flag reset after compaction**
**Given** compact tool is called with valid ranges and compaction succeeds
**When** compaction completes
**Then** `compactionModeEnabled` flag is reset to false

**Technical Notes:**
- Location: `packages/opencode/src/session/__tests__/` and `packages/opencode/src/tool/__tests__/`
- Test both context builders with sample messages
- Test flag state transitions in compact tool
- Archived placeholder text may contain `msg_` references (for retrieval) - this is expected

**Prerequisites:** Story 5.1, Story 5.2, Story 5.3

---

### Story 5.5: Display Message IDs in TUI for User Reference

As a user,
I want to see message IDs displayed in the TUI conversation view,
so that I can reference specific messages when compacting, debugging, or discussing conversation history.

**Acceptance Criteria:**

**Given** a user message in the TUI
**When** the message is displayed
**Then** the message ID appears in the username/timestamp line, right-aligned
**And** the ID is shown without brackets (e.g., `msg_abc123` not `[msg_xxx]`)

**Given** an assistant message in the TUI
**When** the message is displayed
**Then** the message ID appears below the response content, right-aligned
**And** shown for ALL assistant messages (not just last/final)

**Technical Notes:**
- Location: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Use `flexDirection="row"` with `justifyContent="space-between"` for right-alignment
- Message IDs inherit muted text styling from the metadata line
- Always visible by default (no toggle for MVP)

**Future Enhancement:** Consider adding keybinding to toggle ID visibility

**Prerequisites:** None (can be worked independently)

---

**Epic 5 Complete**

**Stories Created:** 5
**FR Coverage:** FR23, FR24
**Architecture Sections Used:** ID Visibility, Two-Phase Compaction Flow, Message Context Building

---

## FR Coverage Matrix

| FR | Description | Epic | Story |
|----|-------------|------|-------|
| FR1 | Unique, stable message IDs | - | Existing infrastructure |
| FR2 | Message IDs persist across resume | - | Existing infrastructure |
| FR3 | Token utilization checkpoints every ~10k | 1 | 1.2 |
| FR4 | Checkpoints are append-only | 1 | 1.1, 1.2 |
| FR5 | LLM sees checkpoints in context | 1 | 1.2 |
| FR6 | User compact via slash command | 2 | 2.5 |
| FR7 | User compact via natural language | 2 | 2.5 |
| FR8 | LLM autonomous compaction | 2 | 2.6 |
| FR9 | Compaction generates summary | 2 | 2.2 |
| FR10 | Compaction generates index terms | 2 | 2.2 |
| FR11 | Compaction stores to persistent storage | 2 | 2.3 |
| FR12 | Compaction replaces with placeholder | 2 | 2.4 |
| FR13 | Placeholder displays summary, terms, range | 2 | 2.4 |
| FR14 | User retrieve by message ID | 3 | 3.1 |
| FR15 | LLM autonomous retrieval | 3 | 3.2 |
| FR16 | Retrieved content appended to context | 3 | 3.1 |
| FR17 | Configure compaction mode | 1 | 1.5 |
| FR18 | Ask mode: request permission | 4 | 4.1 |
| FR19 | Notify mode: inform after | 4 | 4.2 |
| FR20 | Silent mode: no notification | 4 | 4.3 |
| FR21 | Archive persists across resume | 2 | 2.3, 2.7 |
| FR22 | Archive maintains integrity | 2 | 2.7 |
| FR23 | Message IDs hidden by default | 5 | 5.1, 5.4 |
| FR24 | Two-phase compaction enables ID visibility | 5 | 5.2, 5.4 |

**NFR Coverage:**

| NFR | Description | Addressed In |
|-----|-------------|--------------|
| NFR1 | Tool system integration | Stories 1.6, 2.1, 3.1 |
| NFR2 | Storage API integration | Stories 2.3, 2.7 |
| NFR3 | Config system integration | Story 1.5 |
| NFR4 | MessageV2 integration | Stories 1.1, 1.3 |
| NFR5 | No data loss | Story 2.7 |
| NFR6 | Exact retrieval | Story 3.1 |
| NFR7 | Valid placeholder references | Story 2.4 |
| NFR8 | Atomic storage operations | Story 2.7 |

---

## Summary

**Total Epics:** 5
**Total Stories:** 22

| Epic | Stories | FRs | Focus |
|------|---------|-----|-------|
| 1 - Foundation | 6 | FR3-5, FR17 | Infrastructure for context awareness |
| 2 - Smart Compaction | 7 | FR6-13, FR21-22 | Core compaction functionality |
| 3 - Content Retrieval | 2 | FR14-16 | Fetch archived content |
| 4 - Autonomous Control | 3 | FR18-20 | User control over LLM behavior |
| 5 - Message ID Privacy & Two-Phase | 4 | FR23-24 | ID hiding + two-phase compaction flow |

**All 24 FRs covered. All 8 NFRs addressed.**

**Implementation Order:**
1. Epic 1 establishes foundation (can be parallelized internally)
2. Epic 2 delivers core value (compaction works)
3. Epic 3 completes the cycle (retrieval works)
4. Epic 4 refines user experience (behavior modes)
5. Epic 5 enables autonomous compaction (must be done for LLM to select compaction targets)

**Ready for:** Sprint Planning and Development Implementation

---

_For implementation: Use the `create-story` workflow to generate individual story implementation plans from this epic breakdown._

---
