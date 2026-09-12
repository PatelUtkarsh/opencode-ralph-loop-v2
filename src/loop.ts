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

/** Computes the cost and token deltas for a stop Notice. */
async function computeDeltas(
  context: Context,
  sessionID: string,
  state: LoopState,
): Promise<{ readonly costDelta: number; readonly tokenDelta: number }> {
  const info = (await context.session.get({ sessionID })) as { cost: number; tokens: LoopTokenUsage }
  const costDelta = info.cost - state.startCost
  const tokenDelta = info.tokens.input + info.tokens.output - (state.startTokens.input + state.startTokens.output)
  return { costDelta, tokenDelta }
}

/**
 * Starts the Turn End subscription. Call once from `setup`; abort the
 * returned controller's signal (or the one you pass in) during cleanup.
 */
export function subscribeToTurnEnd(context: Context, signal: AbortSignal): void {
  const inFlight = new Set<string>()

  async function handleTurnEnd(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      const loaded = await readLoopState(context, sessionID)
      if (loaded === undefined) return
      const state: LoopState = loaded

      const messages = (await context.session.context({ sessionID })) as TranscriptMessage[]

      async function stop(buildNotice: (deltas: { readonly costDelta: number; readonly tokenDelta: number }) => string): Promise<void> {
        await removeLoopState(context, sessionID)
        const deltas = await computeDeltas(context, sessionID, state)
        await context.session.synthetic({ sessionID, text: buildNotice(deltas) })
      }

      if (findCompletion(messages, state.promise)) {
        await stop((deltas) => buildCompletionNotice({ iteration: state.iteration, ...deltas }))
        return
      }

      if (state.iteration >= state.maxIterations) {
        await stop((deltas) => buildMaxIterationsNotice({ iteration: state.iteration, maxIterations: state.maxIterations, ...deltas }))
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
    } finally {
      inFlight.delete(sessionID)
    }
  }

  void (async () => {
    for await (const event of context.event.subscribe({ signal })) {
      if (event.type !== TURN_END_EVENT_TYPE) continue

      if (event.location?.directory !== undefined && event.location.directory !== context.location.directory) continue

      const sessionID = eventSessionID(event)
      if (sessionID === undefined) continue

      void handleTurnEnd(sessionID)
    }
  })()
}
