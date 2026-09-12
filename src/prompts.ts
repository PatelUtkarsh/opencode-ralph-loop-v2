// Prompt and Notice text builders. See spec.md "Start Prompt" and "Continuation Prompt".

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

/** Notice posted when `/ralph-loop` is refused because a Loop is already active. */
export function buildAlreadyActiveNotice(): string {
  return "Ralph Loop is already active in this session. Use /cancel-ralph to stop it before starting a new one."
}

/** Notice posted when argument parsing fails: unknown flag or empty Task. */
export function buildArgumentErrorNotice(error: string): string {
  return `Ralph Loop could not start: ${error}`
}
