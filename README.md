## This is the "Context Bonsai" fork of the official OpenCode repository

### Why does this fork exist?

I'm working on a somewhat significant feature addition: the ability for users and the LLM itself to edit the context. This fork hosts my changes until they're merged upstream.

### What is the current state of the Context Bonsai feature?

It appears to function with several models including: Claude, GPT, GLM, Kimi, and MiniMax models.

#### Development Threads

There are three active threads of development described below.

This featureset needs extended usage to judge whether the expected benefits of the feature come through. Testing so far has revealed that the model is uneager to do compactions even when the context window is > 70%. I'm continuing to actively use it on projects. Thats my focus now - I'm tuning the tool card and system reminders as I go.

Conversion to a plugin. Currently, the feature is deeply integrated as a set of changes to the OpenCode core, making it difficult to maintain as OpenCode development continues. I am restructuring the feature set in a way that is implementable as a plugin with as few changes the the OpenCode core as possible.

Porting the features to other coding agents. I've implemented a version of this in Claude Code by using tweakcc. Next will be the pi coding agent, followed by Codex and Gemini.

### What is the new feature?

I'm giving the LLM and the user the ability to surgically remove parts of the context while leaving behind traces of what was removed, including important information that needs to be retained as well as keywords that indicate what topics were covered in the removed context. It also grants the LLM the ability to restore the parts that were removed in case it actually is needed later. This means that ideally, we won't run into the dreaded compaction event that typically leaves the LLM session significantly degraded or even completely useless. It also allows us to remove context "poison" - those bits that seem to continually confuse the LLM causing it to repeat the same mistakes over and over.

