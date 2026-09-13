// Loop Status conversion and the RPC `changed` emit seam (ADR-0003).
//
// `src/index.ts` installs the real emitter with `setStatusEmitter` once
// `ctx.rpc.register` resolves and calls the returned disposer in cleanup.
// `src/loop.ts` and `src/commands.ts` then announce every Loop change the
// spec names (start, Iteration increment, pause/unpause, stop) with one
// `emitChanged` call each, holding no reference to the RPC registration and
// no import of `src/index.ts`.
//
// The seam exists so the Loop never depends on the RPC registration
// lifecycle: before the registration resolves, after it is disposed, or
// when a subscriber is broken, `emitChanged` is a no-op or a logged
// failure, never an error the Loop has to handle.
import type { LoopState } from "./state.ts"
import type { LoopStatus, StopReason } from "./rpc.ts"

/** Converts persisted Loop state to the read-only view exposed over RPC
 * (CONTEXT.md "Loop Status"). */
export function toLoopStatus(state: LoopState): LoopStatus {
  return {
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    paused: state.paused,
    task: state.task,
    promise: state.promise,
  }
}

/** Emits one `changed` event. Installed from `setup` as a thin wrapper
 * around `registration.events.emit("changed", data)`; its own rejection is
 * `emitChanged`'s responsibility to swallow, not the emitter's. */
export type ChangedEmitter = (data: {
  readonly sessionID: string
  readonly status?: LoopStatus
  readonly reason?: StopReason
}) => Promise<void>

let emitter: ChangedEmitter | undefined

/**
 * Installs the `changed` emitter and returns its disposer. Module-scope so
 * `loop.ts` and `commands.ts` can call `emitChanged` without holding a
 * reference to the live RPC registration.
 *
 * The emitter is a singleton, but a plugin reload can overlap two `setup`
 * calls: the new one installs its emitter before the old one's cleanup
 * runs. The disposer therefore clears the slot only while `fn` is still
 * the installed emitter, so a late cleanup cannot silence the `changed`
 * events of the registration that replaced it.
 */
export function setStatusEmitter(fn: ChangedEmitter): () => void {
  emitter = fn
  return () => {
    if (emitter === fn) emitter = undefined
  }
}

/**
 * Emits `changed` for one session: `state` becomes its `LoopStatus` (or is
 * omitted for a stop), and `reason` is set only for a stop.
 *
 * Fire-and-forget and total: it returns no promise, and no failure of the
 * installed emitter reaches the caller. A missing emitter (no RPC
 * registered yet, or already torn down) is a silent no-op; a synchronous
 * throw is caught by the `try`, and an asynchronous rejection by the
 * `.catch`. Both are logged. A broken RPC subscriber can therefore never
 * break the Loop it is watching, nor become an unhandled rejection.
 */
export function emitChanged(sessionID: string, state: LoopState | undefined, reason?: StopReason): void {
  if (emitter === undefined) return
  const data: { sessionID: string; status?: LoopStatus; reason?: StopReason } = { sessionID }
  if (state !== undefined) data.status = toLoopStatus(state)
  if (reason !== undefined) data.reason = reason
  const log = (error: unknown) => {
    console.error(`[ralph-loop] emitting changed event failed for session ${sessionID}`, error)
  }
  try {
    // A non-async emitter can throw before it ever returns a promise, so
    // `.catch` alone is not enough to make this call total.
    emitter(data)?.catch(log)
  } catch (error) {
    log(error)
  }
}
