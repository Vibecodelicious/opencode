# Story 3.1: Retrieve Tool Implementation

Status: Done

## Story

As a user,
I want to retrieve archived content by its archive ID,
So that I can access original content when needed.

## Acceptance Criteria

1. **Basic Retrieval by Archive ID**
   - Given content has been archived with ID `msg_abc` and has `archive` field
   - When the Retrieve tool is called with `{ archiveId: "msg_abc" }`
   - Then the tool finds the message with matching ID and `archive` field
   - And collects all messages from `msg_abc` to `archive.rangeEnd`
   - And returns original content as tool result

2. **Return Format**
   - Given a successful retrieval
   - When the content is returned
   - Then it includes header: `Retrieved content from archive msg_abc to msg_xyz:`
   - And original message contents are included with message IDs for reference
   - And the format is readable by the LLM

3. **Error Handling - Invalid Archive ID**
   - Given an archive ID that doesn't exist or doesn't have `archive` field
   - When the Retrieve tool is called
   - Then a clear error message is returned
   - And no partial data is returned

4. **Archive Metadata Preservation**
   - Given a successful retrieval
   - When the content is returned
   - Then archive metadata remains in place on messages (retrieval is non-destructive)
   - And the archived messages still render as placeholders in `toModelMessage()`

5. **Standard Tool Result Pattern**
   - Given a successful retrieval
   - When the content is returned
   - Then it follows standard tool result format (`title`, `output`, `metadata`)
   - And retrieved content is appended to context as standard tool result

## Tasks / Subtasks

- [x] Task 1 (AC: 1): Implement archive lookup logic
  - [x] Subtask 1.1: Import Session and MessageV2 modules for message access
  - [x] Subtask 1.2: Create function to find archive anchor by ID (message with `archive` field)
  - [x] Subtask 1.3: Collect all messages in range from anchor to `archive.rangeEnd`
  - [x] Subtask 1.4: Handle single-message archives (rangeEnd equals anchor ID)

- [x] Task 2 (AC: 2): Format retrieved content for LLM readability
  - [x] Subtask 2.1: Create header with archive ID range
  - [x] Subtask 2.2: Format each message with its ID prefix (`[msg_xxx]`)
  - [x] Subtask 2.3: Extract text content from message parts
  - [x] Subtask 2.4: Handle tool parts with completed outputs
  - [x] Subtask 2.5: Ensure output is readable and useful for LLM context

- [x] Task 3 (AC: 3): Implement error handling
  - [x] Subtask 3.1: Return error for non-existent message ID
  - [x] Subtask 3.2: Return error for message without `archive` field (not an anchor)
  - [x] Subtask 3.3: Handle edge case: rangeEnd message doesn't exist (broken reference)
  - [x] Subtask 3.4: Clear error messages that help user understand what went wrong

- [x] Task 4 (AC: 4, 5): Integrate as proper tool
  - [x] Subtask 4.1: Update execute function with full implementation (replace stub)
  - [x] Subtask 4.2: Return proper title, output, and metadata
  - [x] Subtask 4.3: Include token estimate in metadata for user visibility

- [x] Task 5: Update tool description
  - [x] Subtask 5.1: Update `retrieve.txt` with proper usage instructions
  - [x] Subtask 5.2: Remove "(not yet implemented)" from compact.txt retrieval hint

- [x] Task 6: Testing
  - [x] Subtask 6.1: Test successful single-message retrieval
  - [x] Subtask 6.2: Test successful range retrieval (multiple messages)
  - [x] Subtask 6.3: Test error cases (invalid ID, not an anchor, broken rangeEnd)
  - [x] Subtask 6.4: Verify archive metadata is not modified after retrieval
  - [x] Subtask 6.5: All existing tests still pass

## Dev Notes

### Implementation Complete

The retrieve tool is fully implemented in `packages/opencode/src/tool/retrieve.ts` with:
- Archive lookup via `getMessage()` helper
- Range collection via `collectMessagesInRange()`
- Content formatting with message IDs via `formatMessage()` and `formatRetrievedContent()`
- Token estimation via `estimateTokensForMessages()`
- Comprehensive error handling for all edge cases

### Technical Implementation Guide

**Message Structure (from message-v2.ts):**

The Archive schema is already defined:
```typescript
export const Archive = z.object({
  summary: z.string(),
  indexTerms: z.array(z.string()),
  rangeEnd: z.string(),
})
```

Messages have optional archive fields on Base:
```typescript
const Base = z.object({
  id: z.string(),
  sessionID: z.string(),
  archive: Archive.optional(),      // On anchor (first message)
  archivedBy: z.string().optional(), // On subsequent messages
})
```

