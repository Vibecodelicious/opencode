## Debugging

- To test opencode in the `packages/opencode` directory you can run `bun dev`

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE. Here is an example illustrating how to execute 3 parallel file reads in this chat environment:

json
{
"recipient_name": "multi_tool_use.parallel",
"parameters": {
"tool_uses": [
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.tsx"
}
},
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.ts"
}
},
{
"recipient_name": "functions.read",
"parameters": {
"filePath": "path/to/file.md"
}
}
]
}
}

## Running tests

This is a monorepo. The `bun test:no_external_deps` script is in the ROOT
package.json, not in packages/opencode/package.json. Always run test commands
from the repository root.

The local environment may have permissions errors when running tests; you can
use tmux send-keys and capture-pane to run tests. Use `bun test:no_external_deps`
to avoid tests that have external dependencies. You should not even try to run
the full test suite for this project.
