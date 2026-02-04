// This file is only used when OPENCODE_BUNDLED_PLUGINS is true
// It provides static imports of default plugins to avoid runtime module resolution issues
import type { Plugin } from "@opencode-ai/plugin"
import * as anthropicAuth from "opencode-anthropic-auth"
import * as copilotAuth from "opencode-copilot-auth"

export const BUNDLED_PLUGINS: Record<string, Record<string, Plugin>> = {
  "opencode-anthropic-auth": anthropicAuth,
  "opencode-copilot-auth": copilotAuth,
}
