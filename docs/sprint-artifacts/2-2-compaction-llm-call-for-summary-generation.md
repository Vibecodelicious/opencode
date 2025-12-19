# Story 2.2: Compaction LLM Call for Summary Generation

Status: Ready for Review

## Story

As a user,
I want compaction to generate an intelligent summary of archived content,
So that the placeholder helps me understand what was archived.

## Acceptance Criteria

1. **Separate LLM Call for Summarization**
   - Given one or more validated message ranges to compact
   - When the Compact tool executes
   - Then it makes a separate LLM call with:
     - Full conversation context via `toModelMessageWithIDs()`
     - System prompt instructing summary and index term generation
     - All ranges to summarize (LLM generates summary/terms for each)

2. **LLM Response Format**
   - The LLM returns a map keyed by `startMessageId`:
   ```typescript
   Record<string, {        // Key is startMessageId (e.g., "msg_abc")
     summary: string,      // 1-3 sentence summary
     indexTerms: string[], // 3-7 semantic keywords
   }>
   ```
   - **Rationale:** Using startMessageId as key (not array index) is more robust - results are self-describing and can be matched regardless of order or if LLM skips/reorders entries.

3. **Summary Quality**
   - Summary captures the essence of the archived content
   - Index terms enable future retrieval by keyword
   - Summaries are 1-3 sentences, concise but informative

4. **Debugging/Iteration Content Handling**
   - When content contains debugging attempts, iterations, or trial-and-error:
     - Summarize WHAT WAS TRIED and WHAT WAS LEARNED
     - Include specific error messages or insights discovered
     - Note any constraints or requirements discovered
     - Don't just say "debugging session" - capture the knowledge gained

5. **Tool Output Update**
   - After summarization, tool returns confirmation with generated summaries
   - Output includes: range details, generated summaries, index terms for each range
   - **This story does NOT update message metadata** - that's Story 2.3

## Tasks / Subtasks

- [x] Task 1 (AC: 1): Create compaction summarization LLM call
  - [x] Subtask 1.1: Define system prompt for summary/index term generation
  - [x] Subtask 1.2: Build LLM request using `toModelMessageWithIDs()` for context
  - [x] Subtask 1.3: Include range information in user prompt for LLM to know what to summarize
  - [x] Subtask 1.4: Use `streamText()` pattern matching existing compaction.ts

- [x] Task 2 (AC: 2, 3): Parse LLM response into structured format
  - [x] Subtask 2.1: Define expected JSON schema for LLM response
  - [x] Subtask 2.2: Parse LLM text output to extract structured summaries
  - [x] Subtask 2.3: Validate each range has a corresponding summary
  - [x] Subtask 2.4: Handle missing or malformed entries gracefully

- [x] Task 3 (AC: 5): Update CompactTool.execute() to call summarization
  - [x] Subtask 3.1: After validation (Story 2.1), call summarization LLM
  - [x] Subtask 3.2: Collect summaries for all validated ranges
  - [x] Subtask 3.3: Return output with summaries and index terms
  - [x] Subtask 3.4: Include token counts/estimates in output

- [x] Task 4: Add tests for summarization flow
  - [x] Subtask 4.1: Test single-range summarization
  - [x] Subtask 4.2: Test multi-range summarization (batch)
  - [x] Subtask 4.3: Test error handling for LLM failures
  - [x] Subtask 4.4: Test JSON parsing patterns and summary format validation (note: LLM output quality is enforced by system prompt, not unit-testable)

## Technical Deep Dive

### Existing Compaction Pattern (compaction.ts:178-293)

The existing `SessionCompaction.process()` function provides the pattern to follow:

