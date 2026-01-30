# PRD: TUI Tool Renderers for Compact and Retrieve

## Overview

Add TUI tool renderers for the `compact` and `retrieve` tools so users can see meaningful feedback when these tools execute, rather than the generic tool fallback that ignores output.

## Background

### Current State

- Tool renderers live in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Renderers are registered via `ToolRegistry.register()` with:
  - `name`: Tool identifier string
  - `container`: `"inline"` or `"block"` (affects visual styling)
  - `render`: Component function receiving `ToolProps<T>`
- Tools without registered renderers fall back to `GenericTool`, which only shows tool name and input parameters, ignoring `props.output`
- Tool entries are hidden when "tool details" toggle is off; this behavior should be preserved

### Existing Patterns

#### ToolTitle Component
```tsx
function ToolTitle(props: { fallback: string; when: any; icon: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <text paddingLeft={3} fg={props.when ? theme.textMuted : theme.text}>
      <Show fallback={<>~ {props.fallback}</>} when={props.when}>
        <span style={{ bold: true }}>{props.icon}</span> {props.children}
      </Show>
    </text>
  )
}
```

#### Block Container Pattern (from `patch` renderer)
```tsx
ToolRegistry.register<typeof PatchTool>({
  name: "patch",
  container: "block",
  render(props) {
    const { theme } = useTheme()
    return (
      <>
        <ToolTitle icon="%" fallback="Preparing patch..." when={true}>
          Patch
        </ToolTitle>
        <Show when={props.output}>
          <box>
            <text fg={theme.text}>{props.output?.trim()}</text>
          </box>
        </Show>
      </>
    )
  },
})
```

#### Input Helper Function
```tsx
function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}
```

## Tool Specifications

### Compact Tool

**File:** `packages/opencode/src/tool/compact.ts`

**Input Parameters:**
```typescript
{
  ranges?: Array<{
    startMessageId: string
    endMessageId?: string
  }>
}
```

**Metadata (union type):**
```typescript
// Prepare mode - empty object
type CompactPrepareMetadata = {}

// Execute mode - has rangeCount
type CompactExecuteMetadata = {
  rangeCount: number
  totalMessages: number
  totalTokens: number
  summaries: Record<string, CompactionSummary>
  archived: number
  skipped?: number
  archivalErrors?: string[]
  error?: string
}

type CompactToolMetadata = CompactPrepareMetadata | CompactExecuteMetadata
```

**Output:** Text describing compaction results (e.g., summaries, archived count, etc.)

**Behavior:**
- Two modes with **different metadata structures**:
  - **Prepare mode** (no ranges): Enables message ID visibility, returns empty metadata `{}`
  - **Execute mode** (with ranges): Archives messages, generates summaries, returns full metadata with `rangeCount`
- Silent mode may return empty output string
- Type guard available: `"rangeCount" in metadata` to distinguish modes

### Retrieve Tool

**File:** `packages/opencode/src/tool/retrieve.ts`

**Input Parameters:**
```typescript
{
  archiveId: string
}
```

**Metadata:**
```typescript
{
  archiveId: string
  error?: "not_found" | "not_anchor" | "broken_range_end" | "empty_range"
  rangeEnd?: string
  messageCount?: number
  tokenEstimate?: number
  summary?: string
  indexTerms?: string[]
}
```

**Output:** Formatted retrieved archive content (messages with IDs and roles)

## Requirements

### Functional Requirements

#### FR-1: Compact Tool Renderer

1. Register with `container: "block"` for consistent visual hierarchy
2. Display title line via `ToolTitle` component
3. Show "Compacting..." fallback when tool is pending
4. Icon: `⊟` (compact/minimize symbol)
5. Title content: "Compact" as base
6. **Handle both metadata modes:**
   - Prepare mode (empty metadata `{}`): Just show "Compact"
   - Execute mode (has `rangeCount`): Show "Compact [N ranges]"
   - Use `"rangeCount" in props.metadata` type guard to distinguish
7. Render output body only when `props.output?.trim()` exists
8. Display trimmed output text with `theme.text` foreground color

#### FR-2: Retrieve Tool Renderer

1. Register with `container: "block"` for consistent visual hierarchy
2. Display title line via `ToolTitle` component
3. Show "Retrieving..." fallback when no archiveId input yet
4. Icon: `↺` (restore/retrieve symbol)
5. **Show archiveId directly** in title (e.g., "Retrieve msg_abc123")
   - Follow `Read` tool pattern: primary parameter shown directly, not via `input()` helper
   - Do NOT use `input(props.input)` - that's for supplementary parameters
6. Render output body only when `props.output?.trim()` exists
7. Display trimmed output text with `theme.text` foreground color
8. Error handling: Errors are returned in `props.output`, not metadata, so standard output display handles them

#### FR-3: Tool Details Toggle

