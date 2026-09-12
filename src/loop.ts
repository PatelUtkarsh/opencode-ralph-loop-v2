// Turn End handling: continues a Loop with the next Continuation Prompt, or
// stops it with a completion / max-iterations Notice. See spec.md "Turn End
// detection" and "On Turn End", and ADR-0004 (session.execution.succeeded,
// never session.idle).
import type { Plugin } from "@opencode/plugin"
import { buildCompletionNotice, buildContinuationPrompt, buildMaxIterationsNotice } from "./prompts.ts"
import { readLoopState, removeLoopState, writeLoopState, type LoopState, type LoopTokenUsage } from "./state.ts"

type Context = Plugin.Context

/** A single transcript message returned by `ctx.session.context`. Assistant
 * messages carry `content` parts; user and synthetic messages carry `text`
 * directly (see the architecture skill, section 5). A `tool` content part
 * (assumed shape, not confirmed against a live server) additionally carries
 * an optional `name` and an optional `state.status`, used by the Skipped
 * Idle question check (ADR-0002). */
export interface TranscriptMessage {
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{
    readonly type: string
    readonly text?: string
    readonly name?: string
    readonly state?: { readonly status?: string }
  }>
}

/** Narrows an unknown value to a `TranscriptMessage`. Anything that does not
 * match the shape is dropped rather than trusted, since it comes from the
 * OpenCode server at runtime. */
function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  if (typeof value !== "object" || value === null) return false
  const message = value as Record<string, unknown>
  if (typeof message["type"] !== "string") return false
  if (message["text"] !== undefined && typeof message["text"] !== "string") return false
  if (message["content"] !== undefined) {
    if (!Array.isArray(message["content"])) return false
    for (const part of message["content"] as unknown[]) {
      if (typeof part !== "object" || part === null) return false
      const partRecord = part as Record<string, unknown>
      if (typeof partRecord["type"] !== "string") return false
      if (partRecord["text"] !== undefined && typeof partRecord["text"] !== "string") return false
      if (partRecord["name"] !== undefined && typeof partRecord["name"] !== "string") return false
      if (partRecord["state"] !== undefined) {
        if (typeof partRecord["state"] !== "object" || partRecord["state"] === null) return false
        const state = partRecord["state"] as Record<string, unknown>
        if (state["status"] !== undefined && typeof state["status"] !== "string") return false
      }
    }
  }
  return true
}

/** Narrows an unknown value to the `{ cost, tokens }` shape `ctx.session.get`
 * returns. Anything that does not match is treated as missing rather than
 * trusted. */
function isSessionCostInfo(value: unknown): value is { cost: number; tokens: LoopTokenUsage } {
  if (typeof value !== "object" || value === null) return false
  const info = value as Record<string, unknown>
  if (typeof info["cost"] !== "number") return false
  const tokens = info["tokens"]
  if (typeof tokens !== "object" || tokens === null) return false
  const tokenRecord = tokens as Record<string, unknown>
  return typeof tokenRecord["input"] === "number" && typeof tokenRecord["output"] === "number"
}

/** Regex-escapes a string so it can be embedded literally in a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Why a Turn End was skipped instead of continuing the Loop (ADR-0002). */
export type SkippedIdleReason = "permission" | "question" | "inbox"

/** True when the last assistant message contains a question/ask tool call
 * (name containing "question" or "ask", case-insensitive) that has no
 * completed result. Assumed shape: `{ type: "tool", name?, state?: { status } }`
 * (see the architecture skill, section 5, and the docstring on
 * `TranscriptMessage`); this shape has not been confirmed against a live
 * server. */
function hasOpenQuestionToolCall(messages: readonly TranscriptMessage[]): boolean {
  let lastAssistant: TranscriptMessage | undefined
  for (const message of messages) {
    if (message.type === "assistant") lastAssistant = message
  }
  if (lastAssistant === undefined) return false

  for (const part of lastAssistant.content ?? []) {
    if (part.type !== "tool") continue
    const name = (part.name ?? "").toLowerCase()
    if (!name.includes("question") && !name.includes("ask")) continue
    if (part.state?.status !== "completed") return true
  }
  return false
}

/** Narrows an unknown value to the `{ time: { updated, idle? } }` shape
 * `ctx.session.get` returns. Anything that does not match is treated as
 * missing rather than trusted. */
