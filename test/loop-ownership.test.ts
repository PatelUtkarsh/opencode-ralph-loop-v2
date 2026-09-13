// One plugin instance owns each Loop (ADR-0006, ticket 10). OpenCode runs
// one plugin instance per loaded location; all instances share `ctx.storage`
// and all receive the whole event stream, and `session.execution.*` events
// carry no `location`. Ownership is therefore recorded on the Loop itself as
// `directory` and every read path ignores a Loop owned by another
// directory.
//
// Each test builds two fakes over one shared storage `Map`, mirroring the
// two instances the live service runs.
import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { resumeLoops } from "../src/resume.ts"
import { loopStorageKey, ownsLoop, type LoopState } from "../src/state.ts"
import { createFakeContext } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"
const DIRECTORY_A = "/tmp/ralph-project-a"
const DIRECTORY_B = "/tmp/ralph-project-b"

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    sessionID: SESSION_ID,
    directory: DIRECTORY_A,
    task: "Build the API",
    promise: "DONE",
    iteration: 1,
    maxIterations: 5,
    paused: false,
    startedAt: new Date(0).toISOString(),
    startCost: 1,
    startTokens: { input: 10, output: 5 },
    ...overrides,
  }
}

/** Builds the two plugin instances the live service runs for two loaded
 * locations: different `ctx.location.directory`, one shared storage Map. */
function twoInstances(sharedStorage: Map<string, unknown>) {
  const a = createFakeContext({ location: { directory: DIRECTORY_A }, storage: sharedStorage })
  const b = createFakeContext({ location: { directory: DIRECTORY_B }, storage: sharedStorage })
  return { a, b }
}

const WORKING_TRANSCRIPT = [
  { type: "user", text: "Do the thing" },
  { type: "assistant", content: [{ type: "text", text: "Still working." }] },
]

