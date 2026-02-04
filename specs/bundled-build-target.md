# Plan: Bundled Build Target for OpenCode

## Problem Statement

Bun's compiled binary cannot properly resolve subpath exports (e.g., `@openauthjs/openauth/pkce`) for plugins that are dynamically imported at runtime. This breaks the default auth plugins (`opencode-copilot-auth`, `opencode-anthropic-auth`) when running the dist binary.

The issue is specific to compiled binaries - `bun run` works correctly.

## Goal

Add a `--bundled` build flag that creates a binary with default plugins statically bundled, avoiding runtime dynamic imports for those plugins.

## Scope

**In Scope:**
- New `--bundled` flag for `script/build.ts`
- Static imports of default plugins when flag is set
- Conditional logic in plugin loader to use bundled plugins
- Documentation of the new build target

**Out of Scope:**
- Fixing user-configured plugins (still use dynamic loading)
- Fixing the underlying bun module resolution issue
- Changes to plugin packages themselves
- Updates to nix build scripts (`nix/scripts/bun-build.ts`, `nix/bundle.ts`)

## Known Limitations

1. **User plugins still broken**: Plugins configured via `opencode.json` will still fail if they use subpath exports
2. **Plugin updates require rebuild**: Bundled plugin versions are frozen at build time
3. **Binary size increase**: ~estimated 50-100KB larger with bundled plugins and their dependencies
4. **`OPENCODE_DISABLE_DEFAULT_PLUGINS` changes meaning**: Flag will skip plugin initialization but code is still in binary

## Implementation Plan

### Task 1: Add build flag parsing

**File:** `packages/opencode/script/build.ts`

Add a new flag near line 18-19 with the other flags:
```typescript
const bundledFlag = process.argv.includes("--bundled")
```

Modify the `define` block (around line 126-131) to include the new constant. Show the complete block:
```typescript
define: {
  OPENCODE_VERSION: `'${Script.version}'`,
  OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
  OPENCODE_WORKER_PATH: workerPath,
  OPENCODE_CHANNEL: `'${Script.channel}'`,
  OPENCODE_BUNDLED_PLUGINS: bundledFlag ? `'true'` : `'false'`,  // Add this line
},
```

### Task 2: Create bundled plugin exports

**File:** `packages/opencode/src/plugin/bundled.ts` (new file)

Create a file that statically imports the default plugins. Use `import *` to match the behavior of dynamic `import()`:

```typescript
// This file is only used when OPENCODE_BUNDLED_PLUGINS is true
// It provides static imports of default plugins to avoid runtime module resolution issues
import type { Plugin } from "@opencode-ai/plugin"
import * as anthropicAuth from "opencode-anthropic-auth"
import * as copilotAuth from "opencode-copilot-auth"

export const BUNDLED_PLUGINS: Record<string, Record<string, Plugin>> = {
  "opencode-anthropic-auth": anthropicAuth,
  "opencode-copilot-auth": copilotAuth,
}
```

### Task 3: Modify plugin loader

**File:** `packages/opencode/src/plugin/index.ts`

**Step 3a:** Add global declaration at the top of the file (after imports, around line 10):
```typescript
declare global {
  const OPENCODE_BUNDLED_PLUGINS: string | undefined
}
```

**Step 3b:** Add the `isBundled` constant inside the `Plugin` namespace, before the `state` definition (around line 13):
```typescript
export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  // Add this line:
  const isBundled = typeof OPENCODE_BUNDLED_PLUGINS !== 'undefined' && OPENCODE_BUNDLED_PLUGINS === 'true'
```

**Step 3c:** Modify the plugin loading logic (around lines 29-46). Replace the default plugin loading with conditional logic:

