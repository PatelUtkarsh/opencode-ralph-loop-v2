// RPC Loop Status contract (ADR-0003, ticket 07): the `status` method and
// the `changed` event registered from `setup`. See spec.md "RPC".
import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { RalphRpc } from "../src/rpc.ts"
import { loopStorageKey, type LoopState } from "../src/state.ts"
import { createFakeContext, FAKE_DIRECTORY } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"
const NO_OP_SIGNAL = new AbortController().signal

/** Stands in for the `{ signal, error }` second argument the RPC runtime
 * passes to a handler. `error` returns the declared failure as a plain
 * object so a test can assert on its `type`, `message`, and `data`. */
function rpcCallContext() {
  return {
    signal: NO_OP_SIGNAL,
    error: (type: string, message: string, data?: unknown) => ({ type, message, data }),
  }
}

function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    sessionID: SESSION_ID,
    directory: FAKE_DIRECTORY,
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

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe("RPC status method", () => {
  test("returns the Loop Status for a session with an active Loop", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState({ paused: true, iteration: 2, maxIterations: 5 }))

    const cleanup = await Plugin.setup(fake.context)
    const registration = fake.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.({ sessionID: SESSION_ID }, rpcCallContext())

    expect(result).toEqual({
      status: {
        iteration: 2,
        maxIterations: 5,
        paused: true,
        task: "Build the API",
        promise: "DONE",
      },
      notify: true,
    })

    if (typeof cleanup === "function") await cleanup()
  })

  test("omits the status key entirely for a session with no Loop", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    const registration = fake.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.({ sessionID: SESSION_ID }, rpcCallContext())

    // A present `status` key holding `undefined` serialises as JSON `null`,
    // which the output schema rejects with an HTTP 500 (ticket 09's live
    // checklist, item 6). The key has to be absent, not undefined.
    expect(Object.keys(result as object)).toEqual(["notify"])
    expect(result).toEqual({ notify: true })

    if (typeof cleanup === "function") await cleanup()
  })

  test("reflects the notify: false plugin option", async () => {
    const fake = createFakeContext({ options: { notify: false } })

    const cleanup = await Plugin.setup(fake.context)
    const registration = fake.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.({ sessionID: SESSION_ID }, rpcCallContext())

    expect(result).toEqual({ notify: false })

    if (typeof cleanup === "function") await cleanup()
  })

  test("returns the declared invalid_input error when sessionID is missing", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    const registration = fake.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.({}, rpcCallContext())

    expect(result).toEqual({
      type: "invalid_input",
      message: "status requires a string sessionID",
      data: { received: "object" },
    })
    expect(fake.calls.storageGet).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("declares invalid_input on the status method", () => {
    expect(RalphRpc.methods.status.errors).toBeDefined()
    expect(Object.keys(RalphRpc.methods.status.errors ?? {})).toContain("invalid_input")
  })
})