Both renderers must respect the existing "tool details" toggle behavior:
- When toggle is off AND tool completed successfully, tool entry is hidden
- This is handled by existing `ToolPart` logic, no changes needed in renderers

### Non-Functional Requirements

#### NFR-1: Code Consistency
- Follow existing patterns established by `patch`, `bash`, and other renderers
- Use same component structure and styling conventions
- Import types from tool definition files

#### NFR-2: Simplicity
- No new logging
- No new toggles or configuration
- No truncation logic (display full output)
- No new state management

## Implementation Plan

### Step 1: Add Type Imports

Add imports for the tool types at the top of `session/index.tsx`:
```typescript
import type { CompactTool } from "@/tool/compact"
import type { RetrieveTool } from "@/tool/retrieve"
```

### Step 2: Implement Compact Renderer

Add after existing tool registrations (around line 1684):

```typescript
ToolRegistry.register<typeof CompactTool>({
  name: "compact",
  container: "block",
  render(props) {
    const { theme } = useTheme()
    // Type guard: prepare mode returns {}, execute mode has rangeCount
    const rangeCount = "rangeCount" in props.metadata ? props.metadata.rangeCount : undefined
    return (
      <>
        <ToolTitle icon="⊟" fallback="Compacting..." when={true}>
          Compact{rangeCount ? ` [${rangeCount} range${rangeCount === 1 ? "" : "s"}]` : ""}
        </ToolTitle>
        <Show when={props.output?.trim()}>
          <box>
            <text fg={theme.text}>{props.output!.trim()}</text>
          </box>
        </Show>
      </>
    )
  },
})
```

### Step 3: Implement Retrieve Renderer

Add after compact renderer:

```typescript
ToolRegistry.register<typeof RetrieveTool>({
  name: "retrieve",
  container: "block",
  render(props) {
    const { theme } = useTheme()
    return (
      <>
        <ToolTitle icon="↺" fallback="Retrieving..." when={props.input.archiveId}>
          Retrieve {props.input.archiveId}
        </ToolTitle>
        <Show when={props.output?.trim()}>
          <box>
            <text fg={theme.text}>{props.output!.trim()}</text>
          </box>
        </Show>
      </>
    )
  },
})
```

## Verification

### Manual Testing Checklist

1. **Compact Tool - Prepare Mode (empty metadata):**
   - [ ] Run compact without ranges
   - [ ] Verify title line shows "⊟ Compact" (no range count suffix)
   - [ ] Verify output body shows prepare mode instructions

2. **Compact Tool - Execute Mode (has rangeCount):**
   - [ ] Run compact with valid ranges
   - [ ] Verify title shows range count (e.g., "⊟ Compact [2 ranges]")
   - [ ] Verify output body shows summaries and archival info

3. **Compact Tool - Silent Mode:**
   - [ ] Configure `compaction.mode: "silent"` in config
   - [ ] Run compact with ranges
   - [ ] Verify title shows but output body is empty/hidden

4. **Retrieve Tool:**
   - [ ] Run retrieve with valid archiveId
   - [ ] Verify title shows "↺ Retrieve msg_xxx" (archiveId shown directly)
   - [ ] Verify output body shows retrieved content

5. **Tool Details Toggle:**
   - [ ] Disable tool details in TUI
   - [ ] Verify both tool entries are hidden after successful completion
   - [ ] Re-enable tool details
   - [ ] Verify tool entries are visible again

6. **Error Cases:**
   - [ ] Run retrieve with invalid archiveId
   - [ ] Verify error message appears in output body
   - [ ] Run compact with overlapping ranges
   - [ ] Verify error message appears in output body

## Files Changed

| File | Change |
|------|--------|
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Add imports for CompactTool and RetrieveTool types; Add two new ToolRegistry.register() calls |

## Out of Scope

- New logging infrastructure
- Truncation logic for long outputs
- New toggles or configuration options
- Changes to tool details toggle behavior
- Changes to compact or retrieve tool logic
- Custom styling for different compaction modes

## Design Decisions

1. **Icon choice for compact:** `⊟` (compact/minimize symbol)
   - Visually distinguishes from patch tool (`%`)

2. **Icon choice for retrieve:** `↺` (restore/retrieve symbol)
   - Conveys retrieval/restore action

3. **Range count display:** Show in title when available (execute mode only)
   - Provides user feedback on scope of operation
   - In prepare mode (empty metadata), just show "Compact"

4. **archiveId display:** Show directly in title, not via `input()` helper
   - Follows pattern of `Read` tool showing filePath directly
   - `input()` helper is for supplementary parameters, not primary identifiers

5. **Error handling:** No special renderer logic needed
   - Errors are returned in `props.output` field, not metadata
   - Standard output display handles error messages

## References

- Plan document: `docs/tool-renderer-plan.md`
- Tool implementations: `packages/opencode/src/tool/compact.ts`, `packages/opencode/src/tool/retrieve.ts`
- TUI session component: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