function isSessionTimeInfo(value: unknown): value is { time: { updated: number; idle?: number } } {
  if (typeof value !== "object" || value === null) return false
  const time = (value as Record<string, unknown>)["time"]
  if (typeof time !== "object" || time === null) return false
  const timeRecord = time as Record<string, unknown>
  if (typeof timeRecord["updated"] !== "number") return false
  if (timeRecord["idle"] !== undefined && typeof timeRecord["idle"] !== "number") return false
  return true
}

/**
 * Fallback for a pending inbox item (spec.md step 3). `ctx.session`'s
 * `SessionDomain` (`node_modules/@opencode/plugin/dist/promise/session.d.ts`)
 * is `Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" |
 * "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "rename" |
 * "move" | "wait" | "context">`: no `inbox`. `Plugin.Context` has no other
 * client handle either (no `context.client`), so there is no way to read
 * the inbox directly from a plugin. This reads `ctx.session.get` instead
 * and treats the Turn End as having a pending inbox item when the session's
 * `time.idle` is still undefined while `time.updated` is newer than `since`
 * (the last Turn End this module handled for the session, or the Loop's
 * `startedAt` for the first one). This is a known-weak heuristic, recorded
 * in the ticket comments: `time.idle` is normally set by the time a
 * `session.execution.succeeded` event reaches this handler, so this branch
 * is expected to fire rarely, only in a narrow timing race, not on every
 * queued message.
 */
async function hasPendingInboxItem(context: Context, sessionID: string, since: number): Promise<boolean> {
  const raw: unknown = await context.session.get({ sessionID })
  if (!isSessionTimeInfo(raw)) return false
  if (raw.time.idle !== undefined) return false
  return raw.time.updated > since
}

/**
 * Skipped Idle checks (ADR-0002, spec.md "On Turn End" steps 1-3), run in
 * order: a pending permission request, an open question/ask tool call in
 * the last assistant message, then a pending inbox item. Returns the first
 * reason that hits, or `undefined` when the Turn End should proceed
 * normally. `since` anchors the inbox fallback (see `hasPendingInboxItem`).
 */
export async function detectSkippedIdle(
  context: Context,
  sessionID: string,
  messages: readonly TranscriptMessage[],
  since: number,
): Promise<SkippedIdleReason | undefined> {
  const pendingPermissions: unknown = await context.permission.list({ sessionID })
  if (Array.isArray(pendingPermissions) && pendingPermissions.length > 0) return "permission"

  if (hasOpenQuestionToolCall(messages)) return "question"

  if (await hasPendingInboxItem(context, sessionID, since)) return "inbox"

  return undefined
}

/**
 * Pure completion check (spec.md user story 3 and 4): takes all `assistant`
 * messages after the last `user` or `synthetic` message, joins their text
 * content, and matches `<promise>\s*PROMISE\s*</promise>` case-insensitively.
 */
export function findCompletion(messages: readonly TranscriptMessage[], promise: string): boolean {
  let lastBoundary = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message !== undefined && (message.type === "user" || message.type === "synthetic")) {
      lastBoundary = index
    }
  }

  const relevant = messages.slice(lastBoundary + 1).filter((message) => message.type === "assistant")

  const text = relevant
    .flatMap((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? ""))
    .join("")

  const pattern = new RegExp(`<promise>\\s*${escapeRegExp(promise)}\\s*</promise>`, "i")
  return pattern.test(text)
}

/** Turn End events this module reacts to (ADR-0004). */
const TURN_END_EVENT_TYPE = "session.execution.succeeded"

/** Extracts `data.sessionID` from an event, tolerating an untyped payload. */
function eventSessionID(event: { readonly data?: Record<string, unknown> }): string | undefined {
  const sessionID = event.data?.["sessionID"]
  return typeof sessionID === "string" ? sessionID : undefined
}

/** Fetches the transcript for a Loop Session, dropping anything that does not
 * look like a `TranscriptMessage` (the server is trusted for shape, not for
 * type safety at this boundary). */
async function fetchMessages(context: Context, sessionID: string): Promise<TranscriptMessage[]> {
  const raw: unknown = await context.session.context({ sessionID })
  if (!Array.isArray(raw)) return []
  return raw.filter(isTranscriptMessage)
}

/** Computes the cost and token deltas for a stop Notice. Falls back to
 * treating the current cost and tokens as zero, and logs once, when
 * `ctx.session.get` returns something that does not match the expected
 * shape. */
