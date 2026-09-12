// Loop state persisted in plugin storage, keyed by session (ADR-0001).
import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

/** Token usage shape returned by `ctx.session.get`. */
export interface LoopTokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning?: number
  readonly cache?: { readonly read: number; readonly write: number }
}

/** Loop state, persisted at `loop/<sessionID>` (ADR-0001). */
export interface LoopState {
  readonly sessionID: string
  readonly task: string
  readonly promise: string
  readonly iteration: number
  readonly maxIterations: number
  readonly paused: boolean
  readonly startedAt: string
  readonly startCost: number
  readonly startTokens: LoopTokenUsage
}

/** Builds the storage key for a Loop Session's Loop state. */
export function loopStorageKey(sessionID: string): string {
  return `loop/${sessionID}`
}

export async function readLoopState(context: Context, sessionID: string): Promise<LoopState | undefined> {
  const value = await context.storage.get(loopStorageKey(sessionID))
  return value as LoopState | undefined
}

export async function writeLoopState(context: Context, state: LoopState): Promise<void> {
  await context.storage.set(loopStorageKey(state.sessionID), JSON.parse(JSON.stringify(state)))
}

export async function removeLoopState(context: Context, sessionID: string): Promise<void> {
  await context.storage.remove(loopStorageKey(sessionID))
}
