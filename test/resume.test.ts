import { describe, expect, test } from "bun:test"
import { resumeLoops } from "../src/resume.ts"
import { loopStorageKey, type LoopState } from "../src/state.ts"
import { createFakeContext } from "./fake-context.ts"

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
