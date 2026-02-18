// This file is only used when OPENCODE_BUNDLED_PLUGINS is true
// It provides static imports of default plugins to avoid runtime module resolution issues
import type { Plugin } from "@opencode-ai/plugin"

// These packages ship without TypeScript declaration files
// eslint-disable-next-line @typescript-eslint/no-require-imports
const anthropicAuth = require("opencode-anthropic-auth") as Record<string, Plugin>
// eslint-disable-next-line @typescript-eslint/no-require-imports
const copilotAuth = require("opencode-copilot-auth") as Record<string, Plugin>

export const BUNDLED_PLUGINS: Record<string, Record<string, Plugin>> = {
  "opencode-anthropic-auth": anthropicAuth,
  "opencode-copilot-auth": copilotAuth,
}
