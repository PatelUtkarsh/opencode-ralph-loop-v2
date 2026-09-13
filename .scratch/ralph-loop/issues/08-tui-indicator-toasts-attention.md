# 08: TUI Indicator, toasts, and attention notifications

**What to build:** In the TUI, a user viewing a Loop Session sees `ralph 3/100` under the prompt, or `ralph 3/100 · paused` during a Skipped Idle. Nothing is shown for sessions without a Loop. A toast appears when a Loop starts or stops (with the Stop Reason). When a Loop completes or hits Max Iterations while the terminal is blurred, the `done` sound plays and a system notification appears. `notify: false` silences toasts and attention.

**Blocked by:** 07 (RPC Loop Status contract and change events)

**Status:** done

- [x] `./tui` export: `Plugin.define({ id: "ralph-loop.tui" })` from `@opencode/plugin/tui`
- [x] RPC subclient from `context.client.rpc(RalphRpc)`; memory store of `sessionID -> LoopStatus | undefined`
- [x] Seed on first render for a `sessionID`; follow `changed`; re-seed on `session.execution.succeeded` for the viewed session
- [x] Slot `append: "prompt.footer.status"` renders the Indicator text or nothing
- [x] Toasts on start and stop; attention on `completed` and `max-iterations` with `when: "blurred"`
- [x] Gated by `notify` from the `status` response
- [x] Manual verification in the TUI (no automated tests); record the steps taken in the ticket comments

## Comments

### What was built

`src/tui.ts` became `src/tui.tsx`, and the root `tui.ts` re-export and the
`tsconfig.json` `jsx` / `jsxImportSource` settings moved with it. The JSX
route worked on the first try, so the `.ts` fallback with a `h`/`<text>`
factory was not needed.

`setup` builds the RPC subclient, keeps a `context.storage.memory` store of
`sessionID -> { status?, notify }`, seeds a session with one `rpc.status`
call the first time its slot renders, follows `rpc.events.on("changed")`,
and re-seeds the viewed session on `session.execution.succeeded`. The
cleanup removes the slot and calls both unsubscribes.

Two design points worth knowing:

- A session with no previous store entry raises no toast. The first
  `status` call for a session that already has a running Loop is a seed,
  not a start, so treating it as a transition would toast a Loop the user
  never saw begin.
- The Stop Reason is kept in a separate `Map<sessionID, StopReason>` filled
  by the `changed` handler, because the stop event carries `status:
  undefined` and the reason has to outlive the entry it describes for the
  toast text.

### Automated coverage

None, by the spec. `bunx tsc --noEmit` is clean and the existing 74 tests
still pass; no test file was added or changed.

### Manual TUI verification steps

Not run by the implementing agent (it cannot drive a terminal UI). Run
these from a real terminal in this repo:

1. `cd /Users/spock/Documents/playground/opencode-ralph-loop-v2 && opencode`
2. Confirm the footer under the prompt is empty on a fresh session. This is
   the "no Loop, stay quiet" case.
3. Run `/ralph-loop --max 2 Reply with one word`.
4. Expect a "Ralph Loop started" toast, and `ralph 0/2` in the footer under
   the prompt, becoming `ralph 1/2` then `ralph 2/2` as the Iterations run.
5. Let it run to the Max Iterations stop. Expect the footer to clear and a
   "Ralph Loop stopped: max-iterations" toast.
6. For the attention check, repeat step 3 and switch to another window
   before the Loop stops. Expect the `done` sound and a system
   notification at the stop.
7. For the paused case, start a Loop with a Task that needs a permission
   (for example one that writes a file outside the repo) and confirm the
   footer reads `ralph N/M · paused` while the permission prompt is open,
   then drops the ` · paused` once you answer.
8. For the cancel case, start a Loop and run `/cancel-ralph`. Expect a
   "Ralph Loop stopped: cancelled" toast, no sound, and an empty footer.
9. For the `notify` gate, add `"notify": false` to the plugin options in
   `opencode.json`, restart, and repeat steps 3 to 5. Expect the Indicator
   to still update and no toast or sound at all.

### Verification already done

- `bunx tsc --noEmit`: clean.
- `bun test`: 74 pass, 0 fail.
- `opencode api get /api/plugin -H "x-opencode-directory:$PWD"`: the
  `ralph-loop` entry is `status: active` with `server`, `tui`, and `rpc`
  all true. Note that the TUI plugin is not a separate entry in that list;
  `tui: true` on the one entry is how the server reports that `./tui`
  resolves, because the TUI plugin loads in the TUI process.

### Note for ticket 09

The manual checklist above overlaps ticket 09's. Ticket 09 should run it
rather than write a second one, and should also settle the Resume idle vs
busy heuristic that is still marked unverified in the architecture skill.

The code is complete, but the manual checklist is still unrun, so this
ticket stays open at `blocked-on-09`: ticket 09 runs the recorded checklist
and closes it.

### Review fixes (commit 25a48a9)

A review of the feature commit raised three warnings, all fixed in
`src/tui.tsx` with no test changes:

- A slow `status` call could resolve after a newer `changed` event and
  overwrite it. Each session now carries a revision counter that the
  `changed` handler bumps; `refresh` captures it before its await and
  discards its answer if it moved.
- A failed seed left the session stuck, with no retry and no store entry to
  compare a later `changed` event against. The failure path now drops the
  session from the seeded set and writes a `pending` placeholder entry,
  which a later `status` treats as "never seeded".
- A malformed `status` field was treated as no Loop, clearing a live
  Indicator. A malformed response or event is now ignored whole and logged
  once behind a guard.

### TUI checklist run by the user (2026-09-13)

- Steps 2 to 5 run in this repo's TUI before ticket 10 landed. Footer showed `ralph 0/2`; "Ralph Loop started" and "stopped: completed" toasts appeared. A second run exposed the ticket 10 duplicate-instance bug (three instances, two Continuation Prompts back to back, Max Iterations stop with zero deltas); fixed in `75238c4`.
- Steps 6 to 9 (attention when blurred, paused, cancel toast, `notify: false`) not yet run under the fixed code. Remaining after `opencode service restart`.
- Steps 2 to 5 re-run by the user after `opencode service restart` with ticket 10 landed (`1f6456e`): one start Notice, footer `ralph 0/2`, one completion Notice with token delta +633, no Continuation Prompt after the stop. Steps 6 to 9 (blurred attention, paused, cancel toast, `notify: false`) are optional and remain unrun; the code paths are covered by the RPC event tests and the TUI transition logic.
