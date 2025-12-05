# Technology Stack Analysis

**Generated:** 2025-12-03
**Project:** opencode_context_management
**Repository Type:** Monorepo (Turborepo + Bun workspaces)

---

## Part 1: CLI (packages/opencode) 🎯 PRIMARY FOCUS

**Project Type:** CLI Tool
**Root Path:** `packages/opencode/`
**Primary Language:** TypeScript
**Runtime:** Bun 1.3.3

### Core Technologies

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Runtime** | Bun | 1.3.3 | JavaScript runtime and package manager |
| **Language** | TypeScript | 5.8.2 | Type-safe development |
| **CLI Framework** | yargs | 18.0.0 | Command-line argument parsing |
| **API Framework** | Hono | 4.7.10 | Lightweight web framework |
| **OpenAPI** | hono-openapi | 1.1.1 | API schema generation |

### AI & LLM Integration Stack 🔥

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **AI SDK Core** | ai | 5.0.97 | Vercel AI SDK - unified LLM interface |
| **Anthropic** | @ai-sdk/anthropic | 2.0.50 | Claude integration |
| **OpenAI** | @ai-sdk/openai | 2.0.71 | GPT integration |
| **Google** | @ai-sdk/google | 2.0.44 | Gemini integration |
| **Google Vertex** | @ai-sdk/google-vertex | 3.0.81 | Vertex AI integration |
| **AWS Bedrock** | @ai-sdk/amazon-bedrock | 3.0.57 | Bedrock integration |
| **Azure OpenAI** | @ai-sdk/azure | 2.0.73 | Azure OpenAI integration |
| **OpenRouter** | @openrouter/ai-sdk-provider | 1.2.8 | Multi-model routing |
| **Generic** | @ai-sdk/openai-compatible | 1.0.27 | Generic OpenAI-compatible APIs |
| **MCP SDK** | @modelcontextprotocol/sdk | 1.15.1 | Model Context Protocol |
| **AI-MCP Bridge** | @ai-sdk/mcp | 0.0.8 | MCP integration with AI SDK |
| **Provider Utils** | @ai-sdk/provider-utils | 3.0.18 | Common provider utilities |

### Code Analysis & Parsing 🔍

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Tree-sitter Core** | web-tree-sitter | 0.25.10 | Code parsing and AST generation |
| **Bash Parser** | tree-sitter-bash | 0.25.0 | Bash script parsing |
| **Babel** | @babel/core | 7.28.4 | JavaScript/TypeScript parsing |

### Context Management & Utilities

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Diffs** | diff | 8.0.2 | File diffing |
| **Precision Diffs** | @pierre/precision-diffs | 0.6.0-beta.3 | High-quality diff generation |
| **Fuzzy Search** | fuzzysort | 3.1.0 | Fast fuzzy string matching |
| **File Watching** | @parcel/watcher | 2.5.1 | Cross-platform file watching |
| **File Watching Alt** | chokidar | 4.0.3 | Alternative file watcher |
| **Glob Matching** | minimatch | 10.0.3 | Glob pattern matching |
| **Ignore Patterns** | ignore | 7.0.5 | .gitignore-style matching |
| **JSON Parsing** | jsonc-parser | 3.3.1 | JSON with comments |
| **Partial JSON** | partial-json | 0.1.7 | Stream JSON parsing |
| **Markdown** | gray-matter | 4.0.3 | Front-matter parsing |
| **HTML→MD** | turndown | 7.2.0 | HTML to Markdown conversion |

### UI & Terminal

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Prompts** | @clack/prompts | 1.0.0-alpha.1 | Interactive CLI prompts |
| **TUI Framework** | @opentui/core | 0.1.55 | Terminal UI components |
| **TUI SolidJS** | @opentui/solid | 0.1.55 | SolidJS bindings for TUI |
| **Spinner** | opentui-spinner | 0.0.6 | Loading spinners |
| **Clipboard** | clipboardy | 4.0.0 | Cross-platform clipboard |
| **Open URLs** | open | 10.1.2 | Open files/URLs |
| **Strip ANSI** | strip-ansi | 7.1.2 | Remove ANSI codes |

### Data & State Management

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Reactive** | solid-js | 1.9.10 | Fine-grained reactivity |
| **Event Bus** | @solid-primitives/event-bus | 1.1.2 | Event communication |
| **Validation** | zod | 4.1.8 | Schema validation |
| **JSON Schema** | zod-to-json-schema | 3.24.5 | Zod to JSON Schema |
| **Decimal Math** | decimal.js | 10.5.0 | Precise decimal arithmetic |
| **Utility Belt** | remeda | 2.26.0 | Functional utilities |
| **IDs** | ulid | 3.0.1 | Unique ID generation |

