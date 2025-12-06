---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7]
inputDocuments:
  - "docs/prd.md"
  - "docs/index.md"
  - "docs/context-management-analysis.md"
workflowType: 'architecture'
lastStep: 7
project_name: 'opencode_context_management'
user_name: 'Basil'
date: '2025-12-04'
status: 'complete'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (22 FRs across 6 categories):**

| Category | FRs | Architectural Implication |
|----------|-----|---------------------------|
| Message Identity | FR1-FR2 | New ID infrastructure in MessageV2, persistence guarantees |
| Context Visibility | FR3-FR5 | Token checkpoint injection system, append-only constraint |
| Compaction | FR6-FR13 | Compact tool implementation, summarization, storage, placeholder generation |
| Retrieval | FR14-FR16 | Retrieve tool implementation, content restoration to context |
| Configuration | FR17-FR20 | Config system extension, mode-based LLM behavior |
| Persistence | FR21-FR22 | Storage durability, data integrity guarantees |

**Non-Functional Requirements (8 NFRs):**

- **Integration (NFR1-4):** Must integrate with existing tool system, Storage API, config system, and MessageV2 architecture
- **Reliability (NFR5-8):** Atomic operations, no data loss, exact retrieval, valid references

**Scale & Complexity:**

- Primary domain: CLI tool / LLM context management
- Complexity level: Medium (feature enhancement with clear boundaries)
- Estimated architectural components: 6-8 (tools, storage, message IDs, checkpoints, config, placeholders)

### Key Architectural Decision: Shared Infrastructure, Independent Triggers

**Decision:** The new Compact/Retrieve tools share infrastructure with existing compaction where applicable, but operate with independent triggers.

| Aspect | Existing Compaction | New Compact/Retrieve Tools |
|--------|---------------------|---------------------------|
| **Trigger** | Automatic on overflow | User/LLM directed |
| **Reversible** | No | Yes (via Retrieve) |
| **Placeholder** | Generic (`[Old tool result content cleared]`) | Rich (summary, index terms, retrieval hints) |

**Shared Infrastructure (extend where applicable):**
- Storage patterns (file-based Storage API)
- Summarization primitives (LLM-powered summary generation)
- Token estimation (`util/token.ts`)
- Placeholder injection into conversation context

**Independent:**
- Trigger conditions
- Placeholder content/format
- Archival metadata (index terms, retrieval hints - new system only)

### Storage Strategy

**MVP Approach:** Use OpenCode's existing file-based Storage API directly.

**Design Principle:** Isolate storage interactions to minimize future migration effort.

