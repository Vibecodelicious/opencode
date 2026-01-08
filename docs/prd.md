---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
inputDocuments:
  - "docs/index.md"
  - "docs/context-management-analysis.md"
  - "docs/technology-stack.md"
workflowType: 'prd'
lastStep: 11
project_name: 'opencode_context_management'
user_name: 'Basil'
date: '2025-12-03'
---

# Product Requirements Document - opencode_context_management

**Author:** Basil
**Date:** 2025-12-03

## Executive Summary

OpenCode currently implements context management through automatic pruning and compaction, but suffers from catastrophic compaction events that permanently lose critical context. When the context window fills up, the system replaces old content with generic placeholders like "[Old tool result content cleared]", forcing users to either start fresh conversations or manually re-add lost context. This results in degraded LLM performance, confusion, and broken autonomous operation.

This feature introduces **Intelligent Context Compaction with Retrieval** - a dual-tool system that transforms how OpenCode manages context across long-running sessions. Instead of permanently discarding content, the system archives it to a local indexed datastore with semantic metadata, leaving behind intelligent placeholders that enable autonomous retrieval when needed.

**The feature consists of two LLM-callable tools:**

1. **Compact Tool**: Invoked by user command or autonomous LLM decision when content is voluminous, distracting, or better suited for archival. Uses the full context to generate summaries, extract semantic index terms, store original content locally, and create smart placeholders with retrieval hints.

2. **Retrieve Tool**: Enables the LLM to autonomously fetch archived content when it detects relevance. Supports multiple retrieval methods (exact ID lookup, term search, semantic search - to be evaluated for complexity and implemented incrementally).

**Key technical constraint:** Prompt cache invalidation occurs when context is modified (not append-only). Compaction triggers must evaluate whether token savings exceed cache invalidation costs, ensuring clear net benefit before executing.

### What Makes This Special

**1. Focused Context = Better Responses**
Active context remains clean and relevant throughout the conversation. The LLM isn't distracted by stale logs, old tool outputs, or tangential discussions, leading to higher-quality responses aligned with current objectives.

**2. No Catastrophic Compaction Events**
Unlike current batch compaction that creates "amnesia moments," this system provides granular, intelligent compaction throughout the session. Critical context is never permanently lost - it's archived with rich metadata and remains retrievable. Users never have to start over or manually reconstruct lost context.

**3. Extended Autonomous Operation**
The LLM can operate coherently across much longer sessions without:
- Getting confused by context overflow
- Going off-track due to missing constraints
- "Forgetting" important instructions or requirements
- Requiring constant user intervention to re-establish context

**4. LLM as Active Context Manager**
The LLM becomes an intelligent participant in its own context management, autonomously deciding what to archive and when to retrieve based on conversation dynamics and relevance signals.

**5. Cache-Aware Performance**
Smart compaction logic respects prompt caching economics, only triggering when benefits clearly outweigh cache invalidation costs. This prevents cache thrashing and maintains cost efficiency.

## Project Classification

**Technical Type:** Developer Tool Enhancement (CLI Feature)
**Domain:** AI/ML Tooling / Developer Productivity
**Complexity:** Medium

This feature enhances OpenCode's existing CLI tool with sophisticated AI-powered context management. While technically complex (involving LLM integration, semantic indexing, local storage, and cache economics), it doesn't involve regulatory compliance, safety-critical systems, or high-risk domains.

**Complexity drivers:**
- Multi-modal LLM integration (summarization, term extraction, semantic search)
- Local datastore with semantic indexing
- Autonomous decision-making for compaction timing
- Cache invalidation economics and benefit calculation
- Tool integration within existing OpenCode architecture

**Technical considerations:**
- Storage technology selection (SQLite, vector DB, or hybrid)
- Retrieval method complexity vs. value analysis
- User configuration system for autonomous behavior preferences
- Integration with existing message architecture (adding message IDs)
- Performance impact on context processing pipeline

## Success Criteria

### User Success

Users experience success when they can:

1. **Complete complex tasks in continuous sessions** - Work through multi-step problems without having to restart conversations or manually re-establish context
2. **Never experience "amnesia moments"** - The LLM maintains coherence and doesn't "forget" critical instructions, constraints, or prior work
3. **Work for extended periods** - Engage in long-running collaborative sessions (hours) without manual context management
4. **Get faster responses** - Benefit from reduced latency as smaller active context means quicker LLM API responses (latency scales with context size)
5. **Trust retrieval when needed** - When the LLM autonomously retrieves archived content, it's accurate and relevant to the current task

