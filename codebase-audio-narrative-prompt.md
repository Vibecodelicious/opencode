# Codebase Audio Narrative Generator

## What I Want

I want you to explore the codebase attached to this session and produce a long-form written narrative about it — structured and written specifically to be consumed as audio via text-to-speech while I do chores.

## Why This Format

I listen to podcasts, audiobooks, and YouTube while doing housework. I get hours of listening in daily. I want to use that time to learn codebases. For that to work, the content has to be genuinely engaging — I have ADHD, so if it's dry or loses momentum, I'll zone out and switch to something else.

## Users and Forces: Why the Code Is Shaped Like This

A codebase isn't just a solution — it's the *specific* solution that survived contact with real constraints. I want this narrative to treat user needs and external forces as the primary explanation for why the code looks the way it does, and not some other way. When I hear about an architectural choice, I should understand what force made it inevitable — or at least defensible.

"User needs" here means the full picture, not just the primary thing the software does:

- **The core job.** What pain existed before this? What were people doing instead, and why was it bad enough that someone built this?
- **Cost and resource constraints.** Does the architecture reveal sensitivity to compute costs, API call volumes, bandwidth, or storage? Are there batching strategies, lazy-loading patterns, tiered pricing logic, or free-tier limitations baked into the design? A codebase that goes out of its way to minimize LLM API calls tells you something very different about its users than one that fires them off freely.
- **Security posture.** How does the codebase handle authentication, authorization, secrets, and trust boundaries? Is security treated as a first-class concern woven throughout, or bolted on at the edges? The security model tells you what the authors believe their threat landscape looks like — and who they think is attacking.
- **Privacy and data handling.** What data does the system collect, store, and transmit? Are there anonymization layers, consent flows, data retention policies, or region-aware storage? These choices reveal what regulatory environments the users operate in and what promises have been made to them.
- **Operational reality.** How is this thing deployed, monitored, and debugged? Self-hosted versus managed? Single-tenant versus multi-tenant? The deployment model tells you who's responsible when things break and how much operational sophistication the user base is expected to have.
- **Ecosystem and integration constraints.** What does this software need to play nicely with? Editor protocols, cloud provider APIs, language server specs, CI systems? Every integration boundary is a constraint imposed by the user's existing world that the codebase had to accommodate.

Use these forces to explain architecture, not just describe it. Don't just say "they used SQLite here" — say "they used SQLite because their users are individual developers running this on their own laptops, and asking those people to set up and maintain a Postgres instance would be a non-starter. That one decision cascades through the entire data layer." Every interesting "why" in a codebase traces back to a force like this.

Beyond these forces, actively reconstruct who uses this thing:

- **Build user personas from evidence.** Look at config options, CLI flags, API surfaces, error messages, onboarding flows, environment variables, documentation, and issue trackers. These are fossils — they tell you who the authors imagined using this and what those people care about. Are there power-user features buried behind flags? Beginner-friendly defaults? Multi-tenant concerns? Accessibility work? Each of these tells a story about a person.
- **Surface the tensions and tradeoffs users experience.** Where does the software make users choose between competing goods? Simplicity versus power, speed versus correctness, convention versus configuration, privacy versus convenience, cost versus capability. These tradeoffs are the most interesting part of any product story.
- **Notice what the codebase reveals about its community.** Is this a solo developer's tool that grew organically? A team product with clear governance? An open-source project with plugin boundaries designed for outside contributors? The shape of the code tells you who participates and how.
- **Look at the edges and error paths.** How the software fails — what error messages say, what recovery paths exist, what gets validated and what gets trusted — tells you more about how users are imagined than the happy path ever will.

Weave this perspective throughout the narrative. It shouldn't be one isolated chapter — it should be the explanatory backbone that makes every technical decision feel like a consequence of real forces rather than an arbitrary choice.

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

1. **The Big Picture** — Don't start with what the project is — start with the world it was born into. What was the pain? Who was feeling it? What did they try before this existed, and why wasn't it good enough? Then introduce the project as the answer to that story. Make me care about the problem before you reveal the solution.
2. **The People and the Forces** — Who actually uses this thing, and what does their world look like? Build this from real evidence in the codebase — config schemas, CLI help text, API design choices, error messages, feature flags, environment variables, pricing logic, auth models, deployment targets. Paint portraits of the different kinds of users the codebase serves. Then lay out the forces that constrain them beyond the primary feature set: cost sensitivity, security requirements, privacy obligations, operational realities, ecosystem integrations. These forces explain *why the code is shaped like this and not some other way.*
3. **The Architecture Tour** — How is the codebase organized at a high level? What are the major components and how do they relate? Walk through the system like you're giving a tour of a building — but for every room, explain the force that shaped it. "This module exists because users needed X, but they also couldn't afford Y, so the team had to solve it with Z." When there were obvious alternative approaches, name them and explain why this one won.
4. **The Core Loop** — What's the central thing this software does, and how does data flow through it from start to finish? Trace a real request or operation through the system. Start from a user's intent — "a developer opens their editor and types a command" — not from an internal function call. As data flows through the system, point out where cost, security, and privacy concerns deflect it from the "simplest possible" path.
5. **The Clever Bits** — What are the most interesting design decisions, patterns, or techniques? What surprised you? Where did the authors do something unusual or particularly elegant? For each one, ground it: what force or constraint made this cleverness necessary? What would have gone wrong with the naive approach?
6. **The Rough Edges** — Where are the TODOs, the tech debt, the compromises? What would you change? Where do users probably feel friction that traces back to something in the code? Where do cost, security, or privacy concerns create awkwardness in the UX? This keeps it real and is often the most interesting part.

Add, remove, split, or reorder episodes based on what you actually find. The codebase should dictate the structure, not this template.

## Process

1. **Explore first.** Read widely before writing. Understand the codebase thoroughly — entry points, core logic, data models, interesting patterns, dependencies. Read actual source files, not just directory listings. Pay special attention to user-facing surfaces: README, CLI help strings, config schemas, error messages, API documentation, onboarding code, default values, and any issue templates or changelogs. These are where the codebase speaks directly to its users and reveals who it thinks they are.
2. **Then write.** Don't interleave exploration and writing. Get the full picture, then craft the narrative.
3. **Output as a single document** with clear chapter/episode breaks. Plain text, no formatting — remember, this is for TTS.

## What NOT To Do

- Don't ask me a bunch of clarifying questions. Use your judgment.
- Don't produce dry technical documentation dressed up with a few casual phrases.
- Don't summarize at a surface level. I want real depth — the kind of understanding that would let me contribute to this codebase.
- Don't describe architecture without explaining *why it's this way and not another way*. "They used X" is incomplete. "They used X because of force Y, and if they'd used Z instead, it would have broken for users because..." is what I'm after.
- Don't include code snippets. Describe what the code does in words. If a function name or type name is important, say it, but don't read out syntax.
- Don't use emoji, markdown headers, or any visual formatting in the narrative output itself. Chapter titles are fine as plain text labels.
