# Dockerfile setup

## System deps

- Path references are relative to the repo root.

- Look in `packages/opencode/script/publish.ts` for the PKGBUILD snippets.
- Runtime deps: `fzf`, `ripgrep`.
- Source PKGBUILD also lists `makedepends`: `git`, `bun-bin`, `go`.

## Dev build

- Build binaries for Dockerfile staging:

```bash
bun run --cwd packages/opencode build
```

- Optional single-target build:

```bash
bun run --cwd packages/opencode build --single
```

## Output layout

- Binaries land at `packages/opencode/dist/<target>/bin/opencode`.
- Target name format: `opencode-<os>-<arch>[-baseline][-musl]`.
- Windows uses `windows` for `<os>` (not `win32`).

## Packaging note

- `packages/opencode/script/publish.ts` creates `.tar.gz` and `.zip` artifacts.
- It also publishes packages and pushes release artifacts, so do not use it for local dev packaging.
