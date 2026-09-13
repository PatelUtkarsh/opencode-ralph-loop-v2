// Prompt and Notice text builders. See spec.md "Start Prompt" and "Continuation Prompt".
import type { StopReason } from "./rpc.ts"

/** The Rules block repeated in every Start Prompt and Continuation Prompt. */
export const RULES_BLOCK = [
  "Rules:",
  "- Only output the Completion Promise when the task is completely and verifiably finished.",
  "- The statement must be true; do not output a false Completion Promise to escape the Loop.",
  "- If blocked, explain the blocker and ask for help instead of guessing.",
  "- `/cancel-ralph` stops the Loop at any time.",
].join("\n")

/** Builds the Start Prompt: the Task, the Rules, and the exact Completion Promise to output. */
export function buildStartPrompt(task: string, promise: string): string {
  return [task, "", RULES_BLOCK, "", `When the task is complete, output: <promise>${promise}</promise>`].join("\n")
}

/** Notice posted when a Loop starts. */
export function buildStartNotice(options: { readonly task: string; readonly maxIterations: number; readonly promise: string; readonly clamped: boolean }): string {
  const lines = [`Ralph Loop started. Max Iterations: ${options.maxIterations}. Completion Promise: <promise>${options.promise}</promise>.`]
  if (options.clamped) {
    lines.push(`Requested Max Iterations exceeded the Hard Cap and was clamped to ${options.maxIterations}.`)
  }
  return lines.join("\n")
}

/** Notice posted when `/ralph-loop` is refused because a Loop is already
 * active. `ownerDirectory` is the Loop's owning directory and `directory`
 * this instance's; when they differ the Notice names the owner, because
 * `/cancel-ralph` here would report no active Loop and the user needs to
 * know where to stop it (ADR-0006). */
export function buildAlreadyActiveNotice(options?: { readonly ownerDirectory?: string; readonly directory?: string }): string {
  const base = "Ralph Loop is already active in this session."
  const owner = options?.ownerDirectory
  if (owner !== undefined && owner !== options?.directory) {
    return `${base} It is owned by the plugin loaded for ${owner}, so /cancel-ralph here will not stop it; run it in a session there.`
  }
  return `${base} Use /cancel-ralph to stop it before starting a new one.`
}

/** Notice posted when argument parsing fails: unknown flag or empty Task. */
export function buildArgumentErrorNotice(error: string): string {
  return `Ralph Loop could not start: ${error}`
}

/** Builds the Continuation Prompt sent at each Turn End that does not stop the Loop. */
export function buildContinuationPrompt(options: {
  readonly iteration: number
  readonly maxIterations: number
  readonly task: string
  readonly promise: string
}): string {
  return [
    `[RALPH LOOP - ITERATION ${options.iteration}/${options.maxIterations}]`,
    "The previous turn did not output the Completion Promise.",
    "",
    RULES_BLOCK,
    "",
    `When the task is complete, output: <promise>${options.promise}</promise>`,
    "",
    "Original task:",
    options.task,
  ].join("\n")
}

/** Formats a delta as a signed string, e.g. `+1.50` or `-2`. */
function formatDelta(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return rounded >= 0 ? `+${rounded}` : `${rounded}`
}

/** Formats the cost/token delta line shared by every stop Notice. */
function formatDeltaLine(costDelta: number, tokenDelta: number): string {
  return `Cost delta: ${formatDelta(costDelta)}. Token delta: ${formatDelta(tokenDelta)}.`
}

/** Notice posted when a Loop stops because the Completion Promise was found. */
export function buildCompletionNotice(options: { readonly iteration: number; readonly costDelta: number; readonly tokenDelta: number }): string {
  return [
    `Ralph Loop completed after ${options.iteration} Iteration${options.iteration === 1 ? "" : "s"}.`,
    formatDeltaLine(options.costDelta, options.tokenDelta),
  ].join("\n")
}

/** Notice posted when a Loop stops because Max Iterations was reached. */
export function buildMaxIterationsNotice(options: {
  readonly iteration: number
  readonly maxIterations: number
  readonly costDelta: number
  readonly tokenDelta: number
}): string {
  return [
    `Ralph Loop stopped: reached Max Iterations (${options.iteration}/${options.maxIterations}).`,
    formatDeltaLine(options.costDelta, options.tokenDelta),
  ].join("\n")
}

/** The Stop Reasons that get a plain Notice: cancelled, interrupted,
 * failed. They report the Iteration reached and no cost/token deltas
 * (spec.md "Stop"). Derived from `rpc.ts`'s `StopReason` so the Notice
 * groups cannot drift from it: `completed` and `max-iterations` get their
 * own delta-reporting builders, and `deleted` gets no Notice at all,
 * because the transcript it would be posted to is gone. */
export type StoppedReason = Exclude<StopReason, "completed" | "max-iterations" | "deleted">

/** Notice posted when a Loop stops for `cancelled`, `interrupted`, or `failed`. */
export function buildStoppedNotice(reason: StoppedReason, iteration: number): string {
  return `Ralph Loop ${reason} after ${iteration} Iteration${iteration === 1 ? "" : "s"}.`
}

/** Notice posted by `/ralph-status` when a Loop is active. */
export function buildStatusNotice(options: {
  readonly iteration: number
  readonly maxIterations: number
  readonly paused: boolean
  readonly task: string
}): string {
  return [
    `Ralph Loop status: Iteration ${options.iteration}/${options.maxIterations}${options.paused ? " (paused)" : ""}.`,
    `Task: ${options.task}`,
  ].join("\n")
}

/** Notice posted by `/cancel-ralph` and `/ralph-status` when the session has no Loop. */
export function buildNoActiveLoopNotice(): string {
  return "No active Ralph Loop in this session."
}
