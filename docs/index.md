# OpenCode Project Documentation Index

**Generated:** 2025-12-03
**Project:** opencode_context_management
**Type:** Monorepo (Turborepo + Bun workspaces)
**Primary Language:** TypeScript
**Runtime:** Bun 1.3.3

---

## 🎯 Quick Reference

### Project Overview

- **Repository Type:** Monorepo with 4 main parts
- **Primary Tech:** TypeScript, Bun, SolidJS
- **Architecture:** Multi-provider AI CLI with plugin system
- **Key Feature:** Advanced LLM context management

### Parts Structure

#### 1. CLI (packages/opencode) - PRIMARY COMPONENT
- **Type:** CLI Tool
- **Purpose:** AI coding agent for terminal
- **Key Tech:** AI SDK, Tree-sitter, MCP, Hono
- **Focus:** Context management, multi-provider LLM integration

#### 2. Web (packages/web)
- **Type:** Web Application
- **Purpose:** Marketing and documentation website
- **Key Tech:** Astro, SolidJS, Starlight

#### 3. Desktop (packages/desktop)
- **Type:** Desktop Application
- **Purpose:** Desktop UI for OpenCode
- **Key Tech:** Vite, SolidJS, Tailwind CSS

#### 4. SDK (packages/sdk/js)
- **Type:** Library
- **Purpose:** JavaScript SDK with client/server exports
- **Key Tech:** TypeScript, OpenAPI codegen

---

## 📚 Generated Documentation

### 🔥 Core Analysis (Focus: Context Management)

#### [Context Management Analysis](./context-management-analysis.md) 🎯 **START HERE**

Comprehensive 15-section analysis of OpenCode's LLM context management system:

**Key Topics:**
1. Token Estimation (4-char heuristic)
2. Overflow Detection
3. Tool Output Pruning (40k token protection, 20k minimum)
4. Content Replacement Strategy
5. LLM-Powered Compaction
6. Dual-Level Summarization
7. Prompt Assembly
8. Context Window Flow Diagram
9. Optimization Techniques
10. Configuration Flags
11. Performance Analysis
12. Key Insights & Trade-offs
13. Related Files Map
14. Recommendations
15. Future Opportunities

**Critical Findings:**
- Multi-layered pruning → compaction → summarization strategy
- Selective tool output removal with "[Old tool result content cleared]" placeholders
- Small model usage for cost-efficient summaries (20 tokens for titles, 100 for bodies)
- Recency-biased: keeps last 40k tokens of tool results
- Saves 4,992 tokens per compacted tool call

---

#### [Technology Stack](./technology-stack.md)

Complete technology analysis for all 4 parts:

**CLI Technologies:**
- **AI/LLM:** 11 AI SDK providers (Anthropic, OpenAI, Google, Bedrock, Azure, etc.)
- **Context Protocol:** MCP SDK, AI-MCP bridge
- **Code Analysis:** Tree-sitter, Babel
- **Context Utils:** Diff, fuzzy search, file watching, JSON parsing
- **UI:** Terminal UI framework, SolidJS
- **Integration:** GitHub API, webhooks

**Web Technologies:**
- Astro 5.7 static site generator
- SolidJS for reactive components
- Shiki syntax highlighting
- Cloudflare deployment

**Desktop Technologies:**
- Vite build tool
- SolidJS with fine-grained reactivity
- Tailwind CSS
- Kobalte accessible components
- Virtual rendering for performance

**SDK:**
- TypeScript-first
- OpenAPI codegen
- Zero-dependency runtime

---

## 🗂️ Existing Project Documentation

### Root Level

- [README.md](../README.md) - Main project overview
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contribution guidelines
- [STYLE_GUIDE.md](../STYLE_GUIDE.md) - Code style standards
- [AGENTS.md](../AGENTS.md) - Agent system documentation
- [STATS.md](../STATS.md) - Project statistics
- [specs/project.md](../specs/project.md) - Project specifications

### CLI Package

- [packages/opencode/README.md](../packages/opencode/README.md) - CLI documentation
- [packages/opencode/AGENTS.md](../packages/opencode/AGENTS.md) - CLI-specific agents
- [packages/opencode/src/acp/README.md](../packages/opencode/src/acp/README.md) - Agent Communication Protocol

### Desktop Package

- [packages/desktop/README.md](../packages/desktop/README.md) - Desktop app documentation
- [packages/desktop/AGENTS.md](../packages/desktop/AGENTS.md) - Desktop agents

### SDK Packages

#### Go SDK
- [packages/sdk/go/README.md](../packages/sdk/go/README.md)
- [packages/sdk/go/SECURITY.md](../packages/sdk/go/SECURITY.md)
- [packages/sdk/go/CONTRIBUTING.md](../packages/sdk/go/CONTRIBUTING.md)
- [packages/sdk/go/api.md](../packages/sdk/go/api.md)

