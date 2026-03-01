# Codebase Audio Narrative Generator

## What I Want

I want you to explore the codebase attached to this session and produce a long-form written narrative about it — structured and written specifically to be consumed as audio via text-to-speech while I do chores.

## Why This Format

I listen to podcasts, audiobooks, and YouTube while doing housework. I get hours of listening in daily. I want to use that time to learn codebases. For that to work, the content has to be genuinely engaging — I have ADHD, so if it's dry or loses momentum, I'll zone out and switch to something else.

## Writing Style Requirements

- **Write for the ear, not the eye.** No code blocks, no bullet lists, no markdown formatting, no tables. This will be read aloud by TTS. Everything must work as spoken prose.
- **Be conversational and vivid.** Talk like an enthusiastic senior engineer explaining the system to a colleague over drinks. Use analogies, metaphors, storytelling. "Imagine you're a request coming in from the user..." is great. "The request handler processes incoming HTTP requests" is dead air.
- **Build narrative momentum.** Use hooks, foreshadowing, callbacks. "Remember that event system I mentioned earlier? Here's where it gets interesting." Set up questions, then answer them. Create curiosity gaps.
- **Vary your pacing.** Alternate between high-level "why does this exist" context and deep-dive "here's how this actually works under the hood" detail. Don't stay at one altitude too long.
- **Use signposting for audio navigation.** Since listeners can't scan or scroll, use clear verbal transitions: "Now let's shift gears and talk about..." or "That covers the data layer. Next up: how the UI actually renders."
- **Explain jargon when it first appears** but don't be condescending. Assume I'm a competent developer who might not know this particular stack or pattern.
- **Keep paragraphs short-ish.** Long unbroken walls of text are hard to follow in audio. Vary sentence length. Use occasional rhetorical questions to re-engage attention.

## Structure

Produce this as a series of "episodes" or chapters. Each one should be roughly 10-20 minutes of listening when read aloud (ballpark 1500-3000 words per episode). Structure suggestion, but use your judgment:

1. **The Big Picture** — What is this project? What problem does it solve? Who's it for? Why does it exist when alternatives exist? Set the stage and make me care.
2. **The Architecture Tour** — How is the codebase organized at a high level? What are the major components and how do they relate? Walk through the system like you're giving a tour of a building.
3. **The Core Loop** — What's the central thing this software does, and how does data flow through it from start to finish? Trace a real request or operation through the system.
4. **The Clever Bits** — What are the most interesting design decisions, patterns, or techniques? What surprised you? Where did the authors do something unusual or particularly elegant?
5. **The Rough Edges** — Where are the TODOs, the tech debt, the compromises? What would you change? This keeps it real and is often the most interesting part.

Add, remove, split, or reorder episodes based on what you actually find. The codebase should dictate the structure, not this template.

## Process

1. **Explore first.** Read widely before writing. Understand the codebase thoroughly — entry points, core logic, data models, interesting patterns, dependencies. Read actual source files, not just directory listings.
2. **Then write.** Don't interleave exploration and writing. Get the full picture, then craft the narrative.
3. **Output as a single document** with clear chapter/episode breaks. Plain text, no formatting — remember, this is for TTS.

## What NOT To Do

- Don't ask me a bunch of clarifying questions. Use your judgment.
- Don't produce dry technical documentation dressed up with a few casual phrases.
- Don't summarize at a surface level. I want real depth — the kind of understanding that would let me contribute to this codebase.
- Don't include code snippets. Describe what the code does in words. If a function name or type name is important, say it, but don't read out syntax.
- Don't use emoji, markdown headers, or any visual formatting in the narrative output itself. Chapter titles are fine as plain text labels.
