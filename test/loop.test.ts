import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import type { TranscriptMessage } from "../src/loop.ts"
import { loopStorageKey, type LoopState } from "../src/state.ts"
import { createFakeContext } from "./fake-context.ts"

const SESSION_ID = "ses_ralph"

/** Overrides `ctx.session.context` for a test to return a fixed message list. */
function stubSessionContext(
  fake: ReturnType<typeof createFakeContext>,
  handler: (input: Record<string, unknown>) => Promise<TranscriptMessage[]>,
): void {
  fake.setSessionContext(handler)
}

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

describe("Turn End: continue or complete", () => {
  test("sends the next Continuation Prompt when the Completion Promise is absent", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.iteration).toBe(2)
    expect(state.paused).toBe(false)

    expect(fake.calls.sessionPrompt).toHaveLength(1)
    const prompt = fake.calls.sessionPrompt[0]
    expect(String(prompt?.["text"])).toContain("[RALPH LOOP - ITERATION 2/3]")
    expect(String(prompt?.["text"])).toContain("Build the API")

    if (typeof cleanup === "function") await cleanup()
  })

  test("stops with a completion Notice, removes state, and reports deltas", async () => {
    const fake = createFakeContext({ sessionGetResult: { id: SESSION_ID, cost: 2.5, tokens: { input: 30, output: 15 } } })
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "<promise>DONE</promise>" }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    const notice = fake.calls.sessionSynthetic.at(-1)
    expect(notice?.["sessionID"]).toBe(SESSION_ID)
    expect(String(notice?.["text"])).toMatch(/completed/i)
    expect(String(notice?.["text"])).toContain("after 1 Iteration")
    expect(String(notice?.["text"])).toContain("Cost delta: +1.5")
    expect(String(notice?.["text"])).toContain("Token delta: +30")

    if (typeof cleanup === "function") await cleanup()
  })

  test("stops with a Max Iterations Notice when the cap is reached", async () => {
    const fake = createFakeContext({ sessionGetResult: { id: SESSION_ID, cost: 5, tokens: { input: 100, output: 50 } } })
    fake.storage.set(loopStorageKey(SESSION_ID), baseState({ iteration: 3, maxIterations: 3 }))
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.storage.has(loopStorageKey(SESSION_ID))).toBe(false)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    const notice = fake.calls.sessionSynthetic.at(-1)
    expect(String(notice?.["text"])).toMatch(/max iterations/i)
    expect(String(notice?.["text"])).toContain("3/3")
    expect(String(notice?.["text"])).toContain("Cost delta: +4")
    expect(String(notice?.["text"])).toContain("Token delta: +135")

    if (typeof cleanup === "function") await cleanup()
  })

  test("drops a second Turn End for the same session while one is being handled", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    let resolveContext: (() => void) | undefined
    let callCount = 0
    stubSessionContext(fake, async () => {
      callCount += 1
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
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(callCount).toBe(1)
    resolveContext?.()
    await tick()

    expect(fake.calls.sessionPrompt).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })

  test("ignores an event whose location.directory differs from the plugin's", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({
      type: "session.execution.succeeded",
      data: { sessionID: SESSION_ID },
      location: { directory: "/somewhere/else" },
    })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.iteration).toBe(1)
    expect(fake.calls.sessionPrompt).toHaveLength(0)
    expect(fake.calls.sessionContext).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("ignores session.idle", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.idle", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.sessionContext).toHaveLength(0)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("ignores a session with no Loop in storage", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: "ses_unrelated" } })
    await tick()

    expect(fake.calls.sessionContext).toHaveLength(0)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("a thrown error handling one session's Turn End does not stop another session's Loop", async () => {
    const fake = createFakeContext()
    const failingSessionID = "ses_failing"
    fake.storage.set(loopStorageKey(failingSessionID), baseState({ sessionID: failingSessionID }))
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())

    stubSessionContext(fake, async (input) => {
      if (input["sessionID"] === failingSessionID) throw new Error("boom")
      return [
        { type: "user", text: "Do the thing" },
        { type: "assistant", content: [{ type: "text", text: "Still working." }] },
      ]
    })

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: failingSessionID } })
    await tick()
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    expect(fake.calls.sessionPrompt).toHaveLength(1)
    expect(fake.calls.sessionPrompt[0]?.["sessionID"]).toBe(SESSION_ID)

    const failingState = fake.storage.get(loopStorageKey(failingSessionID)) as LoopState
    expect(failingState.iteration).toBe(1)

    if (typeof cleanup === "function") await cleanup()
  })
})