- Keep storage calls centralized (not scattered throughout Compact/Retrieve logic)
- Avoid filesystem-specific assumptions in business logic (e.g., don't rely on file paths, directory structure)
- Store archived content as self-contained units (ID + content + metadata) rather than relational structures
- If queries become complex, that's a signal to revisit storage backend

**Watch for these warning signs during implementation:**
- Needing to scan/iterate all files to find content
- Building manual indexes alongside stored files
- Complex file naming schemes to enable lookup patterns
- Performance issues with list/filter operations

Any of these would suggest SQLite is warranted for Growth phase.

### Technical Constraints & Dependencies

**Hard Constraints from PRD:**

1. **Use existing Storage API** - File-based JSON storage, not SQLite
2. **Integrate with MessageV2** - Extend existing message architecture for IDs
3. **Existing config system** - Use OpenCode's configuration patterns
4. **MVP: Exact ID lookup only** - No semantic search initially
5. **Append-only checkpoints** - Preserve prompt cache

**Dependencies on Existing Code:**

| Component | Location | Dependency Type |
|-----------|----------|-----------------|
| Storage API | `storage/storage.ts` | Read/write archived content |
| MessageV2 | `session/message-v2.ts` | Add message IDs to context output |
| Tool System | `tool/` | Register Compact/Retrieve tools |
| Config | `config/` | Add compaction mode settings |
| Token Estimation | `util/token.ts` | Calculate checkpoint intervals |
| Session | `session/` | Inject token checkpoints |

### Cross-Cutting Concerns Identified

1. **Message ID Propagation**: IDs must flow from creation through storage, resume, and LLM context display
2. **Storage Integrity**: Archived content must survive crashes, restarts, and session resume
3. **Tool Integration**: Compact/Retrieve tools need consistent patterns with existing tools
4. **Configuration Consistency**: Mode settings must reliably affect LLM autonomous behavior
5. **Context Modification Safety**: Replacing messages with placeholders must not corrupt conversation state
6. **Prompt Cache Awareness**: Modifications must minimize cache invalidation where possible
7. **Coexistence with Existing Compaction**: New placeholders must not interfere with existing pruning logic

## Core Architectural Decisions

### Message Identity

**Decision:** Use existing `msg_xxx` ID format.

- Messages already have unique IDs (`msg_[HEX_TIMESTAMP][RANDOM_BASE62]`)
- IDs already persist across session resume (stored in `storage/message/{sessionID}/{messageID}.json`)
- No new ID infrastructure needed

**ID Visibility:**
- Normal conversation context: IDs NOT visible to LLM (standard AI SDK format)
- Compaction summarization call context: IDs prefixed to text content (`[msg_xxx] message text...`)

### Compaction Architecture

**Decision:** Separate LLM call with ID-annotated context (same pattern as existing compaction).

**Flow:**
1. Main LLM sees context gauge, decides compaction would help
2. Main LLM calls Compact tool with suggested message range
3. Compact tool triggers separate LLM call (like existing `SessionCompaction.process`)
4. This LLM call receives full context via `toModelMessageWithIDs()` (ID-prefixed variant)
5. Compaction LLM analyzes context, generates summary and index terms
6. System marks messages with `archive`/`archivedBy` metadata
7. Main conversation continues with placeholder in place of archived messages

**Rationale:** Follows existing compaction pattern - separate LLM call, not a TaskTool subagent. Simpler implementation, proven pattern.

### Archive Storage Design

**Decision:** Archive metadata on first message, subsequent messages reference via `archivedBy`.

**First message in archived range:**
```typescript
{
  id: "msg_abc",
  parts: [...],  // Original content stays in place
  archive: {
    summary: "Discussed auth architecture with JWT approach...",
    indexTerms: ["auth", "JWT", "security", "token rotation"],
    rangeEnd: "msg_xyz"
  }
}
```

**Subsequent messages in range:**
```typescript
{
  id: "msg_def",
  parts: [...],  // Original content stays in place
  archivedBy: "msg_abc"
}
```

**Rationale:**
- No new storage namespace needed
- Original content never moves or duplicates
- Single archive metadata object per compaction operation
- Retrieval is trivial (content is still there)

### Placeholder Format

**Decision:** `[SMART_ARCHIVED: ...]` format with summary and index terms.

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

**Rationale:** No explicit retrieval instructions in placeholder - the Retrieve tool description teaches the LLM how to use it. `SMART_ARCHIVED` naming helps LLM connect placeholder to tool.

### Token Checkpoints

**Decision:** Stored as permanent message parts with ramping frequency.

**Storage:**
```typescript
{
  id: "prt_xxx",
  messageID: "msg_xxx",
  type: "context-gauge",
  tokenCount: 80000,
  contextLimit: 128000,
  percentage: 62.5
}
```

**Frequency (ramping as context fills):**

| Token Range | Checkpoint Interval | Rationale |
|-------------|---------------------|-----------|
| 0 - 40k | Every 40k | Sparse early, not urgent |
| 40k - 80k | Every 20k | Starting to fill |
| 80k - 100k | Every 10k | Getting full |
| 100k - 120k | Every 5k | Urgent, frequent reminders |

**Rationale:** Append-only (never modified) to preserve prompt cache. Stored permanently so they remain stable across context rebuilds.

### Retrieval Architecture

**Decision:** Simple tool call, returns original content.

- Retrieve tool takes archive ID (the first message ID, e.g., `msg_abc`)
- Tool fetches messages from `msg_abc` to `archive.rangeEnd`
- Returns original `parts` content as tool result
- Content appended to conversation (standard tool result pattern)

**Rationale:** Content never moved from original storage - retrieval just reads and returns it.

### Compaction Summarization Context Format

**Decision:** Prefix message text with `[msg_xxx]` ID.

```typescript
// User message as compaction summarization call sees it
{ type: "text", text: "[msg_abc] Fix the login page" }

// Assistant message as compaction summarization call sees it
{ type: "text", text: "[msg_def] Let me read the file first" }
```

**Implementation:** Variant of `toModelMessage()` that prefixes text content with message IDs.

## Implementation Patterns

### Tool Implementation

Follow existing tool patterns:

| Aspect | Convention | Our Implementation |
|--------|------------|-------------------|
| Files | `tool/[name].ts`, `tool/[name].txt` | `tool/compact.ts`, `tool/compact.txt`, `tool/retrieve.ts`, `tool/retrieve.txt` |
| Tool ID | lowercase string | `"compact"`, `"retrieve"` |
| Export name | `[Name]Tool` | `CompactTool`, `RetrieveTool` |
| Registration | Add to `tool/registry.ts` `all()` function | Add both tools to registry |

### Message Schema Extension

Add optional fields to MessageV2 message schemas:

```typescript
// On first message of archived range
archive: z.object({
  summary: z.string(),
  indexTerms: z.array(z.string()),
  rangeEnd: z.string(),
}).optional()

// On subsequent messages in archived range
archivedBy: z.string().optional()
```

### Context Gauge Part Type

New part type following existing patterns:

```typescript
export const ContextGaugePart = PartBase.extend({
  type: z.literal("context-gauge"),
  tokenCount: z.number(),
  contextLimit: z.number(),
  percentage: z.number(),
}).meta({ ref: "ContextGaugePart" })
```

Add to `Part` discriminated union in `message-v2.ts`.

### Placeholder Formats

All placeholders use square bracket format consistent with existing patterns:

| Type | Format | Example |
|------|--------|---------|
| Existing pruning | `[Old tool result content cleared]` | `[Old tool result content cleared]` |
| Smart archive | `[SMART_ARCHIVED: {id} to {id}]` + summary + index | See below |
| Context gauge | `[CONTEXT GAUGE: {used} / {limit} tokens ({pct}%)]` | `[CONTEXT GAUGE: 45,000 / 100,000 tokens (45%)]` |

**Smart archive placeholder example:**
```
[SMART_ARCHIVED: msg_abc to msg_xyz]
Summary: Discussed auth architecture with JWT approach...
Index: auth, JWT, security, token rotation
```

## Project Structure

### File Additions

```
packages/opencode/src/
├── tool/
│   ├── compact.ts              # NEW: Compact tool implementation
│   ├── compact.txt             # NEW: Compact tool description for LLM
│   ├── retrieve.ts             # NEW: Retrieve tool implementation
│   ├── retrieve.txt            # NEW: Retrieve tool description for LLM
│   └── registry.ts             # MODIFY: Register CompactTool, RetrieveTool
├── session/
│   ├── message-v2.ts           # MODIFY: Add archive, archivedBy fields; ContextGaugePart
│   ├── compaction.ts           # MODIFY: Add context gauge injection logic
│   └── archive-context.ts      # NEW: Sub-agent context builder with ID prefixes
└── config/
    └── config.ts               # MODIFY: Add compaction.mode setting
```

### File Responsibilities

| File | Responsibility |
|------|----------------|
| `tool/compact.ts` | Compact tool: mark messages as archived, generate summary/index |
| `tool/retrieve.ts` | Retrieve tool: fetch original content from archived messages |
| `session/message-v2.ts` | Schema changes for archive metadata and context gauge parts |
| `session/archive-context.ts` | Build ID-annotated context for compaction summarization call |
| `session/compaction.ts` | Context gauge injection at token thresholds |
| `config/config.ts` | User preference for compaction mode (ask/notify/silent) |

## Validation

### Decision Coherence

All architectural decisions work together as a unified system:

| Decision | Supports | Dependencies |
|----------|----------|--------------|
| Existing `msg_xxx` IDs | Archival references, retrieval | None (already exists) |
| Archive metadata on first message | Storage efficiency, retrieval | Message IDs |
| `archivedBy` references | Range tracking | First message archive |
| Separate LLM call for compaction | Summary generation, ID annotation | Message ID visibility |
| Context gauge parts | LLM awareness of capacity | Token estimation |
| `[SMART_ARCHIVED]` placeholder | LLM-tool connection | Archive metadata |

### Requirements Coverage

**Functional Requirements (22 FRs):**

| Category | FRs | Architecture Support |
|----------|-----|---------------------|
| Message Identity | FR1-FR2 | ✅ Existing `msg_xxx` IDs, already persisted |
| Context Visibility | FR3-FR5 | ✅ Context gauge parts with ramping frequency |
| Compaction | FR6-FR13 | ✅ Compact tool, archive metadata, placeholder format |
| Retrieval | FR14-FR16 | ✅ Retrieve tool, content stays in original storage |
| Configuration | FR17-FR20 | ✅ Config extension for compaction mode |
| Persistence | FR21-FR22 | ✅ Archive metadata persists with messages |

**Non-Functional Requirements (8 NFRs):**

| NFR | Architecture Support |
|-----|---------------------|
| NFR1: Tool system integration | ✅ Standard Tool.define() pattern |
| NFR2: Storage API integration | ✅ Uses existing message storage |
| NFR3: Config system integration | ✅ Extends existing config patterns |
| NFR4: MessageV2 integration | ✅ Schema extension with archive fields |
| NFR5: Atomic operations | ✅ Single message update marks archive |
| NFR6: No data loss | ✅ Original content never moved/deleted |
| NFR7: Exact retrieval | ✅ Content unchanged in storage |
| NFR8: Valid references | ✅ `archivedBy` points to existing message |

### Implementation Readiness

- **Clear file locations**: All new/modified files specified
- **Follows existing patterns**: Tool registration, message schemas, config extension
- **Minimal new infrastructure**: Reuses existing storage, IDs, compaction patterns
- **Proven approach**: Separate LLM call matches existing compaction implementation