The "aha!" moment: The LLM retrieves something the user thought was lost, and it's exactly what was needed to continue progress.

### Business Success

While we won't build measurement infrastructure, conceptual success indicators include:

**At 3 months:**
- Feature is stable and adopted by active OpenCode users
- Session lengths increase (users staying in conversations longer)
- Reduced "abandoned session" rate (users don't restart as often)

**At 12 months:**
- This becomes a key differentiator mentioned in community discussions
- Measurable cost savings for users through reduced redundant token usage
- Feature influences design patterns in other AI coding tools

### Technical Success

The feature achieves technical success when:

1. **Message ID System**
   - All messages (user, LLM, system) have unique, stable IDs
   - IDs remain stable when sessions are resumed (critical for long-term retrieval references)

2. **Compact Tool Reliability**
   - Successfully archives content to local datastore without data loss
   - Generates accurate summaries with helpful index terms
   - Creates intelligent placeholders with retrieval hints
   - Respects cache invalidation economics (only compacts when token savings exceed cache invalidation costs)

3. **Retrieve Tool Functionality**
   - Retrieval method (TBD based on complexity analysis) works reliably
   - Fetched content is correctly restored to active context
   - No data corruption or retrieval failures

4. **Configuration System**
   - User can configure autonomous compaction preferences
   - Permission/notification settings apply correctly to LLM behavior

### Measurable Outcomes

Observable indicators that validate the feature is working:

**User-visible behaviors:**
- User compacts a message range → sees archived confirmation and placeholder in conversation
- Placeholder tokens display summaries and retrieval hints
- LLM autonomously retrieves archived content when contextually relevant
- Context window remains lean (doesn't hit overflow as quickly as before)
- Response times improve with smaller active context

**Testable operations:**
- Compact tool: Input (message range) → Output (placeholder + content in local DB)
- Retrieve tool: Input (ID/terms) → Output (original content restored to context)
- Configuration: Settings correctly modify autonomous compaction behavior
- Cache awareness: Compaction only triggers when net benefit is positive

## Product Scope

### MVP - Minimum Viable Product

**Core functionality required for useful operation:**

1. **Message ID Infrastructure**
   - Unique, stable IDs assigned to all messages
   - ID persistence across session resume

2. **Token Utilization Checkpoints**
   - Insert checkpoint message every ~10,000 tokens
   - Format: `[CONTEXT CHECKPOINT: X / Y tokens used (Z%)]`
   - Append-only (never remove/modify previous checkpoints to preserve prompt cache)
   - Enables LLM to make informed spontaneous compaction decisions

3. **Compact Tool**
   - User-directed invocation (e.g., "compact msg-user-1234 to msg-llm-1567")
   - LLM-autonomous invocation when detecting voluminous/distracting content
   - LLM-powered summarization using full context
   - Semantic index term generation
   - Local datastore storage (use OpenCode's existing file-based storage system)
   - Intelligent placeholder creation with retrieval hints

4. **Retrieve Tool - Basic Implementation**
   - Exact ID lookup (simplest retrieval method)
   - Content restoration to active context
   - No data loss or corruption

5. **Configuration System**
   - User settings for autonomous compaction behavior
   - Permission preferences (ask/notify/silent)

### Growth Features (Post-MVP)

**Enhancements that improve competitiveness and user experience:**

1. **Advanced Retrieval Methods**
   - Term search (query by index keywords)
   - Semantic search (query by conceptual relevance)
   - Evaluate complexity vs. value for each method before implementation

2. **Enhanced Indexing**
   - Improved term extraction algorithms
   - Rich metadata capture
   - Better search result ranking

3. **Smarter Placeholders**
   - Context-aware summary generation
   - More helpful retrieval hints
   - Visual indicators in UI

4. **User Management Tools**
   - Browse archived content
   - Manual compaction controls
   - Archive statistics and insights

5. **Background Compaction Processing**
   - Compaction decision-making runs asynchronously in the background
   - Summarization and index term generation happen without blocking user interaction
   - User experiences uninterrupted workflow while compaction work proceeds
   - Notification when background compaction completes (if in Notify mode)

6. **Compaction Rate Limiting**
   - User settings to limit compaction frequency
   - Prevent over-aggressive autonomous compaction
   - Cache economics optimization (only compact when benefit exceeds cache invalidation cost)

### Technical Debt / Maintainability

- **Renderer deduplication for model messages**: Refactor `toModelMessage` and `toModelMessageWithIDs` to share a single renderer with options (e.g., `includeIds`, `includeAllParts`) so the compaction context stays in sync with the primary renderer. Maintain parity with current `toModelMessage` behavior for the default path and the ID+full-parts contract for compaction. Add test coverage for both modes, including tool completed/error states and the extended part types, with guards preventing unscoped `part.state` access.

### Vision (Future)

**Long-term aspirational capabilities:**

1. **Full Semantic Search**
   - Embedding-based retrieval
   - Conceptual similarity matching
   - Ranked relevance scoring

2. **Cross-Session Knowledge**
   - Search across all user's OpenCode sessions
   - Knowledge graph of related concepts
   - Pattern recognition across projects

3. **Proactive Optimization**
   - LLM predicts optimal compaction timing before overflow
   - Adaptive strategies based on conversation patterns
   - Machine learning for compaction quality improvement

4. **Analytics & Insights** *(if measurement becomes valuable later)*
   - Compaction efficiency metrics
   - Cache hit rate tracking
   - Cost savings calculations

## User Journeys

### Journey 1: Alex Chen - The Uninterrupted Refactoring Session

Alex is a senior developer refactoring the authentication system in a legacy Node.js application. It's Tuesday afternoon, and they've been working with OpenCode for three hours, carefully reviewing authentication files, discussing security implications, and planning the migration strategy. The context is rich with file contents, architectural decisions, and security constraints they've discussed.

Just as they're about to start updating the database schema, OpenCode's context window fills up. The old system does a catastrophic compaction - suddenly the LLM "forgets" the authentication architecture they spent an hour discussing. When Alex asks a follow-up question about session expiration, the LLM gives a generic answer that contradicts their earlier security decisions. Frustrated, Alex has to either restart the conversation or spend 20 minutes re-explaining the authentication context.

**With Intelligent Compaction:**

The same Tuesday afternoon, same refactoring session. As Alex moves from authentication to database work, the LLM autonomously recognizes that the 6,200 lines of authentication code (and the hour-long architecture discussion) aren't immediately needed for schema updates.

Instead of catastrophic compaction, the LLM smoothly archives those 15,000 tokens with a smart placeholder: "Authentication module analysis (session.ts, jwt-handler.ts, oauth-flow.ts) - Discussed: stateless JWT approach, 30-min expiration, refresh token rotation strategy. Retrieve: 'auth', 'session', 'security constraints', msg-45 to msg-78"

Alex continues working on the database schema, getting fast responses from a lean context. Two hours later, they need to update session storage and ask: "How does the current session expiration work?"

The LLM sees the placeholder, autonomously retrieves the archived authentication discussion, and answers: "Based on our earlier analysis, you're using 30-minute JWT expiration with refresh token rotation. Here's how that impacts your session table schema..." - perfectly aligned with their earlier decisions.

Alex completes the entire refactoring in one continuous 6-hour session. No restarts, no context amnesia, no manual re-explanation. The breakthrough: realizing they can work indefinitely without fighting the context window.

### Journey 2: Sam Rivera - Taking Control of the Automation

Sam is a meticulous developer who's heard about OpenCode's new intelligent compaction from a colleague. They're excited about the concept - no more context amnesia - but Sam likes to understand exactly what's happening in their tools before trusting them completely.

On their first day using the new feature, Sam is debugging a complex distributed systems issue. They're deep in conversation with the LLM about race conditions when suddenly they notice something different in the chat history. A block of their earlier discussion about database transactions has been replaced with a placeholder: "Database transaction discussion archived (msg-12 to msg-34)..."

Sam freezes. "Wait, what just happened? Did I lose that content? Can I get it back?" They're not angry, just confused - the LLM made an autonomous decision without asking permission first.

**The Configuration Discovery:**

Sam checks the documentation and discovers there are three autonomous compaction modes:

1. **Ask First** - LLM requests permission before compacting
2. **Notify** - LLM compacts and notifies what was archived
3. **Silent** - LLM handles it autonomously, logs only

Sam chooses "Ask First" and continues debugging. Twenty minutes later, the LLM interrupts: "I'd like to compact messages 45-67 (4,500 tokens of stack traces from earlier) to save context and improve response speed. These traces are still retrievable if needed. Proceed?"

Sam reviews what would be archived, sees it's old error logs no longer relevant, and approves. The compaction happens, and Sam sees the intelligent placeholder with clear retrieval hints.

Over the next few weeks, Sam learns which types of content they trust the LLM to auto-compact. They switch to "Notify" mode - getting a quick confirmation of what was archived without interrupting their flow. Three months later, Sam trusts the system enough to use "Silent" mode for most sessions, only switching to "Ask First" when working on critical production issues.

The breakthrough: Sam realizes that transparency + control = trust. They get all the benefits of intelligent compaction while maintaining exactly the level of oversight they need for each situation.

### Journey 3: Jordan Park - The Long-Term Memory Effect

Jordan is a freelance developer working on a client's e-commerce platform redesign. The project spans three weeks, and Jordan uses OpenCode for architecture decisions, code reviews, and implementation guidance. Unlike a typical coding session, this is an ongoing conversation across many days.

**Week 1:** Jordan and the LLM have extensive discussions about the payment processing architecture. They analyze PCI compliance requirements, debate different payment gateway integrations, and settle on a specific approach with Stripe. The conversation includes detailed security constraints and edge case handling (messages 150-178). By the end of the week, this architectural discussion has been intelligently compacted and archived with the placeholder: "Payment architecture discussion (msg-user-150 to msg-llm-178) - Discussed: PCI compliance, Stripe integration approach, token handling security. Retrieve: 'PCI', 'payment security', 'compliance'"

**Week 2:** Jordan focuses on the frontend shopping cart implementation. The payment architecture discussion isn't relevant right now, so it stays archived. Jordan's context remains lean and focused on UI components, state management, and user flows.

**Week 3 - Friday afternoon:** Jordan is implementing the final checkout flow and needs to reference the payment architecture decisions. They type: "What were our PCI compliance constraints for payment handling?"

The LLM sees the archived placeholder from Week 1, recognizes the semantic match, autonomously retrieves the archived message range (messages 150-178), and responds: "Based on our Week 1 discussion, you specified that payment tokens must never touch your server. This implementation stores them temporarily in session state, which violates that constraint."

Jordan fixes the issue, avoiding a potential security problem. The breakthrough: realizing that conversations with OpenCode can have long-term memory spanning weeks, with precise retrieval when needed.

**Three months later:** Jordan returns to the project for a feature addition. They open the original session, see placeholders from their work months ago, and can retrieve specific architectural decisions by semantic query or message ID range. It's like having perfect recall of every technical decision ever made.

### Journey Requirements Summary

These three journeys reveal the following capability requirements:

**Core Compaction & Storage:**
- Message ID system with stable IDs across session resume
- Autonomous compaction logic (LLM decides when to archive based on relevance)
- Smart placeholder generation with summaries and retrieval hints
- Local datastore with long-term persistence (weeks/months)
- Cache-aware benefit calculation before compacting

**Retrieval Capabilities:**
- Semantic/term-based retrieval (query by keywords like "PCI", "auth")
- ID-based retrieval (retrieve specific message or range)
- Autonomous LLM retrieval when context is needed
- Seamless content restoration to active context
- Content integrity over time (no degradation)

**Configuration & Control:**
- Multiple autonomous modes: Ask First, Notify, Silent
- Permission/approval workflow for compaction requests
- Clear notification system showing what was archived
- User ability to switch between modes based on context
- Documentation explaining configuration options

**User Experience:**
- Placeholder visibility in conversation history
- Clear indication of archived content ranges
- Retrieval hints embedded in placeholders
- Fast response times from lean context
- No data loss or corruption

## Innovation & Novel Patterns

### Core Innovation: LLM as Active Context Manager

Traditional context management treats the LLM as a passive recipient - external systems decide what context to include, prune, or summarize. This feature inverts that paradigm: the LLM becomes an active participant in managing its own context window.

**What makes this novel:**
- The LLM decides *when* content should be compacted based on relevance to current work
- The LLM decides *when* to retrieve archived content based on conversation dynamics
- The LLM generates its own retrieval hints, creating placeholders it can later act upon

This is self-referential context management - the LLM is aware of its own context limitations and actively works to optimize them.

### Supporting Innovation: Actionable Placeholders

Placeholders aren't just summaries - they're retrieval instructions. Each placeholder contains:
- Summary of archived content
- Semantic index terms for matching future queries
- Message ID ranges for precise retrieval

This creates a feedback loop: the LLM generates placeholders that its future self can interpret and act upon.

### Validation Approach

- **Proof of concept:** Can the LLM reliably identify when to compact? Does it make good autonomous decisions?
- **Retrieval accuracy:** When the LLM retrieves archived content, is it the right content for the current context?
- **User trust:** Do users trust the LLM's autonomous compaction decisions? (Hence the Ask First/Notify/Silent modes)

### Risk Mitigation

- **Bad compaction decisions:** Archived content is never deleted - retrieval is always possible even if timing was wrong
- **Retrieval failures:** Exact ID lookup as MVP ensures reliable retrieval before adding complexity of semantic search
- **User distrust:** Configuration modes (Ask First → Notify → Silent) let users build trust gradually

## CLI Tool Specific Requirements

### Tool Invocation

The Compact and Retrieve tools support dual invocation methods:

**User-Directed (Slash Commands):**
- `/compact msg-123 to msg-456` - Explicit message range compaction
- `/retrieve msg-123` - Explicit retrieval by ID

**User-Directed (Natural Language):**
- "Compact everything we discussed about authentication"
- "Get back that earlier discussion about the API design"

**LLM-Autonomous:**
- LLM invokes Compact/Retrieve tools via structured tool calls (same interface as other OpenCode tools)

### Output & Display

**MVP - Raw Placeholder Display:**
- Compacted content is replaced with placeholder text in the conversation
- User sees exactly what the LLM sees - no special UI treatment
- Placeholder includes: summary, semantic index terms, message ID range, retrieval instructions

**Example placeholder as it appears in conversation:**
```
[COMPACTED: Authentication architecture discussion (msg-45 to msg-78)
Summary: Discussed stateless JWT approach with 30-min expiration and refresh token rotation.
Index terms: auth, session, JWT, security, token rotation
To retrieve: use the retrieve tool with message_ids: [msg-45:msg-78]
or search_terms: ["authentication", "session security"]]
```

*Note: Exact parameter names (message_ids, search_terms, etc.) to be defined in architecture phase.*

**Growth - Enhanced TUI Element:**
- Custom expand/collapse UI component
- Summary and statistics display
- Visual distinction from regular messages

### Configuration Integration

Autonomous compaction mode settings integrate with OpenCode's existing configuration system:

- `compaction.mode`: "ask" | "notify" | "silent"
- `compaction.enabled`: boolean (default: true)

### SDK/API Exposure

Deferred to architecture phase.

## Scoping Decisions

### MVP Strategy

**Approach:** Problem-Solving MVP - solve the core problem (catastrophic compaction) with minimal features.

**Key Scoping Decisions Made:**

1. **Storage:** Use OpenCode's existing file-based storage system (not SQLite) for consistency with codebase patterns. SQLite/vector DB deferred to Growth phase when advanced search is needed.

2. **Token Visibility:** Added Token Utilization Checkpoints as MVP requirement. Append-only checkpoints every ~10k tokens give the LLM visibility into context fullness for informed compaction decisions.

3. **LLM Decision-Making:** LLM decides spontaneously when to compact based on:
   - Token utilization checkpoints
   - Content volume and relevance
   - Tool description guidance

   No complex cache economics calculation in MVP.

4. **Retrieval:** MVP supports exact ID lookup only. Term search and semantic search deferred to Growth phase with complexity evaluation.

5. **Rate Limiting:** Deferred to Growth. MVP allows LLM and user to compact freely; controls for limiting frequency added later.

### Risk Mitigation

**Technical Risk:** Novel LLM self-management paradigm
- *Mitigation:* Start with user-directed compaction, validate LLM autonomous decisions work before relying on them

**Adoption Risk:** Users may not trust autonomous compaction
- *Mitigation:* Configuration modes (ask/notify/silent) let users build trust gradually

**Data Integrity Risk:** Compacted content must be retrievable
- *Mitigation:* Exact ID lookup as MVP ensures reliable retrieval; file-based storage matches proven OpenCode patterns

## Functional Requirements

### Message Identity

- FR1: System assigns unique, stable IDs to all messages (user, LLM, tool)
- FR2: Message IDs persist when sessions are resumed
- FR23: Message IDs are hidden from LLM during normal conversation by default
- FR24: Compact tool can enable message ID visibility via a session flag (two-phase compaction)

### Context Visibility

- FR3: System inserts token utilization checkpoints every ~10,000 tokens
- FR4: Token checkpoints are append-only (never modified after insertion)
- FR5: LLM can see token utilization checkpoints in conversation context

### Compaction

- FR6: User can compact a message range via slash command
- FR7: User can compact via natural language request
- FR8: LLM can autonomously decide to compact content
- FR9: Compaction generates a summary of archived content
- FR10: Compaction generates semantic index terms for archived content
- FR11: Compaction stores original content to persistent storage
- FR12: Compaction replaces original messages with placeholder in conversation
- FR13: Placeholder displays summary, index terms, message range, and retrieval instructions

### Retrieval

- FR14: User can retrieve archived content by message ID
- FR15: LLM can autonomously retrieve archived content when relevant
- FR16: Retrieved content is appended to conversation context (as tool call result)

### Configuration

- FR17: User can configure compaction mode (ask/notify/silent)
- FR18: In "ask" mode, LLM requests permission before compacting
- FR19: In "notify" mode, LLM notifies user after compacting
- FR20: In "silent" mode, LLM compacts without notification

### Persistence

- FR21: Archived content persists across session resume
- FR22: Archived content maintains data integrity over time

## Non-Functional Requirements

### Integration

- NFR1: Compact/Retrieve tools integrate with OpenCode's existing tool system
- NFR2: Storage uses OpenCode's existing file-based Storage API
- NFR3: Configuration integrates with OpenCode's existing config system
- NFR4: Message IDs integrate with existing MessageV2 architecture

### Reliability / Data Integrity

- NFR5: Archived content is never lost due to system errors
- NFR6: Retrieval returns exact original content (no corruption)
- NFR7: Placeholders maintain valid references to archived content
- NFR8: Storage operations are atomic (no partial writes)

## Development Findings (Not Current Requirements — Future Consideration)

The following items were observed during implementation. They are **not** part of this PRD's requirements and are recorded only to guide potential future improvement work:

- Auto ask-mode consent can be inferred from any subsequent user message containing "yes/ok," even if unrelated, which could trigger unexpected auto compaction (SessionPrompt approval parsing).
- CLI flags only disable auto compaction (`--disable-autocompact`) and cannot re-enable it when config sets `compaction.enabled` false, limiting run-level overrides.
- Tests cover config and environment overrides but do not exercise the CLI override path (`--compaction-mode`, `--disable-autocompact`), leaving that flow unverified.
- **Compaction summary display**: The compaction summary is currently shown via LLM response text rather than tool output. The tool should display the summary directly to the user for consistent UX.
- **Message ID placement in TUI**: ~~Message IDs are currently shown at the start of message content. For user messages, the ID should appear next to the username/timestamp metadata line. For assistant messages, a similar metadata line treatment should be added for visual consistency.~~ **Addressed by Story 5.5** - IDs will be right-aligned in footer/metadata areas.

### Bugs Discovered During Testing (Addressed by Stories 5.6, 5.7)

- **TUI corruption with Claude Opus 4.5**: When using Claude Opus 4.5 model, raw output (API responses, JSON structures) bleeds into the TUI during compaction, corrupting the display. Does not occur with BigPickle model. Likely caused by new compaction code not following OpenCode's established logging/output patterns. **Addressed by Story 5.6.**

- **Archive metadata not stored (DATA LOSS)**: Compaction reports success but fails to store summary and index terms with Claude Opus 4.5. Retrieve tool reports "No summary generated" and original content becomes inaccessible. This is a violation of NFR5 (no data loss), NFR6 (exact retrieval), and NFR8 (atomic operations). Likely shares root cause with TUI corruption - LLM response not being captured correctly. **Addressed by Story 5.7.**

## Backlog

### Code Quality Issues

- **Context gauge code incorrectly placed in compaction.ts**: The context gauge feature (`injectContextGauge`, `shouldTriggerContextGauge`, `getHighestGaugePercent`, `createContextGaugePart`, etc.) was added to `packages/opencode/src/session/compaction.ts`, but this is the wrong location. The gauge injection is called from `prompt.ts` after every assistant response during normal conversation flow - it has nothing to do with auto-compaction (`SessionCompaction.process()`). Additionally, the `process()` function was incorrectly rewritten to use `streamText` directly instead of the upstream `processor.process()` interface, duplicating logic. The file should match `upstream/dev` exactly. The context gauge code should be moved to its own file (e.g., `context-gauge.ts`) or kept inline in `prompt.ts` where it's actually used.