```typescript
    const plugins = [...(config.plugin ?? [])]

    // Load default plugins - either bundled or dynamic
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      if (isBundled) {
        // Use bundled plugins (avoids runtime module resolution issues)
        const { BUNDLED_PLUGINS } = await import("./bundled")
        for (const [name, mod] of Object.entries(BUNDLED_PLUGINS)) {
          log.info("loading bundled plugin", { name })
          for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
            const init = await fn(input)
            hooks.push(init)
          }
        }
      } else {
        // Dynamic loading from npm (original behavior)
        plugins.push("opencode-copilot-auth@0.0.7")
        plugins.push("opencode-anthropic-auth@0.0.3")
      }
    }

    // Continue with user-configured plugins (always dynamic)
    for (let plugin of plugins) {
      // ... existing dynamic loading logic
```

**Note:** When running with `bun dev` or non-compiled builds, `OPENCODE_BUNDLED_PLUGINS` will be undefined, causing the code to fall back to the existing dynamic loading path.

### Task 4: Add plugin packages as dependencies

**File:** `packages/opencode/package.json`

Add the plugins as dev dependencies so they can be bundled. **Use the same versions as specified in `src/plugin/index.ts` lines 31-32** to ensure consistency:

```json
{
  "devDependencies": {
    "opencode-anthropic-auth": "0.0.3",
    "opencode-copilot-auth": "0.0.7"
  }
}
```

**Note:** If the versions in `src/plugin/index.ts` are updated in the future, these devDependencies must be updated to match.

### Task 5: Update build script output naming

**File:** `packages/opencode/script/build.ts`

When `--bundled` flag is used, append `-bundled` to the output directory name. Modify the `name` array (around lines 92-101):

```typescript
const name = [
  pkg.name,
  // changing to win32 flags npm for some reason
  item.os === "win32" ? "windows" : item.os,
  item.arch,
  item.avx2 === false ? "baseline" : undefined,
  item.abi === undefined ? undefined : item.abi,
  bundledFlag ? "bundled" : undefined,  // Add this line
]
  .filter(Boolean)
  .join("-")
```

### Task 6: Test the bundled build

1. Build with: `OPENCODE_CHANNEL=local bun run build --single --bundled`
2. Run from a different directory: `./dist/opencode-linux-x64-bundled/bin/opencode session list`
3. Verify plugins load without errors (check logs for "loading bundled plugin")
4. Verify `OPENCODE_DISABLE_DEFAULT_PLUGINS=true` still works (plugins don't initialize)
5. Verify non-bundled build still works: `bun run build --single` (without `--bundled`)

## Acceptance Criteria

- [ ] `bun run build --bundled` produces binaries in `dist/opencode-{os}-{arch}[-baseline][-abi]-bundled/` directories
- [ ] Bundled binary runs without plugin module resolution errors
- [ ] Bundled binary loads default auth plugins successfully (logs show "loading bundled plugin")
- [ ] `OPENCODE_DISABLE_DEFAULT_PLUGINS=true` prevents plugin initialization (but code is still in binary)
- [ ] Non-bundled build (`bun run build` without `--bundled`) behavior is unchanged
- [ ] User-configured plugins in `opencode.json` still use dynamic loading (and may still fail with subpath exports)
- [ ] `bun dev` (non-compiled) uses dynamic loading path (fallback behavior)

## Files Modified

| File | Change |
|------|--------|
| `packages/opencode/script/build.ts` | Add `--bundled` flag, define `OPENCODE_BUNDLED_PLUGINS`, modify output name |
| `packages/opencode/src/plugin/bundled.ts` | New file with static plugin imports |
| `packages/opencode/src/plugin/index.ts` | Add global declaration, `isBundled` constant, conditional loading logic |
| `packages/opencode/package.json` | Add plugin devDependencies |

## Future Considerations

1. **Fix at plugin level**: Long-term, plugins could be published as pre-bundled single files, fixing the issue for all plugins (including user plugins)
2. **Bun upstream fix**: Monitor bun releases for fixes to subpath export resolution in compiled binaries
3. **Plugin version management**: Consider a mechanism to update bundled plugin versions without full rebuild
4. **Nix builds**: If nix builds are used for distribution, similar changes may be needed in `nix/scripts/bun-build.ts`