### GitHub Integration

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Actions Core** | @actions/core | 1.11.1 | GitHub Actions SDK |
| **Actions GitHub** | @actions/github | 6.0.1 | GitHub API for Actions |
| **Octokit GraphQL** | @octokit/graphql | 9.0.2 | GitHub GraphQL API |
| **Octokit REST** | @octokit/rest | 22.0.0 | GitHub REST API |
| **Webhook Types** | @octokit/webhooks-types | 7.6.1 | GitHub webhook schemas |

### Authentication & Security

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Auth** | @openauthjs/openauth | 0.0.0-20250322224806 | Authentication framework |
| **Config Dir** | xdg-basedir | 5.1.0 | XDG base directory spec |

### Development Tools

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **LSP Types** | vscode-languageserver-types | 3.17.5 | Language server protocol types |
| **JSON-RPC** | vscode-jsonrpc | 8.2.1 | JSON-RPC implementation |
| **Debugging** | why-is-node-running | 3.2.2 | Debug hanging processes |
| **Compression** | @zip.js/zip.js | 2.7.62 | ZIP file handling |

### Architecture Pattern

**Pattern:** Plugin-based CLI with Multi-Provider AI Integration

**Key Characteristics:**
1. **Provider Abstraction**: Unified interface across multiple LLM providers
2. **Context Protocol**: MCP SDK integration for standardized context management
3. **Code-Aware**: Tree-sitter integration for semantic code understanding
4. **Reactive Core**: SolidJS for reactive state management
5. **Extensibility**: Plugin system (@opencode-ai/plugin)
6. **Workspace Integration**: File watching, diff generation, code parsing

---

## Part 2: Web (packages/web)

**Project Type:** Web Application
**Root Path:** `packages/web/`
**Primary Language:** TypeScript
**Framework:** Astro 5.7.13

### Core Technologies

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Framework** | Astro | 5.7.13 | Static site generator |
| **UI Framework** | SolidJS | 1.9.10 | Reactive UI components |
| **Astro-Solid** | @astrojs/solid-js | 5.1.0 | SolidJS integration |
| **Docs Theme** | @astrojs/starlight | 0.34.3 | Documentation theme |
| **Deployment** | @astrojs/cloudflare | 12.6.3 | Cloudflare Pages adapter |

### Markdown & Syntax Highlighting

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Markdown** | @astrojs/markdown-remark | 6.3.1 | Markdown processing |
| **Highlighting** | shiki | 3.4.2 | Code syntax highlighting |
| **Marked** | marked | 15.0.12 | Markdown parser |
| **Marked-Shiki** | marked-shiki | 1.2.1 | Shiki integration for Marked |
| **Transformers** | @shikijs/transformers | 3.4.2 | Shiki AST transformers |

### Utilities

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Dates** | luxon | 3.6.1 | DateTime library |
| **Diff** | diff | 8.0.2 | File diffing |
| **Base64** | js-base64 | 3.7.7 | Base64 encoding |
| **Lang Detection** | lang-map | 0.4.0 | Language name mapping |
| **Functional** | remeda | 2.26.0 | Utility functions |
| **Image Processing** | sharp | 0.32.5 | Image optimization |

### Architecture Pattern

**Pattern:** Static Site with Component Islands

**Key Characteristics:**
1. **Partial Hydration**: Astro islands architecture
2. **Docs-Focused**: Starlight theme for documentation
3. **Markdown-First**: Content in Markdown with frontmatter
4. **Edge Deployment**: Cloudflare Pages optimized

---

## Part 3: Desktop (packages/desktop)

**Project Type:** Desktop Application
**Root Path:** `packages/desktop/`
**Primary Language:** TypeScript
**Framework:** Vite + SolidJS

### Core Technologies

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Build Tool** | Vite | 7.1.4 | Fast build tooling |
| **UI Framework** | SolidJS | 1.9.10 | Reactive components |
| **Vite Plugin** | vite-plugin-solid | 2.11.10 | SolidJS Vite integration |
| **Styling** | Tailwind CSS | 4.1.11 | Utility-first CSS |
| **Tailwind Vite** | @tailwindcss/vite | 4.1.11 | Tailwind Vite plugin |

### UI Components & Primitives

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Component Library** | @kobalte/core | 0.13.11 | Accessible UI primitives |
| **Routing** | @solidjs/router | 0.15.4 | Client-side routing |
| **Meta Tags** | @solidjs/meta | 0.29.4 | Document head management |
| **Drag & Drop** | @thisbeyond/solid-dnd | 0.7.5 | Drag and drop |
| **Virtual Lists** | virtua | 0.42.3 | Virtualized lists |
| **List Utils** | solid-list | 0.3.0 | List utilities |