```typescript
export async function process(input: {
  parentID: string
  messages: MessageV2.WithParts[]
  sessionID: string
  model: { providerID: string; modelID: string }
  agent: string
  abort: AbortSignal
  auto: boolean
  mode?: "ask" | "notify" | "silent"
}) {
  const model = await Provider.getModel(input.model.providerID, input.model.modelID)
  const system = [...SystemPrompt.compaction(model.providerID)]

  // ... creates assistant message for response ...

  const result = await processor.process(() =>
    streamText({
      abortSignal: input.abort,
      messages: [
        ...system.map((x): ModelMessage => ({ role: "system", content: x })),
        ...toModelMessageWithIDs(input.messages.filter(/* ... */)),
        {
          role: "user",
          content: [{ type: "text", text: "Summarize our conversation..." }],
        },
      ],
      model: wrapLanguageModel({
        model: model.language,
        middleware: [/* ... */],
      }),
    }),
  )
}
```

**Key insights:**
1. Uses `toModelMessageWithIDs()` to prefix message content with IDs
2. Uses `streamText()` for the LLM call
3. Gets model via `Provider.getModel()`
4. Uses `SystemPrompt.compaction()` for system prompts
5. Creates assistant message to store response

### Context Builder (archive-context.ts:19-209)

The `toModelMessageWithIDs()` function already:
- Prefixes text content with `[msg_xxx]` IDs
- Handles archived messages (shows placeholder)
- Handles all part types (text, tool, reasoning, context-gauge, etc.)
- Skips messages with `archivedBy` (only first message of archive shows placeholder)

**Example output:**
```typescript
// User message
{ role: "user", content: [{ type: "text", text: "[msg_abc] Fix the login page" }] }

// Assistant message
{ role: "assistant", content: [{ type: "text", text: "[msg_def] Let me read the file first" }] }
```

### Current CompactTool State (compact.ts)

After Story 2.1, the tool:
1. Accepts `ranges` array parameter
2. Validates message existence, chronological order, archive status
3. Checks for range overlaps
4. Returns validation success message

**Next step (this story):** Add LLM call after validation to generate summaries.

### Proposed Architecture

```typescript
// In compact.ts

interface CompactionSummary {
  summary: string
  indexTerms: string[]
}

async function generateSummaries(input: {
  sessionID: string
  messages: MessageV2.WithParts[]
  ranges: NormalizedRange[]
  model: { providerID: string; modelID: string }
  abort: AbortSignal
}): Promise<Record<string, CompactionSummary>> {
  const model = await Provider.getModel(input.model.providerID, input.model.modelID)

  // Build the user prompt with range information
  const rangeDescriptions = input.ranges.map(r =>
    `- Range: ${r.startMessageId} to ${r.endMessageId}`
  ).join("\n")

  const userPrompt = `Analyze the following message ranges and generate summaries with index terms for each:
${rangeDescriptions}

For EACH range, provide:
1. A concise summary (1-3 sentences) capturing the essence of the content
2. 3-7 index terms for future retrieval

CRITICAL FOR DEBUGGING/ITERATION CONTENT:
If the content contains debugging attempts or iterations:
- Summarize WHAT WAS TRIED and WHAT WAS LEARNED
- Include specific error messages or insights discovered
- Note any constraints or requirements discovered

Respond in JSON format:
{
  "<startMessageId>": {
    "summary": "...",
    "indexTerms": ["...", "..."]
  },
  ...
}`

  const response = await streamText({
    abortSignal: input.abort,
    messages: [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      ...toModelMessageWithIDs(input.messages),
      { role: "user", content: [{ type: "text", text: userPrompt }] },
    ],
    model: model.language,
  })

  // Parse response and return structured summaries
  const text = await response.text
  return parseCompactionResponse(text)
}
```

### System Prompt for Compaction Summarization

```typescript
const COMPACTION_SYSTEM_PROMPT = `You are a context compaction assistant. Your job is to analyze conversation message ranges and generate:
1. A concise summary (1-3 sentences) for each range
2. 3-7 semantic index terms for future retrieval

Guidelines for summaries:
- Capture the essence of what was discussed/accomplished
- Be specific - include key decisions, file names, function names where relevant
- For debugging content: summarize what was tried, what was learned, what failed/succeeded

