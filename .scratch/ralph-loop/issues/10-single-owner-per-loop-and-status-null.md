# 10: One plugin instance owns each Loop; status RPC never 500s

**What to build:** A user with the plugin loaded globally and two projects open sees exactly one Notice and one Continuation Prompt per Turn End, and a Loop stops when its Completion Promise appears. Calling the status RPC for a session with no Loop returns `{ notify }` with no `status` field instead of an HTTP 500.

**Blocked by:** 09 (README, manual checklist, global install, remove old skills)

**Status:** ready-for-agent

Findings from the ticket 09 checklist:

- OpenCode loads one plugin instance per location. All instances share one `ctx.storage` (scoped by plugin id) and all receive the whole event stream. `session.execution.*` events carry no `location`, so the `event.location?.directory` guard in `src/loop.ts` never filters them. Every instance handles every Turn End: duplicate Notices, duplicate Continuation Prompts, and Loops that run past completion because one instance's stop races another's write.
- `src/index.ts` `status` handler returns `{ status: undefined, notify }`. `undefined` serialises as `null`; the RPC output schema rejects `null` and the call fails with HTTP 500. The TUI survives only because it treats a rejected call as "no status".

Decisions:

- Ownership by Loop Session location. `LoopState` gains `directory: string`, set from `ctx.location.directory` in `createStartLoopCommand`. Every handler (`runTurnEnd`, `handleStopEvent`, `handleSessionDeleted`, `resumeLoops`, `cancel-ralph`, `ralph-status`, the `status` RPC) reads the state and returns early when `state.directory !== ctx.location.directory`. Storage stays shared; only the owning instance acts. Record this as ADR-0006 (one paragraph: why ownership is by directory, not by process).
- The `session.execution.*` events do carry `data.sessionID`; the session itself knows its `location.directory` via `ctx.session.get`. Do not call `session.get` per event; the stored `directory` is enough and cheaper.
- Loops written before this change have no `directory`. Treat a missing `directory` as owned by whichever instance reads it first and back-fill it on the next write. Note this in the ticket comments; no migration code beyond the back-fill.
- Status RPC: build the result object conditionally so `status` is absent, never `undefined`. Add a test at Seam 1 that the handler result for a session without a Loop has no `status` key (`"status" in result === false`).

- [ ] `LoopState.directory` added; `createStartLoopCommand` sets it from `ctx.location.directory`
- [ ] Every read path ignores Loops whose `directory` differs from `ctx.location.directory`; missing `directory` is claimed and back-filled
- [ ] Fake Context gains a `location` seed so two fakes with different directories can share one storage Map in a test
- [ ] Seam 1 tests: two `setup`s on two fakes sharing storage but with different directories; a Turn End for a Loop started in directory A produces exactly one Continuation Prompt and it comes from fake A; `cancel-ralph` in directory B for A's Loop posts "no active Loop"; Resume in B skips A's Loop
- [ ] Status RPC result omits `status` when no Loop; test asserts the key is absent
- [ ] ADR-0006 written
- [ ] Architecture skill: `LoopState` shape, ownership rule in the `loop.ts`, `resume.ts`, `commands.ts`, `index.ts` rows, and the runtime fact that `session.execution.*` events carry no `location`
- [ ] Re-run checklist items 2, 4, 6 from ticket 09 with the repo loaded both globally and via `./`, and record one Notice per event