#### Python SDK
- [packages/sdk/python/README.md](../packages/sdk/python/README.md)
- [packages/sdk/python/docs/index.md](../packages/sdk/python/docs/index.md)
- [packages/sdk/python/docs/quickstart.md](../packages/sdk/python/docs/quickstart.md)
- [packages/sdk/python/docs/installation.md](../packages/sdk/python/docs/installation.md)
- [packages/sdk/python/docs/testing.md](../packages/sdk/python/docs/testing.md)
- [packages/sdk/python/docs/usage/](../packages/sdk/python/docs/usage/) - Configuration, sessions, streaming, files

---

## 🗺️ Architecture Quick Map

### Context Management System

```
session/
├── compaction.ts      ← Overflow detection & LLM-powered summarization
├── summary.ts         ← Session & message summarization
├── prompt.ts          ← Prompt assembly (OUTPUT_TOKEN_MAX = 32k)
├── message-v2.ts      ← Message → ModelMessage conversion
│                        Line 646: Compaction placeholder replacement
└── processor.ts       ← Stream processing

util/
├── token.ts           ← Token estimation (4 chars/token)
└── context.ts         ← Async context storage
```

### Key Files by Feature

| Feature | Primary Files | Lines of Interest |
|---------|---------------|-------------------|
| **Overflow Detection** | `session/compaction.ts` | 32-40 |
| **Pruning Logic** | `session/compaction.ts` | 48-86 |
| **Compaction Process** | `session/compaction.ts` | 88-229 |
| **Content Replacement** | `session/message-v2.ts` | 646 |
| **Summarization** | `session/summary.ts` | 21-158 |
| **Token Estimation** | `util/token.ts` | 1-7 |

---

## 🚀 Getting Started

### For Context Management Research

1. **Read the analysis**: [context-management-analysis.md](./context-management-analysis.md)
2. **Explore the code**: Start with `packages/opencode/src/session/compaction.ts`
3. **Follow the flow**: Section 8 in the analysis has the complete lifecycle diagram

### For General Development

1. Review [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution guidelines
2. Check [STYLE_GUIDE.md](../STYLE_GUIDE.md) for code standards
3. Read package-specific READMEs for detailed setup

### For Using OpenCode

1. Start with main [README.md](../README.md)
2. Check [specs/project.md](../specs/project.md) for specifications
3. Review [AGENTS.md](../AGENTS.md) for agent system

---

## 📊 Project Statistics

- **Total Packages:** 16+ packages
- **Main Parts:** 4 (CLI, Web, Desktop, SDK)
- **Primary Language:** TypeScript
- **Lines of Context Management Code:** ~500+ (core logic)
- **AI Providers Supported:** 11 (via AI SDK)
- **Documentation Files:** 20+ existing + 3 generated

---

## 🔍 Context Management Highlights

### Token Management Strategy

```
Context Limit: Model-specific (e.g., 200k)
Output Reservation: 32,000 tokens
Usable Context: Context Limit - Output Reservation

Overflow Trigger: (Input + Cache + Output) > Usable Context
```

### Pruning Thresholds

```
PRUNE_PROTECT: 40,000 tokens (keep recent)
PRUNE_MINIMUM: 20,000 tokens (minimum to trigger)
```

### Placeholder Replacements

```typescript
// Normal tool output: ~5,000 tokens
"[Actual tool output content here...]"

// After compaction: ~8 tokens
"[Old tool result content cleared]"

// Token savings: 4,992 per tool call
```

### Summarization Limits

```
Title: 20 tokens (1,500 for reasoning models)
Body: 100 tokens
Uses: Small model for cost efficiency
```

---

## 🛠️ Development Commands

```bash
# Install dependencies
bun install

# Development
bun run dev

# Type checking
bun run typecheck

# Build all packages
bun turbo build

# Test
bun test
```

---

## 🧭 Navigation Tips

**For Context Management Focus:**
1. Start with [context-management-analysis.md](./context-management-analysis.md)
2. Review [technology-stack.md](./technology-stack.md) AI SDK section
3. Explore `packages/opencode/src/session/` directory

**For Architecture Understanding:**
1. Check [technology-stack.md](./technology-stack.md) for all parts
2. Review architecture patterns by part
3. See integration points in the monorepo

**For Contributing:**
1. Read [CONTRIBUTING.md](../CONTRIBUTING.md)
2. Follow [STYLE_GUIDE.md](../STYLE_GUIDE.md)
3. Review package-specific documentation

---

## 📝 Notes

- **Deep Scan Level:** Deep (reads critical files in key directories)
- **Focus:** Context management for LLM integration
- **Generated:** 2025-12-03 by document-project workflow
- **Primary Insight:** Multi-layered context management with recency-biased pruning and LLM-powered compaction

---

**For Questions or Updates:**

This documentation was generated by automated analysis. For the most current information, always check:
- Package READMEs for setup instructions
- Source code comments for implementation details
- GitHub issues/discussions for known issues and roadmap

**Last Updated:** 2025-12-03