Guidelines for index terms:
- Use specific technical terms that would help retrieve this content
- Include: technologies, file names, error types, concepts discussed
- Avoid generic terms like "code", "fix", "work"

CRITICAL FOR DEBUGGING/ITERATION CONTENT:
If the content contains debugging attempts, iterations, or trial-and-error:
- Summarize WHAT WAS TRIED and WHAT WAS LEARNED
- Include specific error messages or insights discovered
- Note any constraints or requirements discovered
- Don't just say "debugging session" - capture the knowledge gained

Example good summary for debugging: "Debugged auth failure across 3 iterations. Tried: token refresh (tokens valid), session storage (sessions persisting). Found: middleware order causing session loss before auth check. Solution: move session middleware before auth."

Example bad summary for debugging: "Debugging session for authentication issues."

Respond ONLY with valid JSON in the format:
{
  "<startMessageId>": {
    "summary": "string",
    "indexTerms": ["string", ...]
  },
  ...
}`
```

### Response Parsing

```typescript
function parseCompactionResponse(text: string): Record<string, CompactionSummary> {
  // Try to find JSON in the response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error("No valid JSON found in compaction response")
  }

  const parsed = JSON.parse(jsonMatch[0])

  // Validate structure
  const result: Record<string, CompactionSummary> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue
    const v = value as Record<string, unknown>
    if (typeof v.summary !== "string") continue
    if (!Array.isArray(v.indexTerms)) continue

    result[key] = {
      summary: v.summary,
      indexTerms: v.indexTerms.filter((t): t is string => typeof t === "string"),
    }
  }

  return result
}
```

### Tool Context Access

The `execute` function receives `Tool.Context` which includes:
- `sessionID` - for loading messages
- `abort` - AbortSignal for cancellation

**Missing:** Model information for the LLM call. Options:
1. Get from session's last assistant message
2. Add to tool context
3. Use a default/configured compaction model

**Recommendation:** Get model from session's last assistant message (matches existing pattern in compaction.ts).

### Getting Model Information

```typescript
async function getSessionModel(sessionID: string): Promise<{ providerID: string; modelID: string }> {
  const msgs = await Session.messages({ sessionID })
  const lastAssistant = msgs.reverse().find(m => m.info.role === "assistant")
  if (lastAssistant && "providerID" in lastAssistant.info && "modelID" in lastAssistant.info) {
    return {
      providerID: (lastAssistant.info as MessageV2.Assistant).providerID,
      modelID: (lastAssistant.info as MessageV2.Assistant).modelID,
    }
  }
  // Fallback to default or throw
  throw new Error("No model information found in session")
}
```

## Implementation Guide

### Step 1: Add System Prompt

Create the compaction summarization system prompt in `compact.ts`:

```typescript
const COMPACTION_SUMMARY_SYSTEM_PROMPT = `You are a context compaction assistant...`
// (full prompt from above)
```

### Step 2: Create Summary Generation Function

```typescript
import { streamText, wrapLanguageModel } from "ai"
import { Provider } from "../provider/provider"
import { toModelMessageWithIDs } from "../session/archive-context"

interface CompactionSummary {
  summary: string
  indexTerms: string[]
}

async function generateSummaries(input: {
  sessionID: string
  allMessages: MessageV2.WithParts[]
  validatedRanges: Array<{ range: NormalizedRange; messages: MessageV2.WithParts[] }>
  model: { providerID: string; modelID: string }
  abort: AbortSignal
}): Promise<Record<string, CompactionSummary>> {
  // Implementation as described above
}
```

### Step 3: Update execute()

