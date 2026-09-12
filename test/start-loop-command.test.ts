import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { HARD_CAP_MAX_ITERATIONS } from "../src/args.ts"
import { loopStorageKey } from "../src/state.ts"
import { createFakeContext } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"

async function setupAndStart(fake: ReturnType<typeof createFakeContext>, text: string, sessionID: string = SESSION_ID) {
  const cleanup = await Plugin.setup(fake.context)
  const command = fake.commands.get("ralph-loop")
  if (!command) throw new Error("ralph-loop command was not registered")
  await command.execute({ sessionID, prompt: { text }, delivery: "steer" })
  return cleanup
}

describe("/ralph-loop starts a Loop", () => {
  test("persists Loop state, posts a start Notice, and sends the Start Prompt", async () => {
    const fake = createFakeContext()

    await setupAndStart(fake, "--max 30 --promise \"TESTS GREEN\" Build the API")

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as Record<string, unknown>
    expect(state).toMatchObject({
      sessionID: SESSION_ID,
      task: "Build the API",
      promise: "TESTS GREEN",
      iteration: 0,
      maxIterations: 30,
      paused: false,
    })
    expect(typeof state["startedAt"]).toBe("string")

    expect(fake.calls.sessionSynthetic).toHaveLength(1)
    const notice = fake.calls.sessionSynthetic[0]
    expect(notice).toBeDefined()
    expect(notice?.["sessionID"]).toBe(SESSION_ID)
    expect(String(notice?.["text"])).toMatch(/started/i)
    expect(String(notice?.["text"])).toContain("30")
    expect(String(notice?.["text"])).toContain("<promise>TESTS GREEN</promise>")

    expect(fake.calls.sessionPrompt).toHaveLength(1)
    const startPrompt = fake.calls.sessionPrompt[0]
    expect(startPrompt).toBeDefined()
    expect(startPrompt?.["sessionID"]).toBe(SESSION_ID)
    expect(startPrompt?.["delivery"]).toBe("steer")
    expect(String(startPrompt?.["text"])).toContain("Build the API")
    expect(String(startPrompt?.["text"])).toContain("<promise>TESTS GREEN</promise>")
    expect(String(startPrompt?.["text"])).toMatch(/Rules:/)
  })

  test("clamps --max above the Hard Cap and says so in the start Notice", async () => {
    const fake = createFakeContext()

    await setupAndStart(fake, "--max 9000 Build the API")

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as Record<string, unknown>
    expect(state["maxIterations"]).toBe(HARD_CAP_MAX_ITERATIONS)

    const notice = fake.calls.sessionSynthetic[0]
    expect(String(notice?.["text"])).toMatch(/hard cap/i)
    expect(String(notice?.["text"])).toContain(String(HARD_CAP_MAX_ITERATIONS))
  })

  test("an unknown flag produces an error Notice and no Loop", async () => {
    const fake = createFakeContext()

    await setupAndStart(fake, "--bogus Build the API")

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionPrompt).toHaveLength(0)
    expect(fake.calls.sessionSynthetic).toHaveLength(1)
    expect(String(fake.calls.sessionSynthetic[0]?.["text"])).toMatch(/unknown flag/i)
  })

  test("an empty Task produces an error Notice and no Loop", async () => {
    const fake = createFakeContext()

    await setupAndStart(fake, "--max 10")

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionPrompt).toHaveLength(0)
    expect(String(fake.calls.sessionSynthetic[0]?.["text"])).toMatch(/task/i)
  })

  test("starting a second Loop in the same session is refused with a Notice", async () => {
    const fake = createFakeContext()

    await setupAndStart(fake, "Build the API")
    const stateAfterFirstStart = fake.storage.get(loopStorageKey(SESSION_ID))

    await setupAndStart(fake, "Build something else")

    expect(fake.storage.get(loopStorageKey(SESSION_ID))).toEqual(stateAfterFirstStart)
    expect(fake.calls.sessionPrompt).toHaveLength(1)
    expect(fake.calls.sessionSynthetic).toHaveLength(2)
    expect(String(fake.calls.sessionSynthetic[1]?.["text"])).toMatch(/already active/i)
  })

  test("plugin options maxIterations and promise supply defaults when no flags are given", async () => {
    const fake = createFakeContext({ options: { maxIterations: 42, promise: "SHIP IT" } })

    await setupAndStart(fake, "Build the API")

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as Record<string, unknown>
    expect(state["maxIterations"]).toBe(42)
    expect(state["promise"]).toBe("SHIP IT")
  })

  test("records startCost and startTokens from ctx.session.get", async () => {
    const fake = createFakeContext({
      sessionGetResult: { id: SESSION_ID, cost: 1.5, tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
    })

    await setupAndStart(fake, "Build the API")

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as Record<string, unknown>
    expect(state["startCost"]).toBe(1.5)
    expect(state["startTokens"]).toEqual({ input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } })
  })
})
