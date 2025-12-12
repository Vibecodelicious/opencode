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
  process.env.XDG_CACHE_HOME ??= path.join(xdgBase, "cache")
  process.env.XDG_DATA_HOME ??= path.join(xdgBase, "data")
  process.env.XDG_CONFIG_HOME ??= path.join(xdgBase, "config")
  process.env.XDG_STATE_HOME ??= path.join(xdgBase, "state")
  process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

  await Promise.all(
    ["cache", "data", "config", "state"].map((dir) => fs.mkdir(path.join(xdgBase, dir), { recursive: true })),
  )

  const pluginModule = await import("../../src/plugin")
  ;(pluginModule as any).Plugin.list = async () => []

  const { Instance } = await import("../../src/project/instance")
  const { ToolRegistry } = await import("../../src/tool/registry")
  const { CompactTool } = await import("../../src/tool/compact")
  const { RetrieveTool } = await import("../../src/tool/retrieve")

  return { Instance, ToolRegistry, CompactTool, RetrieveTool }
}

const modules = loadModules()

describe("tool.compact and tool.retrieve stubs", () => {
  test("registry ids include compact and retrieve", async () => {
    const { Instance, ToolRegistry } = await modules
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("compact")
        expect(ids).toContain("retrieve")
      },
    })
  })

  test("compact returns stubbed placeholder response", async () => {
    const { Instance, CompactTool } = await modules
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await CompactTool.init()
        const result = await tool.execute(
          { ranges: [{ startMessageId: "abc", endMessageId: "def" }] },
          ctx,
        )
        expect(result.output.toLowerCase()).toContain("not yet implemented")
        expect(result.metadata).toEqual({})
      },
    })
  })

  test("retrieve returns stubbed placeholder response", async () => {
    const { Instance, RetrieveTool } = await modules
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

  test("compact validates ranges", async () => {
    const { Instance, CompactTool } = await modules
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

  test("retrieve validates archiveId", async () => {
    const { Instance, RetrieveTool } = await modules
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