```typescript
export const CompactTool = Tool.define("compact", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    // Existing validation from Story 2.1
    const normalized = normalizeRanges(params.ranges)
    validateNoOverlaps(normalized)
    const allMessages = await Session.messages({ sessionID: ctx.sessionID })

    const validatedRanges = []
    for (const range of normalized) {
      const { messages } = await validateSingleRange(ctx.sessionID, range, allMessages)
      validatedRanges.push({ range, messages })
    }

    // NEW: Get model and generate summaries
    const model = await getSessionModel(ctx.sessionID)
    const summaries = await generateSummaries({
      sessionID: ctx.sessionID,
      allMessages,
      validatedRanges,
      model,
      abort: ctx.abort,
    })

    // Build output with summaries
    const totalMessages = validatedRanges.reduce((sum, r) => sum + r.messages.length, 0)
    const rangeDetails = validatedRanges.map(r => {
      const s = summaries[r.range.startMessageId]
      return `[${r.range.startMessageId} to ${r.range.endMessageId} (${r.messages.length} messages)]
  Summary: ${s?.summary ?? "No summary generated"}
  Index: ${s?.indexTerms?.join(", ") ?? "No index terms"}`
    }).join("\n")

    return {
      title: "Compaction summaries generated",
      output: `Generated summaries for ${normalized.length} range(s):\n${rangeDetails}\n\nTotal: ${totalMessages} messages ready for archival.`,
      metadata: {
        rangeCount: normalized.length,
        totalMessages,
        summaries,
      },
    }
  },
  // ...
})
```

### Step 4: Handle Errors

```typescript
// In generateSummaries:
try {
  const response = await streamText({ /* ... */ })
  const text = await response.text
  return parseCompactionResponse(text)
} catch (e) {
  // Log error but don't fail the whole operation
  log.error("Failed to generate summaries", { error: e })
  // Return empty summaries - let Story 2.3 handle gracefully
  return {}
}
```

## Testing Strategy

### Test Setup

```typescript
// Mock the Provider.getModel call
const mockModel = {
  providerID: "anthropic",
  modelID: "claude-3-sonnet",
  language: mockLanguageModel,
  info: { /* ... */ },
}

// Mock streamText to return controlled responses
vi.mock("ai", () => ({
  streamText: vi.fn(() => ({
    text: Promise.resolve(JSON.stringify({
      "msg_001": {
        summary: "Discussed authentication architecture",
        indexTerms: ["auth", "JWT", "security"]
      }
    }))
  }))
}))
```

### Test Cases

1. **Single range summarization**
   - Input: One valid range
   - Expected: One summary in response

2. **Multi-range summarization**
   - Input: Multiple valid ranges
   - Expected: Summary for each range, keyed by startMessageId

3. **Debugging content**
   - Input: Range containing debugging iterations
   - Expected: Summary captures what was tried/learned

4. **LLM failure handling**
   - Mock: streamText throws error
   - Expected: Graceful degradation, error logged

5. **Malformed LLM response**
   - Mock: streamText returns invalid JSON
   - Expected: Parse error, graceful handling

## Previous Story Intelligence

**Story 2.1 (Compact Tool Basic Structure) - Completed:**
- Validation functions: `getMessage()`, `normalizeRanges()`, `validateSingleRange()`, `validateNoOverlaps()`
- Tool returns validation success message
- Uses `ctx.sessionID` to access session messages
- **Key learning:** Session ID format is `ses_xxx`, message ID format is `msg_xxx`

**Architecture decisions to follow:**
- Separate LLM call (not TaskTool subagent) - matches `SessionCompaction.process()` pattern
- Use `toModelMessageWithIDs()` for context building
- Response keyed by startMessageId for robust matching

## Files to Modify

| File | Change |
|------|--------|
| `packages/opencode/src/tool/compact.ts` | Add `generateSummaries()`, `parseCompactionResponse()`, update `execute()` |
| `packages/opencode/src/tool/compact.txt` | Update description to reflect summarization behavior |
| `packages/opencode/test/tool/compact.test.ts` | Add summarization tests |

## Definition of Done

- [x] LLM call generates summaries for validated ranges
- [x] Summaries are 1-3 sentences, capture essence of content
- [x] Index terms are 3-7 specific keywords
- [x] Debugging content gets knowledge-preserving summaries
- [x] Response keyed by startMessageId for robust matching
- [x] Error handling for LLM failures
- [x] Tests cover single-range, multi-range, and error cases
- [x] No regressions to existing validation (Story 2.1)

