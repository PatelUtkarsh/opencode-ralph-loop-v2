// Turn End handling and the remaining Stop Reasons. Continues a Loop with
// the next Continuation Prompt, or stops it (completed, max-iterations,
// cancelled, interrupted, failed, or session.deleted) with the matching
// Notice. See spec.md "Turn End detection", "On Turn End", and "Stop", and
// ADR-0004 (session.execution.succeeded, never session.idle).
import type { Plugin } from "@opencode/plugin"
import { buildCompletionNotice, buildContinuationPrompt, buildMaxIterationsNotice, buildStoppedNotice } from "./prompts.ts"
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
 * trusted. Exported so `src/commands.ts` can validate the same shape when
 * starting a Loop instead of casting. */
export function isSessionCostInfo(value: unknown): value is { cost: number; tokens: LoopTokenUsage } {
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

/** Why a Turn End stopped the Loop (spec.md "Stop Reason"). */
export type StopReason = "completed" | "max-iterations" | "cancelled" | "interrupted" | "failed"

/**
 * Stops a Loop for any Stop Reason: removes state and posts a Notice.
 * `completed` and `max-iterations` report cost/token deltas; the rest
 * report only the Iteration reached. Exported so `src/commands.ts` can
 * stop a Loop from `cancel-ralph`.
 */
export async function stopLoop(context: Context, sessionID: string, state: LoopState, reason: StopReason): Promise<void> {
  await removeLoopState(context, sessionID)
  let text: string
  if (reason === "completed" || reason === "max-iterations") {
    const deltas = await computeDeltas(context, sessionID, state)
    text =
      reason === "completed"
        ? buildCompletionNotice({ iteration: state.iteration, ...deltas })
        : buildMaxIterationsNotice({ iteration: state.iteration, maxIterations: state.maxIterations, ...deltas })
  } else {
    text = buildStoppedNotice(reason, state.iteration)
  }
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
    await stopLoop(context, sessionID, state, "completed")
    return
  }

  if (state.iteration >= state.maxIterations) {
    await stopLoop(context, sessionID, state, "max-iterations")
    return
  }

  // A stop (cancel-ralph, interrupted, or failed) can land while this
  // handler was awaiting fetchMessages above. Re-read state right
  // before writing so a concurrent stop is not resurrected by this
  // write, and no Continuation Prompt is sent for a Loop that no
  // longer exists.
  const stillActive = await readLoopState(context, sessionID)
  if (stillActive === undefined) return

  const nextIteration = stillActive.iteration + 1
  const nextState: LoopState = { ...stillActive, iteration: nextIteration, paused: false }
  await writeLoopState(context, nextState)

  await context.session.prompt({
    sessionID,
    text: buildContinuationPrompt({
      iteration: nextIteration,
      maxIterations: stillActive.maxIterations,
      task: stillActive.task,
      promise: stillActive.promise,
    }),
    delivery: "steer",
  })
}

/** What `subscribeToTurnEnd` returns: the guarded Turn End handler, so a
 * caller outside the live event stream (Resume, in `src/resume.ts`) can
 * route through the same re-entrancy guard instead of calling `runTurnEnd`
 * directly and risking a race with a live Turn End event for the same
 * session. */
export interface TurnEndSubscription {
  readonly handleTurnEnd: (sessionID: string) => Promise<void>
}

/**
 * Starts the Turn End subscription. Call once from `setup`; abort the
 * signal you pass in during cleanup.
 */
export function subscribeToTurnEnd(
  context: Context,
  signal: AbortSignal,
  options?: { readonly stopOnFailure?: boolean },
): TurnEndSubscription {
  const inFlight = new Set<string>()
  const stopOnFailure = options?.stopOnFailure ?? true

  /** Runs the Turn End handler and swallows any rejection: one session's
   * failure must never become an unhandled rejection that could take down
   * the host process, and must never stop other sessions' Loops. Also the
   * re-entrancy guard: a second call for a session already in flight is a
   * no-op, whether it comes from a live event or from Resume. */
  async function handleTurnEnd(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      await runTurnEnd(context, sessionID)
    } catch (error) {
      console.error(`[ralph-loop] Turn End handling failed for session ${sessionID}`, error)
    } finally {
      inFlight.delete(sessionID)
    }
  }

  /** Stops a Loop Session for `interrupted` or `failed`, ignoring sessions
   * with no Loop in storage. Swallows rejections like `handleTurnEnd`. */
  async function handleStopEvent(sessionID: string, reason: "interrupted" | "failed"): Promise<void> {
    try {
      const state = await readLoopState(context, sessionID)
      if (state === undefined) return
      await stopLoop(context, sessionID, state, reason)
    } catch (error) {
      console.error(`[ralph-loop] ${reason} handling failed for session ${sessionID}`, error)
    }
  }

  void (async () => {
    try {
      for await (const event of context.event.subscribe({ signal })) {
        if (event.location?.directory !== undefined && event.location.directory !== context.location.directory) continue

        const sessionID = eventSessionID(event)
        if (sessionID === undefined) continue

        if (event.type === TURN_END_EVENT_TYPE) {
          void handleTurnEnd(sessionID)
        } else if (event.type === "session.execution.interrupted") {
          void handleStopEvent(sessionID, "interrupted")
        } else if (event.type === "session.execution.failed") {
          if (stopOnFailure) void handleStopEvent(sessionID, "failed")
          else void handleTurnEnd(sessionID)
        } else if (event.type === "session.deleted") {
          removeLoopState(context, sessionID).catch((error: unknown) => {
            console.error(`[ralph-loop] removing state for deleted session ${sessionID} failed`, error)
          })
        }
      }
    } catch (error) {
      if (signal.aborted) return
      console.error("[ralph-loop] Turn End subscription failed", error)
    }
  })()

  return { handleTurnEnd }
}
