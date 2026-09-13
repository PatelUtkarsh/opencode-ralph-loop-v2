# 07: RPC Loop Status contract and change events

**What to build:** Any OpenCode client can ask the server plugin for the Loop Status of a session and subscribe to changes. This is the channel the TUI Indicator will use.

**Blocked by:** 03 (Turn End continues the Loop or completes it), 04 (Skipped Idle pauses the Loop while the agent waits on the user)

**Status:** done

- [x] `./rpc` export: `Rpc.define({ id: "ralph-loop" })` with method `status({ sessionID }) -> { status?: LoopStatus, notify: boolean }` and event `changed { sessionID, status?: LoopStatus, reason?: StopReason }`
- [x] `LoopStatus = { iteration, maxIterations, paused, task, promise }`
- [x] Server plugin registers the RPC in setup; `status` reads storage; `notify` comes from plugin option `notify` (default true)
- [x] `changed` emitted on start, every Iteration increment, every pause/unpause, and every stop (with `status` undefined and `reason` set)
- [x] Context-seam tests: `status` for a session with and without a Loop; `changed` sequence across start, continue, pause, stop

## Comments

- `StopReason` moved from `src/loop.ts` to `src/rpc.ts` (the ticket's suggested fallback for the circular-import problem: `loop.ts` needs `StopReason` to type `stopLoop`'s parameter and also needs to emit `changed` via `rpc.ts`'s definition, so `rpc.ts` cannot import from `loop.ts`). `src/prompts.ts`'s `StopReason` import moved to match.
- Chose the `src/status.ts` emit-seam design named in the ticket (`toLoopStatus` + `setStatusEmitter`/`emitChanged`) over threading an emitter parameter through `subscribeToTurnEnd`, `stopLoop`, and the command factories: it kept the `loop.ts` and `commands.ts` diffs to one call each, at the one line each already writes state or stops the Loop.
- The fake Context's `rpc.register` now records `events.emit(name, data)` calls to `calls.rpcEmit`, so `test/rpc-status.test.ts` drives the `changed` sequence through the real commands and Turn End path rather than calling `emitChanged` directly.
- Emits happen after `writeLoopState`/`removeLoopState` resolves in every call site, so `calls.rpcEmit` always reflects storage that is already committed by the time a subscriber observes the event.

### Review follow-up (commit `083ff23`)

Code review of the first pass found four defects and a set of nits. Fixed without reopening the ticket:

- The `status` handler cast its input to `{ sessionID: string }`, so a malformed call crashed with a TypeError instead of a protocol failure. The `status` method now declares an `invalid_input` error and the handler narrows with `isStatusInput`, returning `context.error(...)` when that fails.
- `emitChanged` guarded only against a rejected promise. An emitter that threw synchronously escaped into the Loop, defeating the whole point of the seam. It is now wrapped in `try`/`catch` as well as `.catch`.
- `session.deleted` dropped state silently, so a TUI Indicator kept showing a Loop for a session that no longer existed. `StopReason` gains `deleted`; the branch reads state first (no Loop costs no write and emits nothing), then removes state, clears `pendingInbox`, and emits `changed` with `reason: "deleted"`. Still no Notice: the transcript it would go to is gone. `buildStoppedNotice` and `stopLoop` exclude `deleted` in their parameter types so that cannot regress.
- `setStatusEmitter` cleared the singleton unconditionally, so during an overlapping plugin reload the old cleanup silenced the new registration. It now returns a disposer that clears the slot only while its own emitter is installed.
- Nits: `iteration`/`maxIterations` are JSON Schema `integer`; the schema `properties` object carries `satisfies Record<keyof LoopStatus, unknown>` and the Stop Reason enum `satisfies StopReason[]`; the stale "`StopReason` comes from `loop.ts`" comment in `src/prompts.ts` is corrected; the `src/status.ts` module docstring now states why the seam exists rather than restating its call sites.
- `test/fake-context.ts` gains `setPermissionList` and `setRpcEmit`, matching `setSessionContext`/`setSessionGet`, so `test/rpc-status.test.ts` no longer mutates the fake through an `as unknown as` cast. Tests added for all of the above: 16 in the file, 74 in the suite.