describe("two plugin instances sharing one storage", () => {
  test("a Turn End for a Loop owned by directory A sends exactly one Continuation Prompt, from A", async () => {
    const storage = new Map<string, unknown>()
    const { a, b } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState())
    a.setSessionContext(async () => [...WORKING_TRANSCRIPT])
    b.setSessionContext(async () => [...WORKING_TRANSCRIPT])

    const cleanupA = await Plugin.setup(a.context)
    const cleanupB = await Plugin.setup(b.context)

    // The execution events carry no `location`, so both instances see it.
    a.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    b.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(a.calls.sessionPrompt).toHaveLength(1)
    expect(b.calls.sessionPrompt).toHaveLength(0)
    expect(storage.get(loopStorageKey(SESSION_ID))).toMatchObject({ iteration: 2 })

    if (typeof cleanupA === "function") await cleanupA()
    if (typeof cleanupB === "function") await cleanupB()
  })

  test("a completion posts exactly one Notice, from the owning instance", async () => {
    const storage = new Map<string, unknown>()
    const { a, b } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState())
    const completed = [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "<promise>DONE</promise>" }] },
    ]
    a.setSessionContext(async () => [...completed])
    b.setSessionContext(async () => [...completed])

    const cleanupA = await Plugin.setup(a.context)
    const cleanupB = await Plugin.setup(b.context)

    a.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    b.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(a.calls.sessionSynthetic).toHaveLength(1)
    expect(String(a.calls.sessionSynthetic[0]?.["text"])).toMatch(/completed/i)
    expect(b.calls.sessionSynthetic).toHaveLength(0)
    expect(storage.has(loopStorageKey(SESSION_ID))).toBe(false)

    if (typeof cleanupA === "function") await cleanupA()
    if (typeof cleanupB === "function") await cleanupB()
  })

  test("an interrupt posts exactly one stop Notice, from the owning instance", async () => {
    const storage = new Map<string, unknown>()
    const { a, b } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanupA = await Plugin.setup(a.context)
    const cleanupB = await Plugin.setup(b.context)

    a.push({ type: "session.execution.interrupted", data: { sessionID: SESSION_ID } })
    b.push({ type: "session.execution.interrupted", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(a.calls.sessionSynthetic).toHaveLength(1)
    expect(b.calls.sessionSynthetic).toHaveLength(0)

    if (typeof cleanupA === "function") await cleanupA()
    if (typeof cleanupB === "function") await cleanupB()
  })

  test("deleting the Loop Session removes state once, from the owning instance", async () => {
    const storage = new Map<string, unknown>()
    const { a, b } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanupA = await Plugin.setup(a.context)
    const cleanupB = await Plugin.setup(b.context)

    a.push({ type: "session.deleted", data: { sessionID: SESSION_ID } })
    b.push({ type: "session.deleted", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    // Only the owner touches the key. (The `changed` emitter is a
    // module-scope singleton shared by both setups, so `calls.rpcEmit` is
    // not the observable to assert on here; storage is.)
    expect(a.calls.storageRemove).toEqual([loopStorageKey(SESSION_ID)])
    expect(b.calls.storageRemove).toEqual([])

    if (typeof cleanupA === "function") await cleanupA()
    if (typeof cleanupB === "function") await cleanupB()
  })

  test("an instance drains its inbox tracking for a deleted session it does not own", async () => {
    // Note on this seam: `pendingInbox` is module scope, so two fakes in
    // one test process share a single Map, unlike two real instances. To
    // make a leak observable the Loop is owned by a third directory, so
    // the deleting instance is a non-owner and nothing else drains for it.
    const storage = new Map<string, unknown>()
    const { a } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState({ directory: "/tmp/ralph-project-c" }))
    a.setSessionContext(async () => [...WORKING_TRANSCRIPT])

    const cleanup = await Plugin.setup(a.context)

    a.push({ type: "session.inbox.enqueued", data: { sessionID: SESSION_ID, inboxID: "inbox_1", item: { type: "user" } } })
    await tick()

    // Deleting the session must drain that entry even though this instance
    // does not own the Loop, or it leaks for the lifetime of the process.
    a.push({ type: "session.deleted", data: { sessionID: SESSION_ID } })
    await tick()

    // A fresh Loop for the same sessionID, now owned by A, must not be
    // treated as having a pending inbox item: it should continue, not pause.
    storage.set(loopStorageKey(SESSION_ID), baseState({ directory: DIRECTORY_A }))
    a.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(a.calls.sessionPrompt).toHaveLength(1)
    expect(storage.get(loopStorageKey(SESSION_ID))).toMatchObject({ paused: false, iteration: 2 })

    if (typeof cleanup === "function") await cleanup()
  })

  test("/cancel-ralph in directory B for a Loop owned by A posts no active Loop and leaves the Loop alone", async () => {
    const storage = new Map<string, unknown>()
    const { b } = twoInstances(storage)
    const state = baseState()
    storage.set(loopStorageKey(SESSION_ID), state)

    const cleanup = await Plugin.setup(b.context)
    const command = b.commands.get("cancel-ralph")
    if (!command) throw new Error("cancel-ralph command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(String(b.calls.sessionSynthetic[0]?.["text"])).toMatch(/no active/i)
    expect(storage.get(loopStorageKey(SESSION_ID))).toEqual(state)

    if (typeof cleanup === "function") await cleanup()
  })

  test("/ralph-status in directory B for a Loop owned by A posts no active Loop", async () => {
    const storage = new Map<string, unknown>()
    const { b } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(b.context)
    const command = b.commands.get("ralph-status")
    if (!command) throw new Error("ralph-status command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(String(b.calls.sessionSynthetic[0]?.["text"])).toMatch(/no active/i)

    if (typeof cleanup === "function") await cleanup()
  })

  test("the status RPC in directory B reports no Loop for a Loop owned by A", async () => {
    const storage = new Map<string, unknown>()
    const { b } = twoInstances(storage)
    storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(b.context)
    const registration = b.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.(
      { sessionID: SESSION_ID },
      { signal: new AbortController().signal, error: (type: string) => ({ type }) },
    )

    expect(result).toEqual({ notify: true })

    if (typeof cleanup === "function") await cleanup()
  })

  test("Resume in directory B skips a Loop owned by A: no Turn End, no key removal", async () => {
    const storage = new Map<string, unknown>()
    const { b } = twoInstances(storage)
    const state = baseState()
    storage.set(loopStorageKey(SESSION_ID), state)
    // Even a session that no longer exists must not be reaped by a
    // non-owning instance, so make `session.get` reject with not-found.
    b.setSessionGet(async () => {
      throw new Error("not found")
    })

    const calls: string[] = []
    await resumeLoops(b.context, async (sessionID) => {
      calls.push(sessionID)
    })

    expect(calls).toEqual([])
    expect(storage.get(loopStorageKey(SESSION_ID))).toEqual(state)
    expect(b.calls.sessionGet).toHaveLength(0)
  })

  test("/ralph-loop in directory B is refused while A owns a Loop in that session", async () => {
    const storage = new Map<string, unknown>()
    const { b } = twoInstances(storage)
    const state = baseState()
    storage.set(loopStorageKey(SESSION_ID), state)

    const cleanup = await Plugin.setup(b.context)
    const command = b.commands.get("ralph-loop")
    if (!command) throw new Error("ralph-loop command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "Build something else" }, delivery: "steer" })

    // Starting must not silently take a running Loop away from its owner:
    // the owner would keep prompting under the new Task's state.
    expect(storage.get(loopStorageKey(SESSION_ID))).toEqual(state)
    expect(b.calls.sessionPrompt).toHaveLength(0)
    const notice = String(b.calls.sessionSynthetic[0]?.["text"])
    expect(notice).toMatch(/already active/i)
    // The Notice names the owning directory, since it is not this one and
    // /cancel-ralph here would report no active Loop.
    expect(notice).toContain(DIRECTORY_A)

    if (typeof cleanup === "function") await cleanup()
  })

  test("a Loop started in directory A records A as its owner", async () => {
    const storage = new Map<string, unknown>()
    const { a } = twoInstances(storage)

    const cleanup = await Plugin.setup(a.context)
    const command = a.commands.get("ralph-loop")
    if (!command) throw new Error("ralph-loop command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "Build the API" }, delivery: "steer" })

    expect(storage.get(loopStorageKey(SESSION_ID))).toMatchObject({ directory: DIRECTORY_A })

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("ownsLoop", () => {
  test("a value that is not an object is owned by nobody", () => {
    // A corrupt or missing entry must be left alone, not acted on.
    expect(ownsLoop(undefined, DIRECTORY_A)).toBe(false)
    expect(ownsLoop(null, DIRECTORY_A)).toBe(false)
    expect(ownsLoop("loop/ses_x", DIRECTORY_A)).toBe(false)
    expect(ownsLoop(42, DIRECTORY_A)).toBe(false)
  })

  test("a Loop with no recorded directory is owned by any instance", () => {
    const legacy = { ...baseState() } as Record<string, unknown>
    delete legacy["directory"]
    expect(ownsLoop(legacy, DIRECTORY_A)).toBe(true)
    expect(ownsLoop(legacy, DIRECTORY_B)).toBe(true)
  })

  test("a Loop with a recorded directory is owned only by that directory", () => {
    const state = baseState({ directory: DIRECTORY_A })
    expect(ownsLoop(state, DIRECTORY_A)).toBe(true)
    expect(ownsLoop(state, DIRECTORY_B)).toBe(false)
  })
})

describe("a Loop with no recorded directory (written before ADR-0006)", () => {
  test("is claimed by the reading instance and back-filled on the next write", async () => {
    const storage = new Map<string, unknown>()
    const { a } = twoInstances(storage)
    const legacy = { ...baseState() } as Record<string, unknown>
    delete legacy["directory"]
    storage.set(loopStorageKey(SESSION_ID), legacy)
    a.setSessionContext(async () => [...WORKING_TRANSCRIPT])

    const cleanup = await Plugin.setup(a.context)
    a.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    expect(a.calls.sessionPrompt).toHaveLength(1)
    expect(storage.get(loopStorageKey(SESSION_ID))).toMatchObject({ directory: DIRECTORY_A, iteration: 2 })

    if (typeof cleanup === "function") await cleanup()
  })

  test("can be claimed by both instances at the same Turn End (accepted, see ADR-0006)", async () => {
    const storage = new Map<string, unknown>()
    const { a, b } = twoInstances(storage)
    const legacy = { ...baseState() } as Record<string, unknown>
    delete legacy["directory"]
    storage.set(loopStorageKey(SESSION_ID), legacy)
    a.setSessionContext(async () => [...WORKING_TRANSCRIPT])
    b.setSessionContext(async () => [...WORKING_TRANSCRIPT])

    const cleanupA = await Plugin.setup(a.context)
    const cleanupB = await Plugin.setup(b.context)

    a.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    b.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()
    await tick()

    // Pinning the documented outcome rather than implying it: a Loop with
    // no recorded owner is claimed by the read, and both instances read
    // before either wrote, so both act. This is the one case ADR-0006
    // accepts, because it can only happen to a Loop written before that
    // ADR and only until its first write settles the ownership.
    expect(a.calls.sessionPrompt).toHaveLength(1)
    expect(b.calls.sessionPrompt).toHaveLength(1)
    // Whichever wrote last owns it from now on, and it is one of the two.
    const claimed = storage.get(loopStorageKey(SESSION_ID)) as LoopState
    const claimedDirectory = claimed.directory
    expect(claimedDirectory).toBeDefined()
    expect([DIRECTORY_A, DIRECTORY_B]).toContain(claimedDirectory ?? "")

    if (typeof cleanupA === "function") await cleanupA()
    if (typeof cleanupB === "function") await cleanupB()
  })
})
