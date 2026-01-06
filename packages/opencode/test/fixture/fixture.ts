import { $ } from "bun"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"

/**
 * Creates a test session with 3 messages for compact tool testing.
 * Returns the session and message IDs for use in tests.
 */
export async function createTestSession(sessionDir: string) {
  const session = await Session.create({})

  // Create test messages
  const msg1Id = Identifier.ascending("message")
  const msg2Id = Identifier.ascending("message")
  const msg3Id = Identifier.ascending("message")

  // Create user message 1
  await Session.updateMessage({
    id: msg1Id,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: msg1Id,
    type: "text",
    text: "Can you help me understand how the authentication flow works in this codebase? I need to add a new OAuth provider.",
  })

  // Create assistant message 2
  await Session.updateMessage({
    id: msg2Id,
    sessionID: session.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: msg1Id,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    path: { cwd: sessionDir, root: sessionDir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: msg2Id,
    type: "text",
    text: "The authentication flow uses JWT tokens stored in httpOnly cookies. The main entry point is `src/auth/handler.ts` which validates tokens via the `AuthMiddleware` class. For OAuth, you'll need to implement the `OAuthProvider` interface defined in `src/auth/providers/base.ts`.",
  })

  // Create user message 3
  await Session.updateMessage({
    id: msg3Id,
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: msg3Id,
    type: "text",
    text: "Thanks! Can you show me an example of how Google OAuth is implemented? I want to use it as a reference.",
  })

  return { session, msgIds: [msg1Id, msg2Id, msg3Id] }
}

type TmpDirOptions<T> = {
  git?: boolean
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2))
  await $`mkdir -p ${dirpath}`.quiet()
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  const extra = await options?.init?.(dirpath)
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dirpath)
      await $`rm -rf ${dirpath}`.quiet()
    },
    path: realpathSync(dirpath),
    extra: extra as T,
  }
  return result
}
