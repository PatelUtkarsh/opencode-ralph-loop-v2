// RPC Loop Status contract (ADR-0003, ticket 07): the `status` method and
// the `changed` event registered from `setup`. See spec.md "RPC".
import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { loopStorageKey, type LoopState } from "../src/state.ts"
import { createFakeContext } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"
const NO_OP_SIGNAL = new AbortController().signal

function baseState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    sessionID: SESSION_ID,
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

    const result = await registration.handlers["status"]?.({ sessionID: SESSION_ID }, { signal: NO_OP_SIGNAL })

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

  test("returns status: undefined for a session with no Loop", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    const registration = fake.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.({ sessionID: SESSION_ID }, { signal: NO_OP_SIGNAL })

    expect(result).toEqual({ status: undefined, notify: true })

    if (typeof cleanup === "function") await cleanup()
  })

  test("reflects the notify: false plugin option", async () => {
    const fake = createFakeContext({ options: { notify: false } })

    const cleanup = await Plugin.setup(fake.context)
    const registration = fake.rpcRegistrations[0]
    if (!registration) throw new Error("ralph-loop RPC was not registered")

    const result = await registration.handlers["status"]?.({ sessionID: SESSION_ID }, { signal: NO_OP_SIGNAL })

    expect(result).toEqual({ status: undefined, notify: false })

    if (typeof cleanup === "function") await cleanup()
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
    const withPermission = fake.context as unknown as { permission: { list: (input: Record<string, unknown>) => Promise<unknown[]> } }
    withPermission.permission.list = async () => [{ id: "perm_1" }]
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
    withPermission.permission.list = async () => []
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
})
