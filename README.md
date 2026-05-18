# OpenCode with Context Bonsai integration patches

This is a fork of [OpenCode](https://github.com/anomalyco/opencode) that carries narrow integration patches for Context Bonsai.

## What Context Bonsai is

Context Bonsai gives coding agents a way to manage long conversations without waiting for blunt overflow compaction. The model can archive older, completed parts of the transcript into compact placeholders, keep working with the important summary in view, and retrieve the full archived content later if it becomes relevant again. OpenCode is the reference implementation.

## Two implementations

This repository carries two implementations of Context Bonsai for OpenCode.

**Plugin-based.** The default branch (`surgical_compaction`) carries narrow integration patches on top of upstream OpenCode. The prune/retrieve/gauge logic lives in a separate plugin repo. Both pieces are pinned and coordinated from the parent project, which is the main landing spot for installing and using the plugin-based version:

> [Vibecodelicious/context-bonsai-agents](https://github.com/Vibecodelicious/context-bonsai-agents)

**In-tree.** The prune/retrieve/gauge logic lives inside this fork directly, with no plugin. Preserved on branch [`surgical_compaction_pre_plugin`](https://github.com/Vibecodelicious/opencode/tree/surgical_compaction_pre_plugin).

## Looking for OpenCode itself?

For OpenCode the editor without Context Bonsai, see the upstream project: [anomalyco/opencode](https://github.com/anomalyco/opencode).
