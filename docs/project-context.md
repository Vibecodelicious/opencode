# Project Context & Development Guidelines

## Commit Message Best Practices

Commit messages should be understandable to maintainers who don't have access to sprint artifacts, internal epics, story files, or any project-specific documentation. Each commit tells a story about *what changed and why*.

### Structure

```
<type>: <subject>

<body>

<footer>
```

### Type
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code restructuring without feature change
- `test`: Test additions or improvements
- `docs`: Documentation changes
- `chore`: Build, deps, tooling

### Subject Line
- Lowercase, imperative mood ("add" not "added" or "adds")
- No period at end
- Under 50 characters
- Explain **what** changed at a high level

### Body
- **Always include a body for non-trivial changes**
- Explain **why** the change exists, not just what was done; assume reviewers cannot see epics/stories/docs
- Explicitly tie changes to the overarching goal: smart compaction and context management reliability
- For new features: provide context about the larger system goal
- For bug fixes: describe the problem and why the solution works
- Mention how this fits into the bigger picture (e.g., "This is foundational for X feature that will be implemented next")
- Wrap at 72 characters
- Use blank line to separate from subject

### Footer
- Reference issues, tickets, or related work if applicable
- Format: `Relates-to: #123` or `Fixes: #123`

### Example

```
feat: add ContextGaugePart schema for LLM context awareness

Add infrastructure for tracking context window utilization throughout a
conversation. This is the foundational step toward implementing intelligent
context compaction - the system will periodically store context usage
snapshots that the LLM can see to make informed decisions about when
compression is needed.

ContextGaugePart stores three fields:
- tokenCount: current tokens in the context
- contextLimit: maximum context window size
- percentage: utilization percentage (0-100)

Testing:
- Schema validation (valid/invalid inputs)
- Part union type acceptance
- Message rendering (normal, zero, and large values)
- Locale-aware number formatting with separators
- All existing tests pass; backwards compatible

Future work will inject these gauges after LLM responses and implement
compaction strategies that the LLM can trigger based on context pressure.
```

## Testing Standards

- Write tests in the same directory structure as source files: `src/foo.ts` → `test/foo.test.ts`
- Use `bun:test` framework (described in `package.json`)
- Cover happy path, edge cases, and error conditions
- Test actual behavior, not just happy cases
- Edge cases to consider: zero values, boundary values, null/undefined, large values
- All tests must pass before marking a task complete

## Code Quality

- Follow existing patterns in the codebase
- Use TypeScript strictly (no `any` without justification)
- Leverage Zod schemas for runtime validation
- Document non-obvious logic with inline comments
- Keep functions focused and testable

## Backwards Compatibility

- New message part types should be optional (existing messages work without them)
- Schema extensions should not break existing data loading
- Run full test suite before completion to verify no regressions

## File Organization

- Source: `packages/opencode/src/`
- Tests: `packages/opencode/test/` (mirror source structure)
- Messages: `packages/opencode/src/session/message-v2.ts` is the canonical message schema

## Git Workflow

- Commits should be atomic (one logical change per commit)
- Branch: work on `dev` branch
- Don't commit sprint artifacts or story files
- Include file changes and test coverage in the same commit
