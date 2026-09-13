import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { loopStorageKey, type LoopState } from "../src/state.ts"
import { createFakeContext, FAKE_DIRECTORY } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"

function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    sessionID: SESSION_ID,
    directory: FAKE_DIRECTORY,
    task: "Build the API",
    promise: "DONE",
    iteration: 2,
    maxIterations: 5,
    paused: false,
    startedAt: new Date(0).toISOString(),
    startCost: 1,
    startTokens: { input: 10, output: 5 },
    ...overrides,
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("/cancel-ralph", () => {
  test("stops an active Loop with reason cancelled and reports the Iteration reached", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    const command = fake.commands.get("cancel-ralph")
    if (!command) throw new Error("cancel-ralph command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    const notice = fake.calls.sessionSynthetic.at(-1)
    expect(notice?.["sessionID"]).toBe(SESSION_ID)
    expect(String(notice?.["text"])).toMatch(/cancelled/i)
    expect(String(notice?.["text"])).toContain("2 Iteration")

    if (typeof cleanup === "function") await cleanup()
  })

  test("posts a no active Loop Notice when there is no Loop", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    const command = fake.commands.get("cancel-ralph")
    if (!command) throw new Error("cancel-ralph command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(fake.calls.sessionSynthetic).toHaveLength(1)
    expect(String(fake.calls.sessionSynthetic[0]?.["text"])).toMatch(/no active/i)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("/ralph-status", () => {
  test("posts a Notice with Iteration, Max Iterations, paused, and Task", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState({ paused: true }))

    const cleanup = await Plugin.setup(fake.context)
    const command = fake.commands.get("ralph-status")
    if (!command) throw new Error("ralph-status command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    const notice = fake.calls.sessionSynthetic.at(-1)
    expect(notice?.["sessionID"]).toBe(SESSION_ID)
    expect(String(notice?.["text"])).toContain("2/5")
    expect(String(notice?.["text"])).toMatch(/paused/i)
    expect(String(notice?.["text"])).toContain("Build the API")

    if (typeof cleanup === "function") await cleanup()
  })

  test("posts a no active Loop Notice when there is no Loop", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    const command = fake.commands.get("ralph-status")
    if (!command) throw new Error("ralph-status command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(fake.calls.sessionSynthetic).toHaveLength(1)
    expect(String(fake.calls.sessionSynthetic[0]?.["text"])).toMatch(/no active/i)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("session.execution.interrupted", () => {
  test("stops the Loop with reason interrupted and posts a Notice", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.interrupted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    const notice = fake.calls.sessionSynthetic.at(-1)
    expect(String(notice?.["text"])).toMatch(/interrupted/i)
    expect(String(notice?.["text"])).toContain("2 Iteration")

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("session.execution.failed", () => {
  test("stops the Loop with reason failed by default (stopOnFailure defaults to true)", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.failed", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    const notice = fake.calls.sessionSynthetic.at(-1)
    expect(String(notice?.["text"])).toMatch(/failed/i)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("with stopOnFailure: false, treats the failure as a Turn End and sends the Continuation Prompt", async () => {
    const fake = createFakeContext({ options: { stopOnFailure: false } })
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    fake.setSessionContext(async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.failed", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(true)
    expect(fake.storage.get(loopStorageKey(SESSION_ID))).toMatchObject({ iteration: 3 })
    expect(fake.calls.sessionPrompt).toHaveLength(1)
    expect(String(fake.calls.sessionPrompt[0]?.["text"])).toContain("[RALPH LOOP - ITERATION 3/5]")
    expect(fake.calls.sessionSynthetic).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("interrupted or failed for a session with no Loop produces no Notice and no storage change", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.interrupted", data: { sessionID: "ses_unrelated" } })
    fake.push({ type: "session.execution.failed", data: { sessionID: "ses_unrelated" } })
    await tick()

    expect(fake.calls.sessionSynthetic).toHaveLength(0)
    expect(fake.storage.has(loopStorageKey("ses_unrelated"))).toBe(false)

    if (typeof cleanup === "function") await cleanup()
  })

  test("a stop handler whose session.synthetic throws leaves the subscription alive for other sessions", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    const otherSessionID = "ses_other"
    fake.storage.set(loopStorageKey(otherSessionID), baseState({ sessionID: otherSessionID }))
    fake.setSessionContext(async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const failingContext = fake.context as unknown as { session: { synthetic: (input: Record<string, unknown>) => Promise<unknown> } }
    const originalSynthetic = failingContext.session.synthetic
    failingContext.session.synthetic = async (input: Record<string, unknown>) => {
      if (input["sessionID"] === SESSION_ID) throw new Error("synthetic boom")
      return originalSynthetic(input)
    }

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.failed", data: { sessionID: SESSION_ID } })
    await tick()
    fake.push({ type: "session.execution.succeeded", data: { sessionID: otherSessionID } })
    await tick()

    expect(fake.calls.sessionPrompt).toHaveLength(1)
    expect(fake.calls.sessionPrompt[0]?.["sessionID"]).toBe(otherSessionID)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("Turn End race with a concurrent stop", () => {
  test("cancel-ralph mid Turn End prevents the write and the Continuation Prompt", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    let resolveContext: (() => void) | undefined
    fake.setSessionContext(async () => {
      await new Promise<void>((resolve) => {
        resolveContext = resolve
      })
      return [
        { type: "user", text: "Do the thing" },
        { type: "assistant", content: [{ type: "text", text: "Still working." }] },
      ]
    })

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const command = fake.commands.get("cancel-ralph")
    if (!command) throw new Error("cancel-ralph command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)

    resolveContext?.()
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("session.deleted", () => {
  test("removes the Loop state without posting a Notice", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.deleted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionSynthetic).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })
})