async function computeDeltas(
  context: Context,
  sessionID: string,
  state: LoopState,
): Promise<{ readonly costDelta: number; readonly tokenDelta: number }> {
  const raw: unknown = await context.session.get({ sessionID })
  if (!isSessionCostInfo(raw)) {
    console.error(`[ralph-loop] unexpected session.get response shape for session ${sessionID}; treating cost and tokens as zero`)
    return {
      costDelta: -state.startCost,
      tokenDelta: -(state.startTokens.input + state.startTokens.output),
    }
  }
  const costDelta = raw.cost - state.startCost
  const tokenDelta = raw.tokens.input + raw.tokens.output - (state.startTokens.input + state.startTokens.output)
  return { costDelta, tokenDelta }
}

/** Why a Turn End stopped the Loop. Ticket 05 will add `interrupted`,
 * `failed`, and `cancelled` as more Stop Reasons land in this switch. */
type StopReason = "completed" | "max-iterations"

/**
 * Starts the Turn End subscription. Call once from `setup`; abort the
 * signal you pass in during cleanup.
 */
export function subscribeToTurnEnd(context: Context, signal: AbortSignal): void {
  const inFlight = new Set<string>()
  /** The moment this module last finished handling a Turn End for a
   * session, used as the `since` anchor for the inbox Skipped Idle
   * fallback (see `hasPendingInboxItem`). Falls back to the Loop's
   * `startedAt` for a session's first Turn End. */
  const lastTurnEndAt = new Map<string, number>()

  async function stop(sessionID: string, state: LoopState, reason: StopReason): Promise<void> {
    await removeLoopState(context, sessionID)
    lastTurnEndAt.delete(sessionID)
    const deltas = await computeDeltas(context, sessionID, state)
    const text =
      reason === "completed"
        ? buildCompletionNotice({ iteration: state.iteration, ...deltas })
        : buildMaxIterationsNotice({ iteration: state.iteration, maxIterations: state.maxIterations, ...deltas })
    await context.session.synthetic({ sessionID, text })
  }

  async function handleTurnEnd(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      const state = await readLoopState(context, sessionID)
      if (state === undefined) return

      const messages = await fetchMessages(context, sessionID)
      const since = lastTurnEndAt.get(sessionID) ?? Date.parse(state.startedAt)

      const skippedIdleReason = await detectSkippedIdle(context, sessionID, messages, since)
      if (skippedIdleReason !== undefined) {
        if (!state.paused) await writeLoopState(context, { ...state, paused: true })
        lastTurnEndAt.set(sessionID, Date.now())
        return
      }

      if (findCompletion(messages, state.promise)) {
        await stop(sessionID, state, "completed")
        return
      }

      if (state.iteration >= state.maxIterations) {
        await stop(sessionID, state, "max-iterations")
        return
      }

      const nextIteration = state.iteration + 1
      const nextState: LoopState = { ...state, iteration: nextIteration, paused: false }
      await writeLoopState(context, nextState)

      await context.session.prompt({
        sessionID,
        text: buildContinuationPrompt({
          iteration: nextIteration,
          maxIterations: state.maxIterations,
          task: state.task,
          promise: state.promise,
        }),
        delivery: "steer",
      })

      lastTurnEndAt.set(sessionID, Date.now())
    } finally {
      inFlight.delete(sessionID)
    }
  }

  /** Runs a Turn End handler and swallows any rejection: one session's
   * failure must never become an unhandled rejection that could take down
   * the host process, and must never stop other sessions' Loops. */
  function runHandleTurnEnd(sessionID: string): void {
    handleTurnEnd(sessionID).catch((error: unknown) => {
      console.error(`[ralph-loop] Turn End handling failed for session ${sessionID}`, error)
    })
  }

  void (async () => {
    try {
      for await (const event of context.event.subscribe({ signal })) {
        if (event.type !== TURN_END_EVENT_TYPE) continue

        if (event.location?.directory !== undefined && event.location.directory !== context.location.directory) continue

        const sessionID = eventSessionID(event)
        if (sessionID === undefined) continue

        runHandleTurnEnd(sessionID)
      }
    } catch (error) {
      if (signal.aborted) return
      console.error("[ralph-loop] Turn End subscription failed", error)
    }
  })()
}
