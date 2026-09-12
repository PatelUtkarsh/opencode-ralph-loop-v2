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
 * directly (see the architecture skill, section 5). A `tool` content part's
 * verified shape (OpenCode 2.0.2 schema) is `{ type: "tool", id, name,
 * state: { status: "streaming" | "running" | "completed" | "error", ... },
 * time }`; only `name` and `state.status` are used here, by the Skipped
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

/** Why a Turn End was skipped instead of continuing the Loop (ADR-0002). */
export type SkippedIdleReason = "permission" | "question" | "inbox"

/** Matches a tool name that is a question/ask tool: `question`, `ask`, or
 * either word set off by `_`, `.`, `-`, start, or end (`ask_user`,
 * `duty_question`). Does not match `task`, since `ask` must be a whole
 * word segment. */
const QUESTION_TOOL_NAME_PATTERN = /(^|[_.\-])(question|ask)([_.\-]|$)/i

/** True when the last assistant message contains a question/ask tool call
 * that is still open. A tool call counts only when its name matches
 * `QUESTION_TOOL_NAME_PATTERN` and its `state.status` is `"streaming"` or
 * `"running"`; a missing or unknown `state` is not open (verified tool
 * content shape, see the docstring on `TranscriptMessage`). */
function hasOpenQuestionToolCall(messages: readonly TranscriptMessage[]): boolean {
  let lastAssistant: TranscriptMessage | undefined
  for (const message of messages) {
    if (message.type === "assistant") lastAssistant = message
  }
  if (lastAssistant === undefined) return false

  for (const part of lastAssistant.content ?? []) {
    if (part.type !== "tool") continue
    if (!QUESTION_TOOL_NAME_PATTERN.test(part.name ?? "")) continue
    const status = part.state?.status
    if (status === "streaming" || status === "running") return true
  }
  return false
}

/**
 * Skipped Idle checks (ADR-0002, spec.md "On Turn End" steps 1-3), run in
 * order: a pending permission request, an open question/ask tool call in
 * the last assistant message, then a pending inbox item (from
 * `pendingInboxIDs`, tracked from the event stream; see
 * `subscribeToTurnEnd`). Returns the first reason that hits, or `undefined`
 * when the Turn End should proceed normally. A `permission.list` rejection
 * is caught and treated as no pending permission, so one failing check
 * never aborts the Turn End.
 */
export async function detectSkippedIdle(
  context: Context,
  sessionID: string,
  messages: readonly TranscriptMessage[],
  pendingInboxIDs: ReadonlySet<string> | undefined,
): Promise<SkippedIdleReason | undefined> {
  let pendingPermissions: unknown
  try {
    pendingPermissions = await context.permission.list({ sessionID })
  } catch (error) {
    console.error(`[ralph-loop] permission.list failed for session ${sessionID}; treating as no pending permission`, error)
    pendingPermissions = []
  }
  if (Array.isArray(pendingPermissions) && pendingPermissions.length > 0) return "permission"

  if (hasOpenQuestionToolCall(messages)) return "question"

  if (pendingInboxIDs !== undefined && pendingInboxIDs.size > 0) return "inbox"

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

/** Inbox events tracked for the Skipped Idle inbox check (verified shapes):
 * `session.inbox.enqueued` carries `data: { sessionID, inboxID, item: { type,
 * payload } }`; `session.inbox.delivered` and `session.inbox.cancelled`
 * carry `data: { sessionID, inboxID }`. */
const INBOX_ENQUEUED_EVENT_TYPE = "session.inbox.enqueued"
const INBOX_DELIVERED_EVENT_TYPE = "session.inbox.delivered"
const INBOX_CANCELLED_EVENT_TYPE = "session.inbox.cancelled"
const SESSION_DELETED_EVENT_TYPE = "session.deleted"

/** Extracts `data.sessionID` from an event, tolerating an untyped payload. */
function eventSessionID(event: { readonly data?: Record<string, unknown> }): string | undefined {
  const sessionID = event.data?.["sessionID"]
  return typeof sessionID === "string" ? sessionID : undefined
}

/** Extracts `data.inboxID` from an event, tolerating an untyped payload. */
function eventInboxID(event: { readonly data?: Record<string, unknown> }): string | undefined {
  const inboxID = event.data?.["inboxID"]
  return typeof inboxID === "string" ? inboxID : undefined
}

/** Extracts `data.item.type` from a `session.inbox.enqueued` event,
 * tolerating an untyped payload. */
function eventInboxItemType(event: { readonly data?: Record<string, unknown> }): string | undefined {
  const item = event.data?.["item"]
  if (typeof item !== "object" || item === null) return undefined
  const type = (item as Record<string, unknown>)["type"]
  return typeof type === "string" ? type : undefined
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

/** Inbox items enqueued but not yet delivered or cancelled, by session
 * (spec.md "On Turn End" step 3). Tracked from the event stream rather than
 * read from `ctx.session`, which exposes no inbox listing method (see the
 * docstring on `detectSkippedIdle`). In-memory only: cleared on stop and on
 * `session.deleted`. Module scope so `runTurnEnd` and `stopLoop` share it
 * with the subscription. */
const pendingInbox = new Map<string, Set<string>>()

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
  pendingInbox.delete(sessionID)
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
 * Runs the Turn End handling for one Loop Session: pauses on a Skipped Idle
 * (ADR-0002), continues the Loop with the next Continuation Prompt, or stops
 * it (completed / max iterations). No re-entrancy guard of its own; call it
 * through `handleTurnEnd` from `subscribeToTurnEnd`.
 */
export async function runTurnEnd(context: Context, sessionID: string): Promise<void> {
  const state = await readLoopState(context, sessionID)
  if (state === undefined) return

  const messages = await fetchMessages(context, sessionID)

  const skippedIdleReason = await detectSkippedIdle(context, sessionID, messages, pendingInbox.get(sessionID))
  if (skippedIdleReason !== undefined) {
    if (!state.paused) await writeLoopState(context, { ...state, paused: true })
    return
  }

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

        if (event.type === INBOX_ENQUEUED_EVENT_TYPE) {
          const inboxID = eventInboxID(event)
          if (inboxID !== undefined && eventInboxItemType(event) === "user") {
            const pending = pendingInbox.get(sessionID) ?? new Set<string>()
            pending.add(inboxID)
            pendingInbox.set(sessionID, pending)
          }
        } else if (event.type === INBOX_DELIVERED_EVENT_TYPE || event.type === INBOX_CANCELLED_EVENT_TYPE) {
          const inboxID = eventInboxID(event)
          const pending = pendingInbox.get(sessionID)
          if (inboxID !== undefined && pending !== undefined) {
            pending.delete(inboxID)
            if (pending.size === 0) pendingInbox.delete(sessionID)
          }
        } else if (event.type === TURN_END_EVENT_TYPE) {
          void handleTurnEnd(sessionID)
        } else if (event.type === "session.execution.interrupted") {
          void handleStopEvent(sessionID, "interrupted")
        } else if (event.type === "session.execution.failed") {
          if (stopOnFailure) void handleStopEvent(sessionID, "failed")
          else void handleTurnEnd(sessionID)
        } else if (event.type === SESSION_DELETED_EVENT_TYPE) {
          pendingInbox.delete(sessionID)
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
