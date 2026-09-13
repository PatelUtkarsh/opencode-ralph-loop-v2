// Loop state persisted in plugin storage, keyed by session (ADR-0001), plus
// the ownership read every handler goes through (ADR-0006).
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
  /** The `ctx.location.directory` of the plugin instance that owns this
   * Loop, set when the Loop starts (ADR-0006). Storage is shared by every
   * instance, so this is the only thing that tells them apart. Optional
   * because a Loop persisted before ADR-0006 has no value; see
   * `readOwnedLoopState`. */
  readonly directory?: string
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

/**
 * Whether a stored Loop belongs to the plugin instance loaded for
 * `directory` (ADR-0006). Pure and takes `unknown`, so `src/resume.ts` can
 * apply it to a raw `storage.scan` entry it already holds instead of
 * re-reading and casting the key.
 *
 * A Loop persisted before ADR-0006 carries no `directory` and is owned by
 * every instance, so more than one can act on it until a write settles the
 * ownership: the write claims, not the read. ADR-0006 accepts that race.
 * A value that is not an object at all is owned by nobody, so a corrupt
 * entry is left alone rather than acted on.
 */
export function ownsLoop(value: unknown, directory: string): boolean {
  if (typeof value !== "object" || value === null) return false
  const recorded = (value as Record<string, unknown>)["directory"]
  return recorded === undefined || recorded === directory
}

/**
 * Reads a Loop only when this plugin instance owns it (ADR-0006), and
 * returns `undefined` otherwise, so a non-owning instance treats the
 * session exactly like a session with no Loop: no prompt, no Notice, no
 * storage write. Every read path uses this rather than `readLoopState`.
 *
 * A Loop with no recorded `directory` comes back with this instance's
 * directory filled in, so the next `writeLoopState` persists the claim.
 * Until that write lands another instance can read and act on the same
 * Loop; ADR-0006 accepts that race, since it can only affect a Loop
 * written before that ADR.
 *
 * `src/commands.ts`'s start command is the one read that deliberately uses
 * `readLoopState` instead, so `/ralph-loop` refuses rather than silently
 * taking a running Loop away from another instance.
 */
export async function readOwnedLoopState(context: Context, sessionID: string): Promise<LoopState | undefined> {
  const state = await readLoopState(context, sessionID)
  if (state === undefined) return undefined
  if (!ownsLoop(state, context.location.directory)) return undefined
  if (state.directory !== undefined) return state
  return { ...state, directory: context.location.directory }
}

export async function writeLoopState(context: Context, state: LoopState): Promise<void> {
  await context.storage.set(loopStorageKey(state.sessionID), JSON.parse(JSON.stringify(state)))
}

export async function removeLoopState(context: Context, sessionID: string): Promise<void> {
  await context.storage.remove(loopStorageKey(sessionID))
}
