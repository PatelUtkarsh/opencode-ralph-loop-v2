import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { resumeLoops } from "../src/resume.ts"
import { loopStorageKey, type LoopState } from "../src/state.ts"
import { createFakeContext } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    sessionID: "ses_x",
    task: "Build the API",
    promise: "DONE",
    iteration: 1,
    maxIterations: 3,
    paused: false,
    startedAt: new Date(0).toISOString(),
    startCost: 1,
    startTokens: { input: 10, output: 5 },
    ...overrides,
  }
}

describe("resumeLoops", () => {
  test("drops a Loop whose session no longer exists: key removed, no Turn End handler call", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey("ses_x"), baseState())
    fake.setSessionGet(async () => {
      throw new Error("not found")
    })

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(fake.storage.has(loopStorageKey("ses_x"))).toBe(false)
    expect(calls).toEqual([])
  })

  test("re-prompts an idle session: Turn End handler is invoked", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey("ses_x"), baseState())
    fake.setSessionGet(async () => ({
      id: "ses_x",
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 0, updated: 100, idle: 150 },
    }))

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(calls).toEqual(["ses_x"])
  })

  test("leaves a busy session untouched: no Turn End handler call, state unchanged", async () => {
    const fake = createFakeContext()
    const state = baseState()
    fake.storage.set(loopStorageKey("ses_x"), state)
    fake.setSessionGet(async () => ({
      id: "ses_x",
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 0, updated: 100 },
    }))

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(calls).toEqual([])
    expect(fake.storage.get(loopStorageKey("ses_x"))).toEqual(state)
  })

  test("a transient session.get error keeps the key and sends no prompt", async () => {
    const fake = createFakeContext()
    const state = baseState()
    fake.storage.set(loopStorageKey("ses_x"), state)
    fake.setSessionGet(async () => {
      throw new Error("ECONNRESET")
    })

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(calls).toEqual([])
    expect(fake.storage.get(loopStorageKey("ses_x"))).toEqual(state)
  })

  test("outcome set counts as idle even without a time.idle value", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey("ses_x"), baseState())
    fake.setSessionGet(async () => ({
      id: "ses_x",
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 0, updated: 100 },
      outcome: "succeeded",
    }))

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(calls).toEqual(["ses_x"])
  })

  test("a failing scan does not throw out of resumeLoops", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey("ses_x"), baseState())
    // The real `storage.scan` is readonly on the Context type; cast to a
    // mutable view just for this one test seam, to simulate the backend
    // rejecting the scan call itself.
    const mutableStorage = fake.context.storage as unknown as { scan: (options: { prefix: string; after?: string }) => Promise<never> }
    mutableStorage.scan = async () => {
      throw new Error("scan unavailable")
    }

    const calls: string[] = []
    await expect(
      resumeLoops(fake.context, async (sessionID) => {
        calls.push(sessionID)
      }),
    ).resolves.toBeUndefined()

    expect(calls).toEqual([])
  })

  test("onTurnEnd throwing for one entry still processes the next entry", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey("ses_a"), baseState({ sessionID: "ses_a" }))
    fake.storage.set(loopStorageKey("ses_b"), baseState({ sessionID: "ses_b" }))
    fake.setSessionGet(async () => ({
      id: "unused",
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 0, updated: 100, idle: 150 },
    }))

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
      if (sessionID === "ses_a") throw new Error("boom")
    })

    expect(calls.sort()).toEqual(["ses_a", "ses_b"])
  })

  test("Resume and a racing live Turn End event for the same session send exactly one Continuation Prompt", async () => {
    const fake = createFakeContext()
    fake.storage.set(
      loopStorageKey(SESSION_ID),
      baseState({ sessionID: SESSION_ID, task: "Build the API", promise: "DONE", iteration: 1, maxIterations: 3 }),
    )
    fake.setSessionGet(async () => ({
      id: SESSION_ID,
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 0, updated: 100, idle: 150 },
    }))
    fake.setSessionContext(async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    // Fire the live event right away, racing Resume's own scan-and-check.
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(fake.calls.sessionPrompt).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })

  test("follows the scan cursor across two pages", async () => {
    // storageScanPageSize forces the fake to return one entry per call, so
    // resumeLoops must follow the returned `next` cursor to see both Loops.
    const fake = createFakeContext({ storageScanPageSize: 1 })
    fake.storage.set(loopStorageKey("ses_a"), baseState({ sessionID: "ses_a" }))
    fake.storage.set(loopStorageKey("ses_b"), baseState({ sessionID: "ses_b" }))
    fake.setSessionGet(async () => ({
      id: "unused",
      cost: 0,
      tokens: { input: 0, output: 0 },
      time: { created: 0, updated: 100, idle: 150 },
    }))

    const calls: string[] = []
    await resumeLoops(fake.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(fake.calls.storageScan.length).toBe(2)
    expect(calls.sort()).toEqual(["ses_a", "ses_b"])
  })
})
