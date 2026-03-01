# Codebase Audio Narrative Generator

## What I Want

I want you to explore the codebase attached to this session and produce a long-form written narrative about it — structured and written specifically to be consumed as audio via text-to-speech while I do chores.

## Why This Format

I listen to podcasts, audiobooks, and YouTube while doing housework. I get hours of listening in daily. I want to use that time to learn codebases. For that to work, the content has to be genuinely engaging — I have ADHD, so if it's dry or loses momentum, I'll zone out and switch to something else.

## The User Dimension

Every codebase exists because real people need it to do something. I want this narrative to make that human context a first-class part of the story, not an afterthought. Specifically:

- **Start from the user's world, not the code.** Before you explain how something works, make me feel the problem it solves. What was painful, slow, broken, or missing before this thing existed? What does a user's day look like with and without it?
- **Build user personas from evidence.** Look at config options, CLI flags, API surfaces, error messages, onboarding flows, environment variables, documentation, and issue trackers. These are fossils — they tell you who the authors imagined using this and what those people care about. Are there power-user features buried behind flags? Beginner-friendly defaults? Multi-tenant concerns? Accessibility work? Each of these tells a story about a person.
- **Anchor technical decisions in user needs.** Don't just say "they used a cache here." Say "they used a cache here because a user sitting in their editor waiting 800 milliseconds for autocomplete suggestions would feel like the tool is broken, and that's exactly what was happening before this change." Trace backwards from UX to implementation. Every architectural choice is an answer to someone's problem — find that someone.
- **Surface the tensions and tradeoffs users experience.** Where does the software make users choose between competing goods? Simplicity versus power, speed versus correctness, convention versus configuration. These tradeoffs are the most interesting part of any product story.
- **Notice what the codebase reveals about its community.** Is this a solo developer's tool that grew organically? A team product with clear governance? An open-source project with plugin boundaries designed for outside contributors? The shape of the code tells you who participates and how.
- **Look at the edges and error paths.** How the software fails — what error messages say, what recovery paths exist, what gets validated and what gets trusted — tells you more about how users are imagined than the happy path ever will.

Weave this user perspective throughout the narrative. It shouldn't be one isolated chapter called "users" — it should be the connective tissue that makes every technical explanation feel like it matters.

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

1. **The Big Picture** — What is this project? Don't start with what it is — start with the world it was born into. What was the pain? Who was feeling it? What did they try before this existed, and why wasn't it good enough? Then introduce the project as the answer to that story. Make me care about the problem before you reveal the solution.
2. **The People and the Product** — Who actually uses this thing, and what does their workflow look like? Build this from real evidence in the codebase — config schemas, CLI help text, API design choices, error messages, feature flags, environment variables. Paint portraits of the different kinds of users the codebase serves. What do power users unlock that casual users never see? Where has the team bent the architecture to serve a specific audience?
3. **The Architecture Tour** — How is the codebase organized at a high level? What are the major components and how do they relate? Walk through the system like you're giving a tour of a building — but keep connecting rooms back to the people who use them. "This module exists because users needed X, and to deliver X the team had to solve Y."
4. **The Core Loop** — What's the central thing this software does, and how does data flow through it from start to finish? Trace a real request or operation through the system. Start from a user's intent — "a developer opens their editor and types a command" — not from an internal function call.
5. **The Clever Bits** — What are the most interesting design decisions, patterns, or techniques? What surprised you? Where did the authors do something unusual or particularly elegant? For each one, ground it: what user-facing outcome does this cleverness enable?
6. **The Rough Edges** — Where are the TODOs, the tech debt, the compromises? What would you change? Where do users probably feel friction that traces back to something in the code? This keeps it real and is often the most interesting part.

Add, remove, split, or reorder episodes based on what you actually find. The codebase should dictate the structure, not this template.

## Process

1. **Explore first.** Read widely before writing. Understand the codebase thoroughly — entry points, core logic, data models, interesting patterns, dependencies. Read actual source files, not just directory listings. Pay special attention to user-facing surfaces: README, CLI help strings, config schemas, error messages, API documentation, onboarding code, default values, and any issue templates or changelogs. These are where the codebase speaks directly to its users and reveals who it thinks they are.
2. **Then write.** Don't interleave exploration and writing. Get the full picture, then craft the narrative.
3. **Output as a single document** with clear chapter/episode breaks. Plain text, no formatting — remember, this is for TTS.

## What NOT To Do

- Don't ask me a bunch of clarifying questions. Use your judgment.
- Don't produce dry technical documentation dressed up with a few casual phrases.
- Don't summarize at a surface level. I want real depth — the kind of understanding that would let me contribute to this codebase.
- Don't include code snippets. Describe what the code does in words. If a function name or type name is important, say it, but don't read out syntax.
- Don't use emoji, markdown headers, or any visual formatting in the narrative output itself. Chapter titles are fine as plain text labels.
