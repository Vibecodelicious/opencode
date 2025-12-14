import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const ctx = {
  sessionID: "test",
  messageID: "",
  toolCallID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

const projectRoot = path.join(__dirname, "../..")
const xdgBase = path.join(projectRoot, ".tmp", "xdg")

async function loadModules() {
  const { Instance } = await import("../../src/project/instance")
  const { ToolRegistry } = await import("../../src/tool/registry")
  const { CompactTool } = await import("../../src/tool/compact")
  const { RetrieveTool } = await import("../../src/tool/retrieve")
  const pluginModule = await import("../../src/plugin")

  return { Instance, ToolRegistry, CompactTool, RetrieveTool, pluginModule }
}

type Modules = Awaited<ReturnType<typeof loadModules>>

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]))
}

async function ensureXdgDirs() {
  const bases = ["cache", "data", "config", "state"]
  await Promise.all(
    bases.flatMap((dir) => [
      fs.mkdir(path.join(xdgBase, dir), { recursive: true }),
      fs.mkdir(path.join(xdgBase, dir, "opencode"), { recursive: true }),
    ]),
  )
}

async function withSandbox(
  fn: (mods: Omit<Modules, "pluginModule">) => Promise<void>,
  options: { config?: Record<string, unknown> } = {},
) {
  const previousEnv = snapshotEnv([
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_PERMISSION",
    "OPENCODE_COMPACTION_MODE",
    "OPENCODE_DISABLE_AUTOCOMPACT",
  ])

  process.env.XDG_CACHE_HOME = path.join(xdgBase, "cache")
  process.env.XDG_DATA_HOME = path.join(xdgBase, "data")
  process.env.XDG_CONFIG_HOME = path.join(xdgBase, "config")
  process.env.XDG_STATE_HOME = path.join(xdgBase, "state")
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

  if (options.config) {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(options.config)
  }

  await ensureXdgDirs()

  const mods = await loadModules()
  const previousPluginList = mods.pluginModule.Plugin.list

  ;(mods.pluginModule as any).Plugin.list = async () => []
  await mods.Instance.disposeAll()

  try {
    await fn({ Instance: mods.Instance, ToolRegistry: mods.ToolRegistry, CompactTool: mods.CompactTool, RetrieveTool: mods.RetrieveTool })
  } finally {
    mods.pluginModule.Plugin.list = previousPluginList
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await mods.Instance.disposeAll()
    await fs.rm(xdgBase, { recursive: true, force: true })
  }
}

async function withConfig(config: Record<string, unknown>, fn: (mods: Omit<Modules, "pluginModule">) => Promise<void>) {
  return withSandbox(fn, { config })
}

describe("tool.compact and tool.retrieve stubs", () => {
  test("registry ids include compact and retrieve", async () => {
    await withSandbox(async ({ Instance, ToolRegistry }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("compact")
          expect(ids).toContain("retrieve")
        },
      })
    })
  })

  test("compact returns stubbed placeholder response", async () => {
    await withSandbox(async ({ Instance, CompactTool }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tool = await CompactTool.init()
          const result = await tool.execute({ ranges: [{ startMessageId: "abc", endMessageId: "def" }] }, ctx)
          expect(result.output.toLowerCase()).toContain("not yet implemented")
          expect(result.metadata).toEqual({})
        },
      })
    })
  })

  test("retrieve returns stubbed placeholder response", async () => {
    await withSandbox(async ({ Instance, RetrieveTool }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tool = await RetrieveTool.init()
          const result = await tool.execute({ archiveId: "archive-1" }, ctx)
          expect(result.output.toLowerCase()).toContain("not yet implemented")
          expect(result.metadata).toEqual({})
        },
      })
    })
  })

  test("registry honors batch experimental flag", async () => {
    await withConfig({}, async ({ Instance, ToolRegistry }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tools = await ToolRegistry.tools("opencode", "model")
          const ids = tools.map((tool) => tool.id)
          expect(ids).not.toContain("batch")
        },
      })
    })

    await withConfig({ experimental: { batch_tool: true } }, async ({ Instance, ToolRegistry }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tools = await ToolRegistry.tools("opencode", "model")
          const ids = tools.map((tool) => tool.id)
          expect(ids).toContain("batch")
        },
      })
    })
  })

  test("registry filters provider-specific tools", async () => {
    await withConfig({}, async ({ Instance, ToolRegistry }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const opencodeTools = await ToolRegistry.tools("opencode", "model")
          const otherProviderTools = await ToolRegistry.tools("anthropic", "model")

          const opencodeIds = opencodeTools.map((tool) => tool.id)
          const otherIds = otherProviderTools.map((tool) => tool.id)

          expect(opencodeIds).toContain("codesearch")
          expect(opencodeIds).toContain("websearch")
          expect(otherIds).not.toContain("codesearch")
          expect(otherIds).not.toContain("websearch")
        },
      })
    })
  })

  test("registry keeps compact/retrieve ordering after codesearch", async () => {
    await withSandbox(async ({ Instance, ToolRegistry }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const ids = (await ToolRegistry.tools("opencode", "model")).map((tool) => tool.id)
          const codeSearchIdx = ids.indexOf("codesearch")
          const compactIdx = ids.indexOf("compact")
          const retrieveIdx = ids.indexOf("retrieve")

          expect(codeSearchIdx).toBeGreaterThanOrEqual(0)
          expect(compactIdx).toBeGreaterThan(codeSearchIdx)
          expect(retrieveIdx).toBeGreaterThan(compactIdx)
        },
      })
    })
  })

  test("batch tool ordering stays after retrieve when enabled", async () => {
    await withConfig({ experimental: { batch_tool: true } }, async ({ Instance, ToolRegistry }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const ids = (await ToolRegistry.tools("opencode", "model")).map((tool) => tool.id)
          const retrieveIdx = ids.indexOf("retrieve")
          const batchIdx = ids.indexOf("batch")

          expect(retrieveIdx).toBeGreaterThanOrEqual(0)
          expect(batchIdx).toBeGreaterThan(retrieveIdx)
        },
      })
    })
  })

  test("compact validates ranges", async () => {
    await withSandbox(async ({ Instance, CompactTool }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tool = await CompactTool.init()
          const promise = (async () => {
            await tool.execute({ ranges: [] }, ctx)
          })()
          await expect(promise).rejects.toThrow(/ranges/i)
        },
      })
    })
  })

  test("retrieve validates archiveId", async () => {
    await withSandbox(async ({ Instance, RetrieveTool }) => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const tool = await RetrieveTool.init()
          const promise = (async () => {
            await tool.execute({ archiveId: "" }, ctx)
          })()
          await expect(promise).rejects.toThrow(/archiveId/i)
        },
      })
    })
  })
})