describe("RPC changed event", () => {
  test("emits across start, a continue, a pause, an unpause, and a cancel stop", async () => {
    const fake = createFakeContext({ permissionListResult: [] })

    const cleanup = await Plugin.setup(fake.context)

    // Start
    const command = fake.commands.get("ralph-loop")
    if (!command) throw new Error("ralph-loop command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "Build the API" }, delivery: "steer" })

    expect(fake.calls.rpcEmit).toHaveLength(1)
    expect(fake.calls.rpcEmit[0]).toEqual({
      name: "changed",
      data: {
        sessionID: SESSION_ID,
        status: { iteration: 0, maxIterations: 100, paused: false, task: "Build the API", promise: "DONE" },
      },
    })

    // Continue: one Turn End with no permission, no question, no promise
    fake.setSessionContext(async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toHaveLength(2)
    expect(fake.calls.rpcEmit[1]).toEqual({
      name: "changed",
      data: {
        sessionID: SESSION_ID,
        status: { iteration: 1, maxIterations: 100, paused: false, task: "Build the API", promise: "DONE" },
      },
    })

    // Pause: a permission request is now pending
    fake.setPermissionList(async () => [{ id: "perm_1" }])
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toHaveLength(3)
    expect(fake.calls.rpcEmit[2]).toEqual({
      name: "changed",
      data: {
        sessionID: SESSION_ID,
        status: { iteration: 1, maxIterations: 100, paused: true, task: "Build the API", promise: "DONE" },
      },
    })

    // Unpause: the permission clears and the next Turn End continues
    fake.setPermissionList(async () => [])
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toHaveLength(4)
    expect(fake.calls.rpcEmit[3]).toEqual({
      name: "changed",
      data: {
        sessionID: SESSION_ID,
        status: { iteration: 2, maxIterations: 100, paused: false, task: "Build the API", promise: "DONE" },
      },
    })

    // Stop: /cancel-ralph
    const cancelCommand = fake.commands.get("cancel-ralph")
    if (!cancelCommand) throw new Error("cancel-ralph command was not registered")
    await cancelCommand.execute({ sessionID: SESSION_ID, prompt: { text: "" }, delivery: "steer" })

    expect(fake.calls.rpcEmit).toHaveLength(5)
    expect(fake.calls.rpcEmit[4]).toEqual({
      name: "changed",
      data: { sessionID: SESSION_ID, status: undefined, reason: "cancelled" },
    })

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits nothing for a Skipped Idle on an already paused Loop", async () => {
    const fake = createFakeContext({ permissionListResult: [{ id: "perm_1" }] })
    fake.storage.set(loopStorageKey(SESSION_ID), baseState({ paused: true }))

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toHaveLength(0)
    expect(fake.calls.storageSet).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits status: undefined with the Stop Reason for an interrupt", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.interrupted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toEqual([
      { name: "changed", data: { sessionID: SESSION_ID, status: undefined, reason: "interrupted" } },
    ])

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits status: undefined with the Stop Reason for a failure", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.failed", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toEqual([
      { name: "changed", data: { sessionID: SESSION_ID, status: undefined, reason: "failed" } },
    ])

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits status: undefined with the Stop Reason at Max Iterations", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState({ iteration: 3, maxIterations: 3 }))
    fake.setSessionContext(async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toEqual([
      { name: "changed", data: { sessionID: SESSION_ID, status: undefined, reason: "max-iterations" } },
    ])

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits status: undefined with the Stop Reason on a Completion Promise", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    fake.setSessionContext(async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "<promise>DONE</promise>" }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toEqual([
      { name: "changed", data: { sessionID: SESSION_ID, status: undefined, reason: "completed" } },
    ])

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits status: undefined with reason deleted when the Loop Session is deleted", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.deleted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toEqual([
      { name: "changed", data: { sessionID: SESSION_ID, status: undefined, reason: "deleted" } },
    ])
    // A deleted session gets no Notice: there is no transcript left to post to.
    expect(fake.calls.sessionSynthetic).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("emits nothing when a session with no Loop is deleted", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.deleted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.rpcEmit).toHaveLength(0)
    expect(fake.calls.storageRemove).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("a broken changed subscriber never breaks the Loop", () => {
  test("swallows a rejecting emitter and still stops the Loop", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    fake.setRpcEmit(async () => {
      throw new Error("subscriber rejected")
    })

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.interrupted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionSynthetic).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })

  test("swallows an emitter that throws synchronously and still stops the Loop", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    // Not `async`: this throws before it ever produces a promise, so a
    // `.catch` on the return value alone would not contain it.
    fake.setRpcEmit((() => {
      throw new Error("subscriber threw")
    }) as () => Promise<void>)

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.interrupted", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionSynthetic).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("the changed emitter is per-setup", () => {
  test("one plugin's cleanup does not clear a later plugin's emitter", async () => {
    const first = createFakeContext()
    const second = createFakeContext()

    const firstCleanup = await Plugin.setup(first.context)
    const secondCleanup = await Plugin.setup(second.context)

    // The first setup tears down after the second installed its emitter.
    // Clearing the singleton unconditionally here would silence the second.
    if (typeof firstCleanup === "function") await firstCleanup()

    const command = second.commands.get("ralph-loop")
    if (!command) throw new Error("ralph-loop command was not registered")
    await command.execute({ sessionID: SESSION_ID, prompt: { text: "Build the API" }, delivery: "steer" })

    expect(second.calls.rpcEmit).toHaveLength(1)
    expect(first.calls.rpcEmit).toHaveLength(0)

    if (typeof secondCleanup === "function") await secondCleanup()
  })
})