**Accessing Messages (use existing patterns from compact.ts):**

```typescript
// Get single message
const message = await MessageV2.get({ sessionID, messageID: archiveId })

// Get all session messages
const allMessages = await Session.messages({ sessionID: ctx.sessionID })
```

**Collecting Range Messages:**

```typescript
// Given anchor message with archive field:
const anchor = await getMessage(sessionID, archiveId)
if (!anchor.info.archive) {
  throw new Error(`Message ${archiveId} is not an archive anchor`)
}

const rangeEnd = anchor.info.archive.rangeEnd
const messagesInRange = allMessages.filter(
  (m) => m.info.id >= archiveId && m.info.id <= rangeEnd
)
```

**Formatting Content (follow patterns from archive-context.ts):**

Look at `toModelMessageWithIDs()` for content formatting patterns:
- Text parts: include text content
- Tool parts with completed status: include output
- Reasoning parts: include with `[Reasoning]` prefix (per archive-context.ts pattern)
- Step parts: skip (metadata, not content)

**Token Estimation (reuse from compact.ts):**

```typescript
import { Token } from "../util/token"

function estimateTokensForMessages(messages: MessageV2.WithParts[]): number {
  let totalText = ""
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "text" && "text" in part) {
        totalText += part.text
      }
      if (part.type === "tool" && part.state?.status === "completed" && part.state.output) {
        totalText += part.state.output
      }
    }
  }
  return Token.estimate(totalText)
}
```

### File Locations

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/opencode/src/tool/retrieve.ts` | Modify | Replace stub with full implementation |
| `packages/opencode/src/tool/retrieve.txt` | Modify | Update tool description for LLM |
| `packages/opencode/src/tool/compact.txt` | Modify | Remove "(not yet implemented)" from retrieval hint |
| `packages/opencode/test/tool/retrieve.test.ts` | Add | Test retrieval functionality |

### Output Format Example

```
Retrieved content from archive msg_abc to msg_xyz:

[msg_abc] User message:
Fix the login page authentication issue

[msg_def] Assistant message:
Let me read the auth.ts file first to understand the current implementation...

[msg_ghi] Tool result (Read):
// auth.ts content...