### SolidJS Primitives

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Active Element** | @solid-primitives/active-element | 2.1.3 | Focus tracking |
| **Event Bus** | @solid-primitives/event-bus | 1.1.2 | Event communication |
| **Resize Observer** | @solid-primitives/resize-observer | 2.1.3 | Element size tracking |
| **Scroll** | @solid-primitives/scroll | 2.1.3 | Scroll utilities |
| **Storage** | @solid-primitives/storage | 4.3.3 | Persistent storage |

### Code Display & Utilities

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Syntax Highlighting** | shiki | 3.9.2 | Code highlighting |
| **Shiki Transformers** | @shikijs/transformers | 3.9.2 | Code transformations |
| **Markdown** | marked | 16.2.0 | Markdown parser |
| **Marked-Shiki** | marked-shiki | 1.2.1 | Shiki for Marked |
| **Diff** | diff | 8.0.2 | File diffing |
| **Fuzzy Search** | fuzzysort | 3.1.0 | Fuzzy matching |
| **Dates** | luxon | 3.6.1 | Date/time handling |
| **Functional** | remeda | 2.26.0 | Utilities |

### Architecture Pattern

**Pattern:** Component-Based Desktop UI with Virtual Rendering

**Key Characteristics:**
1. **Fine-Grained Reactivity**: SolidJS reactive primitives
2. **Performance Optimized**: Virtual lists for large datasets
3. **Accessible**: Kobalte component library
4. **Modern Styling**: Tailwind CSS utility-first
5. **Code Display**: Integrated syntax highlighting

---

## Part 4: SDK (packages/sdk/js)

**Project Type:** Library
**Root Path:** `packages/sdk/js/`
**Primary Language:** TypeScript
**Build:** Custom build script

### Core Technologies

| Category | Technology | Version | Purpose |
|----------|-----------|---------|---------|
| **Language** | TypeScript | 5.8.2 | Type-safe SDK |
| **OpenAPI Codegen** | @hey-api/openapi-ts | 0.81.0 | API client generation |

### Module Exports

- **Main**: `./src/index.ts`
- **Client**: `./src/client.ts`
- **Server**: `./src/server.ts`

### Architecture Pattern

**Pattern:** Dual Client/Server Library

**Key Characteristics:**
1. **TypeScript-First**: Full type safety
2. **OpenAPI Integration**: Generated from OpenAPI specs
3. **Dual Exports**: Separate client and server modules
4. **Zero Dependencies**: Minimal runtime footprint

---

## Monorepo Infrastructure

### Package Management

| Technology | Version | Purpose |
|-----------|---------|---------|
| **Package Manager** | Bun | 1.3.3 | Fast package manager |
| **Monorepo Tool** | Turbo | 2.5.6 | Build orchestration |
| **Workspaces** | Bun Workspaces | - | Monorepo structure |

### Shared Catalog Dependencies

The workspace uses a dependency catalog for version consistency:
- TypeScript: 5.8.2
- SolidJS: 1.9.10
- Vite: 7.1.4
- Hono: 4.7.10
- Zod: 4.1.8
- AI SDK: 5.0.97
- Tailwind CSS: 4.1.11

### Development Tools

| Technology | Purpose |
|-----------|---------|
| **Husky** | Git hooks |
| **Prettier** | Code formatting |
| **SST** | Infrastructure as code |

---

## Context Management Focus 🎯

### Identified Technologies for Context Building

Based on the CLI dependencies, the following technologies are likely involved in building and managing LLM context:

1. **Tree-sitter**: Semantic code parsing for understanding code structure
2. **@pierre/precision-diffs**: High-quality diffs for showing code changes
3. **AI SDK Provider Utils**: Utilities for managing provider-specific context
4. **MCP SDK**: Standardized context protocol implementation
5. **Partial JSON**: Streaming/partial JSON parsing (context window management)
6. **File Watchers**: Tracking file changes for context updates
7. **Ignore Patterns**: Filtering files to exclude from context
8. **Minimatch**: Glob patterns for file selection

### Next Step: Deep Code Analysis

The deep scan (Step 4) will examine these specific areas in `packages/opencode/src/`:
- Context building mechanisms
- Token counting/limits
- Content summarization strategies
- File filtering and selection
- Tree-sitter usage for semantic understanding
- MCP protocol implementation
- Provider-specific adaptations

---

**Analysis Complete** - Technology stack documented for all 4 parts.
