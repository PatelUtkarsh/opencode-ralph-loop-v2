# 06: Resume Loops after a service restart

**What to build:** A user restarts the OpenCode service while a Loop is running. When the plugin loads again, the Loop continues without a new `/ralph-loop`. Loops whose session no longer exists are discarded.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** done

- [x] Setup scans storage prefix `loop/` with cursor pagination
- [x] For each entry, `ctx.session.get`; not-found removes the key
- [x] For an existing session that is not currently executing, the entry is handled as a Turn End
- [x] For an executing session, nothing happens; the next Turn End event handles it
- [x] Context-seam tests: missing session dropped, idle session re-prompted, busy session untouched

## Comments

- Implemented as `src/resume.ts` exporting `resumeLoops(context, onTurnEnd)`, called from `setup` in `src/index.ts` after the Turn End subscription starts. `onTurnEnd` is wired to `handleTurnEnd`, the guarded wrapper returned by `subscribeToTurnEnd` (not `runTurnEnd` directly), so Resume shares the same in-memory re-entrancy guard as a live `session.execution.succeeded` event and a race between the two produces exactly one Continuation Prompt.
- Idle vs busy heuristic (not directly specified, since `Session.Info` has no boolean "is executing" field): a session is treated as idle when `time.idle` is defined and `>= time.updated`, or when `outcome` is set (the last execution finished, succeeded/failed/interrupted). Otherwise it is treated as busy and left for the next live Turn End event. This heuristic is unverified against a real OpenCode service restart; ticket 09's manual checklist ("restart `opencode service restart` mid-loop and confirm Resume") is the point where it gets checked against the real server.
- Risk flagged for that same manual check: `outcome` is treated as idle unconditionally, with no timestamp comparison against `time.updated`. If the real server keeps a stale `outcome` from a prior turn set on a session that has since started a new execution (i.e. `outcome` was not cleared when the next turn began), Resume would misread a genuinely busy session as idle and send a second Continuation Prompt concurrently with the agent's live turn. Ticket 09 should watch for a duplicate prompt on restart specifically when the session was mid-turn at shutdown.
- Only a not-found `session.get` rejection discards a Loop. `isSessionNotFound` checks, in order, an effect-style `_tag === "SessionNotFoundError"`, an HTTP-style `status === 404`, or a `name`/`message` containing "not found" (case-insensitive). Any other rejection (e.g. a transient network error) is logged and the storage key is left in place, so a temporary blip cannot silently drop a Loop.
- Resume never throws out of `setup`, and `setup` does not await it (`void resumeLoops(...)`, since Resume cannot reject): a failed `storage.scan` call stops Resume for that call (logged); a per-entry error (a bad `session.get` response shape, or `onTurnEnd` throwing) is caught individually so one bad Loop does not stop Resume from processing the rest. The scan loop also stops if the backend ever returns a `next` cursor equal to the last one or an empty page, so a misbehaving backend cannot spin it forever.
- Added `test/resume.test.ts` at Seam 1 (9 tests, including the Plugin.setup-level race test), and extended `test/fake-context.ts` with `setSessionGet` (mirrors `setSessionContext`) plus real cursor semantics in `storage.scan` (sorted keys, `after`/`limit` honoured, `next` returned) and an optional `storageScanPageSize` seed so a test can force pagination across two pages.
- Test count after this ticket: 39 (30 before ticket 06, 9 in `test/resume.test.ts`). Full suite and `tsc --noEmit` both clean.