## Risk Notes

1. **Model Access:** Tool context doesn't include model info directly. Need to either:
   - Get from session's last assistant message (recommended)
   - Add model info to tool context
   - Use a configured default compaction model

2. **Response Parsing:** LLM may not return perfectly formatted JSON. Need robust parsing with fallbacks.

3. **Token Limits:** For very long conversations, the summarization call might hit token limits. Consider:
   - Only including messages in/around the ranges to compact
   - Using a smaller context window for summarization

4. **Testing Complexity:** Testing LLM calls requires mocking. Ensure mocks are realistic enough to catch edge cases.

## References

- Architecture: Compaction Architecture section (docs/architecture.md:135-143)
- Existing pattern: `SessionCompaction.process()` (compaction.ts:178-293)
- Context builder: `toModelMessageWithIDs()` (archive-context.ts:19-209)
- Story 2.1: Compact tool validation (2-1-compact-tool-basic-structure.md)

---

## Dev Agent Record

### Context Reference

<!-- Path(s) to story context XML will be added here by context workflow -->

### Agent Model Used

Claude Opus 4.5

### Debug Log References

None - implementation proceeded without blocking issues.

### Completion Notes List

- Implemented `generateSummaries()` function using `streamText()` pattern from existing `SessionCompaction.process()`
- Created `COMPACTION_SUMMARY_SYSTEM_PROMPT` with detailed instructions for summary quality and debugging content handling
- Implemented `parseCompactionResponse()` with robust JSON extraction (handles markdown code blocks) and graceful fallbacks
- Added `getModelFromMessages()` to retrieve model info from provided messages array (avoids duplicate I/O)
- Updated `CompactTool.execute()` to call summarization after validation, with graceful degradation if model unavailable
- Implemented `estimateTokensForMessages()` using `Token.estimate()` pattern from existing codebase
- Token estimates included in output for each range and total (Subtask 3.4)
- Created comprehensive unit tests in `compact-summarization.test.ts` covering JSON parsing, validation patterns, and edge cases
- Updated existing validation tests to expect new output format
- All 258 tests pass with 0 failures

**Code Review Fixes (post-implementation):**
- Fixed array mutation: changed `msgs.reverse().find()` to `msgs.findLast()` to avoid mutating the messages array
- Eliminated duplicate I/O: renamed `getSessionModel()` to `getModelFromMessages()` and pass existing messages array instead of re-fetching
- Added user-facing error feedback: summarization failures now include reason in output (e.g., "No model information available" or specific error message)
- Clarified Subtask 4.4 description to accurately reflect what unit tests can verify (parsing patterns, not LLM output quality)

**Code Review Fixes (second review):**
- Added explicit error handling tests: 2 new tests in compact-validation.test.ts that verify graceful degradation when model lookup fails and when no assistant messages exist
- Updated File List to include sprint-status.yaml which was modified but not documented
- Test count increased from 36 to 38 compact-related tests (all passing)

### File List

- packages/opencode/src/tool/compact.ts (modified - added summarization functions, updated execute, code review fixes)
- packages/opencode/src/tool/compact.txt (modified - updated description for summarization)
- packages/opencode/test/tool/compact-summarization.test.ts (new - unit tests for summarization parsing)
- packages/opencode/test/tool/compact-validation.test.ts (modified - updated expected output format, added error handling tests)
- docs/sprint-artifacts/sprint-status.yaml (modified - story status tracking)
- docs/sprint-artifacts/2-2-compaction-llm-call-for-summary-generation.md (modified - code review fixes documentation)

---

_Story created by: /bmad:bmm:workflows:create-story_
_Model: Claude Opus 4.5_
_Date: 2025-12-18_
_Analysis depth: Deep codebase examination with actual file reading_