[msg_xyz] Assistant message:
Based on my analysis, the issue is in the token validation...
```

### Reference Implementation Pattern

Follow the existing tool patterns from compact.ts:

```typescript
export const RetrieveTool = Tool.define("retrieve", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    // 1. Validate archiveId exists and has archive field
    // 2. Collect messages in range
    // 3. Format content with IDs
    // 4. Return standard tool result
    return {
      title: "Retrieved archived content",
      output: formattedContent,
      metadata: {
        archiveId: params.archiveId,
        rangeEnd: archive.rangeEnd,
        messageCount: messagesInRange.length,
        tokenEstimate: tokenCount,
      },
    }
  },
  formatValidationError(error) {
    const details = error.issues.map((issue) => issue.message).join("; ")
    return `Invalid retrieve input: ${details}`
  },
})
```

### Project Structure Notes

- Source files: `packages/opencode/src/tool/`
- Test files: `packages/opencode/test/tool/`
- Follow existing test patterns from `compact-archival.test.ts` and `compact-persistence.test.ts`

### Previous Story Learnings (Story 2.7)

**Orphan Handling:**
- Messages can have orphaned `archivedBy` references (anchor doesn't exist)
- `toModelMessage()` handles this gracefully - renders normally instead of skipping
- `validateArchiveReferences()` can detect orphans if needed

**Storage Patterns:**
- Use `MessageV2.get()` for single message lookup
- Use `Session.messages()` for all messages (returns `MessageV2.WithParts[]`)
- `Storage.update()` provides atomic updates (not needed for retrieve - read-only)

**Test Patterns from Story 2.7:**
```typescript
// Create test archive using helper
async function setupArchiveMetadata(sessionID: string, anchorId: string, rangeEnd: string, summary: string, indexTerms: string[]) {
  await Storage.update<MessageV2.Info>(["message", sessionID, anchorId], (draft) => {
    draft.archive = { summary, indexTerms, rangeEnd }
  })
  // Mark subsequent messages...
}
```

### Critical Guardrails

1. **Retrieval is READ-ONLY**: Never modify archive metadata during retrieval
2. **Follow existing patterns**: Use compact.ts as the primary reference
3. **Test all edge cases**: Invalid ID, not an anchor, broken rangeEnd
4. **Token estimation**: Include in metadata for user awareness
5. **Error messages**: Clear and actionable for both user and LLM

### Testing Standards

From project-context.md:
- Write tests in `packages/opencode/test/tool/`
- Use `bun:test` framework
- Cover happy path, edge cases, and error conditions
- All tests must pass before marking task complete
- Run: `bun test:no_external_deps` from repo root

## Definition of Done

- [x] Retrieve tool returns original content from archived messages
- [x] Content formatted with message IDs for LLM readability
- [x] Invalid archive IDs return clear error messages
- [x] Archive metadata remains intact after retrieval
- [x] Tool description (retrieve.txt) explains usage clearly
- [x] Compact.txt updated to remove "(not yet implemented)" hint
- [x] All new tests pass
- [x] All existing tests pass (no regressions)
- [x] Code follows existing patterns from compact.ts

## Risk Notes

1. **Large Archive Performance**: Retrieving very large archives (many messages) could be slow. MVP accepts this; consider pagination for Growth phase if needed.

2. **Message Ordering**: Messages are filtered by ID range using lexicographic comparison. This works because message IDs are time-sortable (ascending format).

3. **Broken References**: If `rangeEnd` points to a non-existent message, we should return an error rather than partial content to maintain data integrity expectations.

4. **Content Format**: The formatted output must be useful for the LLM to understand context. Test with real archive content to verify readability.

## References

- Architecture: Retrieval Architecture (docs/architecture.md:226-234)
- PRD: FR14 (user retrieve by ID), FR15 (LLM autonomous retrieval), FR16 (content appended to context)
- PRD: NFR6 (exact retrieval - no corruption)
- Story 1.6: Tool Registration Setup - established retrieve stub
- Story 2.3: Archive Metadata Storage - created archive/archivedBy structure
- Story 2.7: Data Integrity - reference validation patterns
- Existing implementation: packages/opencode/src/tool/compact.ts (patterns)
- Existing implementation: packages/opencode/src/session/archive-context.ts (content formatting)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5 (claude-opus-4-5-20251101)

### Debug Log References

- No debug issues encountered during implementation

### Completion Notes List

- Implemented full retrieve tool replacing the stub with working implementation
- Added comprehensive error handling for all edge cases (not found, not anchor, broken rangeEnd, empty range)
- Formatted retrieved content with message IDs for LLM readability
- Included token estimation in metadata for user visibility (with ignored flag support)
- Added 19 new tests covering successful retrieval, error handling, metadata preservation, reasoning parts, empty tool output, and ignored flag handling
- Updated retrieve.txt with complete usage documentation
- Updated compact.txt to remove "(not yet implemented)" hint
- All 325 tests pass (0 failures, 1 skip)
- Implementation follows patterns from compact.ts as specified
- Debug logging added to getMessage for better error tracing (sanitized to avoid exposing error objects)

### File List

| File | Change Type |
|------|-------------|
| `packages/opencode/src/tool/retrieve.ts` | Modified |
| `packages/opencode/src/tool/retrieve.txt` | Modified |
| `packages/opencode/src/tool/compact.txt` | Modified |
| `packages/opencode/test/tool/retrieve.test.ts` | Added |
| `packages/opencode/test/tool/compact-retrieve.test.ts` | Modified |
| `docs/sprint-artifacts/sprint-status.yaml` | Modified |
| `docs/sprint-artifacts/3-1-retrieve-tool-implementation.md` | Modified |

### Change Log

- 2026-01-03: Implemented retrieve tool with full functionality replacing stub. Added comprehensive test suite (16 tests). Updated tool descriptions. All tests pass.
- 2026-01-03: Code review fixes - Added TypeScript type definition for RetrieveMetadata, added test for empty_range edge case, fixed Dev Notes about reasoning parts.
- 2026-01-04: Code review fixes (round 2) - Added test for reasoning parts, added test for empty tool output, fixed token estimation to respect ignored flag, added debug logging to getMessage error handler. Now 18 tests total, all 325 tests pass.
- 2026-01-04: Code review fixes (round 3) - Sanitized debug logging to avoid exposing error objects, added test for ignored flag exclusion on text parts, cleaned up outdated Dev Notes stub code. Now 19 tests total.
- 2026-01-05: Code review (round 4) - Fixed test count typo (324 → 325). Added .claude to .gitignore. All 325 tests pass.

---

_Story created by: /bmad:bmm:workflows:create-story_
_Model: Claude Opus 4.5_
_Date: 2026-01-03_
_Analysis depth: Exhaustive artifact analysis with codebase reading_
