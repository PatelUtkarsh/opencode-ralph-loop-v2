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

- Implemented as `src/resume.ts` exporting `resumeLoops(context, onTurnEnd)`, called from `setup` in `src/index.ts` after the Turn End subscription starts, with `onTurnEnd` wired to the newly exported `runTurnEnd` from `src/loop.ts`.
- Idle vs busy heuristic (not directly specified, since `Session.Info` has no boolean "is executing" field): a session is treated as idle when `time.idle` is defined and `>= time.updated`, or when `outcome` is set (the last execution finished, succeeded/failed/interrupted). Otherwise it is treated as busy and left for the next live Turn End event. This heuristic is unverified against a real OpenCode service restart; ticket 09's manual checklist ("restart `opencode service restart` mid-loop and confirm Resume") is the point where it gets checked against the real server.
- Resume never throws out of `setup`: a failed `storage.scan` call stops Resume for that call (logged, `setup` continues); a per-entry error (a bad `session.get` response shape, or `onTurnEnd` throwing) is caught individually so one bad Loop does not stop Resume from processing the rest.
- Added a `test/resume.test.ts` at Seam 1, and extended `test/fake-context.ts` with `setSessionGet` (mirrors `setSessionContext`) plus real cursor semantics in `storage.scan` (sorted keys, `after`/`limit` honoured, `next` returned) and an optional `storageScanPageSize` seed so a test can force pagination across two pages.
- Test count after this ticket: 34 (30 before, 4 new in `test/resume.test.ts`). Full suite and `tsc --noEmit` both clean.