[Screencast_20260106_235140.webm](https://github.com/user-attachments/assets/3bdeeda0-edc8-4678-8165-5475a03d24df)

For more information, keep reading - there are sections covering the internals of how it works as well as a draft blog post/announcement.

### How Context Bondai Works

Prerequisite knowledge - you should know the basics of how LLM chat interfaces work - the entire conversation is sent every time, with the new message (or tool call response) appended to the conversation.

#### It's A Tool Call

The functionality is provided by a tool called compact (as well as a complementary one called retrieve). Like all tools, it comes with a description that indicates why the tool is useful, when to use it, and how to use it. When I ask for content to be compacted (or retrieved), the LLM realizes the request can be satisfied by this tool.

Associating Messages With IDs and the Two Phases

The compact tool requires two phases.

**Phase 1: Enable message ID visibility**

The first call turns on message IDs so that when the conversation is sent to the model, each message is prefixed with its ID. Originally, I always had message IDs present in the conversation, but the LLM attempted to mimic this format in its responses, hallucinating its own message IDs; this is why the tool requires two separate calls. After turning on message IDs, the tool appends a message like "[message IDs are now visible]". Simply turning on message IDs only configures the local client to prefix the conversation with IDs on the next submission; another round trip to the LLM is needed so it actually sees them. Now the LLM can relate a request like "compact the failed debugging path, but make sure you retain what we learned from it in the summary" to actual message IDs in the conversation.

**Phase 2: Generate summaries and mark messages as archived**

OpenCode already serializes the conversation with message IDs internally. These are the IDs displayed in the TUI and made visible to the LLM in phase 1. In phase 2, the tool sends a separate LLM request with a special system prompt that asks for a summary with specific guidance. Once the LLM responds, the tool sets new properties on the messages: `archive` (containing `summary`, `indexTerms`, `rangeEnd`) on the first message of the range, and `archivedBy` on subsequent messages (pointing to the first message's ID). From that point forward, when OpenCode constructs the conversation to submit to the LLM, it omits archived messages and replaces them with the summary and keywords.

**Retrieval**

The retrieve tool fetches the original content and returns it as a tool result appended to the current context; appending preserves the LLM cache. The archived messages remain archived, but the LLM now has access to the original content for the remainder of that session.


---


### Draft Blog Post


# Addressing Context Window Issues in Long-Running AI Sessions

**An experimental approach to selective context management in OpenCode**

---

## The Problems That Kill Long Sessions

Anyone who's worked with AI coding assistants for extended periods has experienced the frustration: the AI that was helpful an hour ago is now giving nonsensical suggestions, forgetting constraints you established, or confidently building on its own hallucinations.

There are several distinct phenomena at play here.

### Context Rot

[Research from Chroma](https://research.trychroma.com/context-rot) documents what they call "context rot" - the degradation of LLM performance as input length increases, even within the model's stated context window.

Models don't process context uniformly. There's a well-documented ["Lost in the Middle"](https://www.understandingai.org/p/context-rot-the-emerging-challenge) effect: LLMs attend well to content at the beginning and end of their context, but struggle with information buried in the middle. As your session grows, important details get lost in an expanding sea of tokens.

More context doesn't mean better understanding. It often means more hallucinations, less reliable outputs, and degraded performance - even when you're technically within the model's limits.

### Context Poisoning

[Roo Code's documentation](https://docs.roocode.com/advanced-usage/context-poisoning) describes a related but distinct problem: context poisoning occurs when inaccurate or irrelevant data contaminates the active context, causing the AI to draw false conclusions and progressively drift from the task.

This happens through:
- **Accumulated hallucinations** - the model generates something false, then treats it as fact in subsequent responses
- **Failed attempts that linger** - that debugging tangent that went nowhere is still influencing the model's thinking
- **Misleading tool outputs** - an error message or outdated file content that's no longer relevant but still present

The symptoms are familiar: suggestions become repetitive or nonsensical, tool calls stop matching your requests, the model seems to be solving a different problem than the one you asked about.

The current recommended solution? Start a new session. Treat the poisoned conversation as disposable.

### Catastrophic Compaction

There's a third issue that compounds the first two: what happens when you actually hit the context limit.

Most tools handle this with batch compaction - when the window fills up, they generate a summary paragraph (typically hidden from the user) and show something like `[session compacted]`. The problem is that these summaries often lose critical nuance:

- Architectural constraints get flattened into generic descriptions
- The specific reasoning behind decisions disappears
- You're left with a summary the AI wrote about its own conversation - and you can't see what was lost

This is often *worse* than starting fresh. At least with a new session, you know you need to re-establish context. With batch compaction, you might not realize that critical constraints vanished until the AI contradicts them.

---

## What If You Could Stay Ahead of It?

I've been experimenting with an alternative approach: selective context compaction with retrieval.

The core idea: if you can surgically archive stale or problematic content *before* hitting the limit, you never trigger the destructive batch compaction. You maintain a lean, healthy context throughout the session.

### How It Works

**Context Gauges as Compaction Triggers**

The system injects periodic checkpoints showing token utilization:

```
[CONTEXT GAUGE: 67,000 / 100,000 tokens (67%)]
```

These aren't just for your information - they're signals to the AI. When the model sees utilization climbing, it's prompted to look for compaction opportunities: verbose tool outputs that have been analyzed, completed debugging tangents, discussions that are no longer relevant to the current task.

The frequency ramps up as context fills: sparse checkpoints early on, more frequent as you approach capacity. The goal is to trigger proactive cleanup before you ever hit the wall.

**Selective Archiving**

You (or the AI) can archive specific message ranges:

```
"Archive the failed debugging attempts from earlier"
"Compact messages msg_abc to msg_xyz"
```

The archived content is replaced with a compact placeholder:

```
[SMART_ARCHIVED: msg_abc to msg_xyz]
Summary: Debugging attempts - tried token refresh (tokens valid),
         session storage (persisting). Root cause was middleware order.
Index: auth, debugging, middleware, session
```

The original content isn't deleted - it's stored with a summary and index terms, retrievable if needed later.

**Retrieval**

If archived content becomes relevant again:

```
retrieve({ archiveId: "msg_abc" })
```

The original content is restored to the conversation.

**User Control**

Three modes for AI autonomy:
- **ask**: AI requests permission before archiving
- **notify**: AI archives and reports what it did
- **silent**: AI handles it automatically

---

## What This Might Help With

**For context rot:** By archiving verbose or stale content, you keep the active context leaner. Information you're actively using stays in the "attention-friendly" zones rather than getting buried in the middle of a massive context.

**For context poisoning:** Instead of nuking the whole session when things go wrong, you can archive the contaminated portions - the hallucinated outputs, the failed experiments, the misleading tangents - while preserving the legitimate decisions and constraints you've established.

**For catastrophic compaction:** The hope is that by staying ahead of context limits through continuous, surgical archiving, you never trigger the old batch compaction at all. Keep the context healthy and lean enough that the destructive fallback never fires.

**For the "start over" problem:** The goal is to make sessions recoverable rather than disposable. Archive the bad parts, keep the good parts, retrieve if you archived too aggressively.

---

## Current Status and Caveats

This is early and experimental. I've implemented the core mechanics:
- Context gauge injection with ramping frequency
- Compact tool with summary generation
- Retrieve tool
- Placeholder rendering
- User control modes

What I don't know yet:
- Does this actually help maintain coherence in practice?
- Are the generated summaries good enough for useful retrieval?
- Will the AI make good autonomous decisions about what to archive?
- How aggressive should compaction be to stay ahead of the limit?

I'll be using this myself and learning as I go. If you're curious, the feature is available in [OpenCode branch/version/etc]. Give it a spin on a long session and let me know how it goes - I'm especially interested in whether the AI makes sensible autonomous archiving decisions and whether the summaries are actually useful for retrieval.

---

## References

- [Context Rot: How Increasing Input Tokens Impacts LLM Performance | Chroma Research](https://research.trychroma.com/context-rot)
- [Context rot: the emerging challenge | Understanding AI](https://www.understandingai.org/p/context-rot-the-emerging-challenge)
- [Context Poisoning | Roo Code Documentation](https://docs.roocode.com/advanced-usage/context-poisoning)
- [Effective context engineering for AI agents | Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

---


The standard readme follows, and at the end is a draft blog post describing what
this branch is about.


---



<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The AI coding agent built for the terminal.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/sst/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/sst/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop bucket add extras; scoop install extras/opencode  # Windows
choco install opencode             # Windows
brew install opencode              # macOS and Linux
paru -S opencode-bin               # Arch Linux
mise use --pin -g ubi:sst/opencode # Any OS
nix run nixpkgs#opencode           # or github:sst/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between,
you can switch between these using the `Tab` key.

- **build** - Default, full access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also, included is a **general** subagent for complex searches and multi-step tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as a part of its name; for example, "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in anyway.

### FAQ

#### How is this different than Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [OpenCode Zen](https://opencode.ai/zen); OpenCode can be used with Claude, OpenAI, Google or even local models. As models evolve the gaps between them will close and pricing will drop so being provider-agnostic is important.
- Out of the box LSP support
- A focus on TUI. OpenCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This for example can allow OpenCode to run on your computer, while you can drive it remotely from a mobile app. Meaning that the TUI frontend is just one of the possible clients.

#### What's the other repo?

The other confusingly named repo has no relation to this one. You can [read the story behind it here](https://x.com/thdxr/status/1933561254481666466).

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)



