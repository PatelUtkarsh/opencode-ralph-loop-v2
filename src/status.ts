// Loop Status conversion and the RPC `changed` event emitter (ADR-0003,
// ticket 07). `src/loop.ts` and `src/commands.ts` call `emitChanged` at
// every point the spec names (start, Iteration increment, pause/unpause,
// stop) without importing `src/index.ts` or `ctx.rpc`. `src/index.ts`
// installs the real emitter with `setStatusEmitter` once `ctx.rpc.register`
// resolves, and clears it again in the plugin's cleanup. This is the seam
// that keeps `loop.ts` and `commands.ts` free of a dependency on the RPC
// registration lifecycle.
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

/** Installs the `changed` emitter, or clears it with `undefined` on
 * cleanup. Module-scope so `loop.ts` and `commands.ts` can call
 * `emitChanged` without holding a reference to the live RPC registration. */
export function setStatusEmitter(fn: ChangedEmitter | undefined): void {
  emitter = fn
}

/**
 * Emits `changed` for one session: `state` becomes its `LoopStatus` (or is
 * omitted for a stop), and `reason` is set only for a stop. Never throws
 * and never leaves a rejected promise unhandled: a missing emitter (no RPC
 * registered yet, or already torn down) is a silent no-op, and an emit
 * failure is logged, not propagated, so a broken RPC subscriber can never
 * break the Loop it is watching.
 */
export function emitChanged(sessionID: string, state: LoopState | undefined, reason?: StopReason): void {
  if (emitter === undefined) return
  const data: { sessionID: string; status?: LoopStatus; reason?: StopReason } = { sessionID }
  if (state !== undefined) data.status = toLoopStatus(state)
  if (reason !== undefined) data.reason = reason
  emitter(data).catch((error: unknown) => {
    console.error(`[ralph-loop] emitting changed event failed for session ${sessionID}`, error)
  })
}
