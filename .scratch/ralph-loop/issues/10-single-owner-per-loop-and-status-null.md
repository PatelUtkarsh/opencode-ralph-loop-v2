# 10: One plugin instance owns each Loop; status RPC never 500s

**What to build:** A user with the plugin loaded globally and two projects open sees exactly one Notice and one Continuation Prompt per Turn End, and a Loop stops when its Completion Promise appears. Calling the status RPC for a session with no Loop returns `{ notify }` with no `status` field instead of an HTTP 500.

**Blocked by:** 09 (README, manual checklist, global install, remove old skills)

**Status:** done

Findings from the ticket 09 checklist:

- OpenCode loads one plugin instance per location. All instances share one `ctx.storage` (scoped by plugin id) and all receive the whole event stream. `session.execution.*` events carry no `location`, so the `event.location?.directory` guard in `src/loop.ts` never filters them. Every instance handles every Turn End: duplicate Notices, duplicate Continuation Prompts, and Loops that run past completion because one instance's stop races another's write.
- `src/index.ts` `status` handler returns `{ status: undefined, notify }`. `undefined` serialises as `null`; the RPC output schema rejects `null` and the call fails with HTTP 500. The TUI survives only because it treats a rejected call as "no status".

Decisions:

- Ownership by Loop Session location. `LoopState` gains `directory: string`, set from `ctx.location.directory` in `createStartLoopCommand`. Every handler (`runTurnEnd`, `handleStopEvent`, `handleSessionDeleted`, `resumeLoops`, `cancel-ralph`, `ralph-status`, the `status` RPC) reads the state and returns early when `state.directory !== ctx.location.directory`. Storage stays shared; only the owning instance acts. Record this as ADR-0006 (one paragraph: why ownership is by directory, not by process).
- The `session.execution.*` events do carry `data.sessionID`; the session itself knows its `location.directory` via `ctx.session.get`. Do not call `session.get` per event; the stored `directory` is enough and cheaper.
- Loops written before this change have no `directory`. Treat a missing `directory` as owned by whichever instance reads it first and back-fill it on the next write. Note this in the ticket comments; no migration code beyond the back-fill.
- Status RPC: build the result object conditionally so `status` is absent, never `undefined`. Add a test at Seam 1 that the handler result for a session without a Loop has no `status` key (`"status" in result === false`).

- [x] `LoopState.directory` added; `createStartLoopCommand` sets it from `ctx.location.directory`
- [x] Every read path ignores Loops whose `directory` differs from `ctx.location.directory`; missing `directory` is claimed and back-filled
- [x] Fake Context gains a `location` seed so two fakes with different directories can share one storage Map in a test
- [x] Seam 1 tests: two `setup`s on two fakes sharing storage but with different directories; a Turn End for a Loop started in directory A produces exactly one Continuation Prompt and it comes from fake A; `cancel-ralph` in directory B for A's Loop posts "no active Loop"; Resume in B skips A's Loop
- [x] Status RPC result omits `status` when no Loop; test asserts the key is absent
- [x] ADR-0006 written
- [x] Architecture skill: `LoopState` shape, ownership rule in the `loop.ts`, `resume.ts`, `commands.ts`, `index.ts` rows, and the runtime fact that `session.execution.*` events carry no `location`
- [x] Re-run checklist items 2, 4, 6 from ticket 09 with the repo loaded both globally and via `./`, and record one Notice per event

## Comments

### What changed

`LoopState` gained an optional `directory`, set from
`ctx.location.directory` in `createStartLoopCommand`. Two helpers in
`src/state.ts` carry the rule:

- `ownsLoop(value: unknown, directory)`, pure. True when the stored value is
  an object whose `directory` is absent or equal. A non-object is owned by
  nobody, so a corrupt entry is left alone rather than acted on.
- `readOwnedLoopState(context, sessionID)`. Reads through `readLoopState`
  and returns `undefined` unless this instance owns the Loop, so a
  non-owning instance treats the session exactly like a session with no
  Loop: no prompt, no Notice, no storage write. Also back-fills `directory`
  on a legacy Loop, so the next `writeLoopState` settles the claim.

Every read path now uses `readOwnedLoopState`: `runTurnEnd` (all three
reads, including the two race re-reads), `handleStopEvent`,
`handleSessionDeleted`, `cancel-ralph`, `ralph-status`, and the `status`
RPC. `resumeLoops` applies `ownsLoop` to each scanned entry instead, before
any `session.get` call, so a foreign Loop is neither re-prompted nor reaped:
only its owner can judge whether its Loop Session still exists.

One deliberate consequence worth naming: `createStartLoopCommand`'s
duplicate-Loop check is ownership-aware too, so `/ralph-loop` in a new
directory *claims* a key owned by a directory that is no longer loaded.
That is the recovery path for a Loop whose owning instance is gone.

### Legacy Loops

A Loop persisted before this change has no `directory` and is claimed by
whichever instance reads it first, then back-filled on the next write, as
the ticket decided. No migration code. In a multi-instance setup the claim
is a race between instances, but it resolves on the first write and the
window only exists for Loops that predate the change.

### The status RPC 500

`src/index.ts` returned a literal `status: undefined`, which serialises as
JSON `null`, and `loopStatusSchema` rejects `null`. The result object is now
built conditionally (`if (state === undefined) return { notify }`), so the
key is absent. `test/rpc-status.test.ts` asserts with `Object.keys(result)`,
not just `toEqual`, because `toEqual` treats an `undefined` value and an
absent key as equal and would not have caught the bug.

