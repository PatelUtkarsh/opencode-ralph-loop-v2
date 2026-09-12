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
 * directly (see the architecture skill, section 5). */
export interface TranscriptMessage {
  readonly type: string
  readonly text?: string
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
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

async function stop(context: Context, sessionID: string, state: LoopState, reason: StopReason): Promise<void> {
  await removeLoopState(context, sessionID)
  const deltas = await computeDeltas(context, sessionID, state)
  const text =
    reason === "completed"
      ? buildCompletionNotice({ iteration: state.iteration, ...deltas })
      : buildMaxIterationsNotice({ iteration: state.iteration, maxIterations: state.maxIterations, ...deltas })
  await context.session.synthetic({ sessionID, text })
}

/**
 * Runs the Turn End handling for one Loop Session: continues the Loop with
 * the next Continuation Prompt, or stops it (completed / max iterations).
 * Exported so Resume (ticket 06) can call it directly for a Loop Session
 * that is idle after a service restart, the same way a live Turn End event
 * does.
 */
export async function runTurnEnd(context: Context, sessionID: string): Promise<void> {
  const state = await readLoopState(context, sessionID)
  if (state === undefined) return

  const messages = await fetchMessages(context, sessionID)

  if (findCompletion(messages, state.promise)) {
    await stop(context, sessionID, state, "completed")
    return
  }

  if (state.iteration >= state.maxIterations) {
    await stop(context, sessionID, state, "max-iterations")
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
}

/**
 * Starts the Turn End subscription. Call once from `setup`; abort the
 * signal you pass in during cleanup.
 */
export function subscribeToTurnEnd(context: Context, signal: AbortSignal): void {
  const inFlight = new Set<string>()

  /** Runs a Turn End handler and swallows any rejection: one session's
   * failure must never become an unhandled rejection that could take down
   * the host process, and must never stop other sessions' Loops. */
  function runHandleTurnEnd(sessionID: string): void {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    runTurnEnd(context, sessionID)
      .catch((error: unknown) => {
        console.error(`[ralph-loop] Turn End handling failed for session ${sessionID}`, error)
      })
      .finally(() => {
        inFlight.delete(sessionID)
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