describe("Turn End: Skipped Idle (ADR-0002)", () => {
  test("pauses when a permission request is pending", async () => {
    const fake = createFakeContext({ permissionListResult: [{ id: "perm_1" }] })
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.paused).toBe(true)
    expect(state.iteration).toBe(1)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("pauses when the last assistant message has an open question tool call", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "One moment." },
          { type: "tool", name: "ask_user", state: { status: "running" } },
        ],
      },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.paused).toBe(true)
    expect(state.iteration).toBe(1)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    if (typeof cleanup === "function") await cleanup()
  })

  test("does not pause on a running task tool call (name contains ask but is not a whole word)", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "Delegating." },
          { type: "tool", name: "task", state: { status: "running" } },
        ],
      },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.paused).toBe(false)
    expect(state.iteration).toBe(2)
    expect(fake.calls.sessionPrompt).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })

  test("does not pause on a completed question tool call", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "Answered already." },
          { type: "tool", name: "question", state: { status: "completed" } },
        ],
      },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.paused).toBe(false)
    expect(state.iteration).toBe(2)
    expect(fake.calls.sessionPrompt).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })

  test("pauses when the session inbox has a pending user item, and resumes once it is delivered", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)

    fake.push({ type: "session.inbox.enqueued", data: { sessionID: SESSION_ID, inboxID: "inbox_1", item: { type: "user" } } })
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const pausedState = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(pausedState.paused).toBe(true)
    expect(pausedState.iteration).toBe(1)
    expect(fake.calls.sessionPrompt).toHaveLength(0)

    fake.push({ type: "session.inbox.delivered", data: { sessionID: SESSION_ID, inboxID: "inbox_1" } })
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const resumedState = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(resumedState.paused).toBe(false)
    expect(resumedState.iteration).toBe(2)
    expect(fake.calls.sessionPrompt).toHaveLength(1)
    expect(String(fake.calls.sessionPrompt[0]?.["text"])).toContain("[RALPH LOOP - ITERATION 2/3]")

    if (typeof cleanup === "function") await cleanup()
  })

  test("a pending permission and an open question at the same Turn End still pause once", async () => {
    const fake = createFakeContext({ permissionListResult: [{ id: "perm_1" }] })
    fake.storage.set(loopStorageKey(SESSION_ID), baseState())
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      {
        type: "assistant",
        content: [
          { type: "text", text: "One moment." },
          { type: "tool", name: "ask_user", state: { status: "running" } },
        ],
      },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.paused).toBe(true)
    expect(fake.calls.sessionPrompt).toHaveLength(0)
    expect(fake.calls.storageSet).toHaveLength(1)

    if (typeof cleanup === "function") await cleanup()
  })

  test("resumes on the next Turn End once none of the pause causes remain", async () => {
    const fake = createFakeContext()
    fake.storage.set(loopStorageKey(SESSION_ID), baseState({ paused: true }))
    stubSessionContext(fake, async () => [
      { type: "user", text: "Do the thing" },
      { type: "assistant", content: [{ type: "text", text: "Still working." }] },
    ])

    const cleanup = await Plugin.setup(fake.context)
    fake.push({ type: "session.execution.succeeded", data: { sessionID: SESSION_ID } })
    await tick()

    const state = fake.storage.get(loopStorageKey(SESSION_ID)) as LoopState
    expect(state.paused).toBe(false)
    expect(state.iteration).toBe(2)
    expect(fake.calls.sessionPrompt).toHaveLength(1)
    expect(String(fake.calls.sessionPrompt[0]?.["text"])).toContain("[RALPH LOOP - ITERATION 2/3]")

    if (typeof cleanup === "function") await cleanup()
  })
})