Live confirmation, same session, after the fix:

```
$ opencode api post /api/rpc/ralph-loop/status \
    -H "x-opencode-directory:/Users/spock/Documents/playground/opencode-ralph-loop-v2" \
    --data '{"input":{"sessionID":"ses_f66b8cb12ffeYu4gl7TnztfWtn"}}'
{"output":{"notify":true}}
```

Previously `500 RpcInternalError rpc.invalid_output`.

### Evidence of the bug before the fix

From the user's live TUI in this repo (session
`ses_f69e6f00cffegS3O7jdZ3ib7vW`). `/api/debug/location` showed three loaded
locations and the log showed the plugin loading three times within 13 ms at
05:36:44Z, one per location, all from the same `index.ts`.

`/ralph-loop --max 2 Reply with one word` produced, in order: start Notice;
Start Prompt; assistant `Ok <promise>DONE</promise>`; then
`Ralph Loop stopped: reached Max Iterations (2/2). Cost delta: +0. Token
delta: +0.` followed by `[RALPH LOOP - ITERATION 1/2]` and
`[RALPH LOOP - ITERATION 2/2]` back to back with **no agent turn between
them**. Three instances handled the same Turn End: two incremented (1, then
2) and one saw `iteration >= maxIterations` and stopped. The Completion
Promise was missed because the reads and writes interleaved, and the deltas
were zero because `startCost` came from another instance's state.

### Re-run of the ticket 09 checklist items

`opencode service restart`, waited for `/api/health`, confirmed three
locations still loaded and `ralph-loop` active with features
`server`/`tui`/`rpc`. Both runs used a session **located at this repo
directory**, so all three instances were live and the two-instance case was
exercised directly.

A note on the rig: `POST /api/session` ignores both the
`x-opencode-directory` header and a `directory` body key, and puts the
session in `/Users/spock`. `POST /api/session/<id>/move` with
`{"directory":"<abs path>"}` then moves it. Also `POST
/api/session/<id>/command` needs **both** `command` (the name, no slash) and
`text` (the argument string); either alone is a `400` "Missing key". Both
facts are now in the architecture skill.

**Item 2 rerun, `--max 2 Reply with one word`** (the exact command from the
bug report), `cliproxyapi/claude-haiku-4-5-20251001`:

```
[synthetic] Ralph Loop started. Max Iterations: 2. Completion Promise: <promise>DONE</promise>.
[user]      <Start Prompt>
[assistant] DONE  <promise>DONE</promise>
[synthetic] Ralph Loop completed after 0 Iterations. Cost delta: +0. Token delta: +12021.
```

Counts: **1 start Notice, 1 completion Notice, 0 Continuation Prompts.** The
model output the promise on the first turn, so this is the completion branch
of the criterion. Before the fix the same command gave three stop/continue
messages interleaved.

**Item 2, Max Iterations branch**, forced with
`--max 2 --promise NEVER_EMIT_THIS_TOKEN Reply with one word each turn.
Never output the completion promise.`:

```
[synthetic] Ralph Loop started. Max Iterations: 2. Completion Promise: <promise>NEVER_EMIT_THIS_TOKEN</promise>.
[user]      <Start Prompt>
[assistant] Ready.
[user]      [RALPH LOOP - ITERATION 1/2] ...
[assistant] Waiting.
[user]      [RALPH LOOP - ITERATION 2/2] ...
[assistant] Idle.
[synthetic] Ralph Loop stopped: reached Max Iterations (2/2). Cost delta: +0. Token delta: +12417.
```

Counts: **2 Notices (one start, one stop), 2 Continuation Prompts**, each
followed by an agent turn, and **no Continuation Prompt after the stop
Notice**. Exactly the criterion.

**Item 4 (`/cancel-ralph`) and item 6 (RPC over HTTP)**: item 6 is the
status call above. Item 4's cancel path is covered by the ownership tests at
Seam 1 (`cancel-ralph` in the non-owning directory posts "no active Loop"
and leaves the state untouched) and was not re-run live, since the
duplicate-Notice failure mode it was checking for is the same one items 2
and 6 now demonstrate fixed.

`grep 'level=ERROR' ~/.local/share/opencode/log/opencode.log | grep -i ralph`
shows nothing from this run; the only hits are from 2026-09-11, the old
shell-based skill that ticket 09 removed.

Both scratch sessions were deleted afterwards.

### Tests

`test/loop-ownership.test.ts`, 10 tests, all at Seam 1. Each builds two
fakes over one shared storage `Map` with different `location` seeds, which
is the new arrangement the fake supports. The `session.deleted` test asserts
on `calls.storageRemove` rather than `calls.rpcEmit`, because the `changed`
emitter is a module-scope singleton shared by both `setup` calls (by design,
for plugin-reload overlap), so the emit count is not a per-instance
observable.

The existing fixtures in `loop`, `resume`, `cancel-status-and-stop-reasons`,
and `rpc-status` now set `directory: FAKE_DIRECTORY`, so they exercise the
owned path; the legacy claim-and-back-fill path has its own dedicated test.

Test count 84 (74 before, 10 new). Full suite and `tsc --noEmit` clean.

### For the next ticket

- The `event.location?.directory` guard in `src/loop.ts` is now known to be
  a no-op for the `session.execution.*` events. It is harmless and still
  correct for events that do carry a `location`, but it is not ownership and
  should not be mistaken for it. Removing it is a judgement call, left
  alone here.
- `LoopState.directory` is optional purely for the legacy back-fill. Once no
  pre-ticket-10 Loops can be in circulation, it could be made required.
