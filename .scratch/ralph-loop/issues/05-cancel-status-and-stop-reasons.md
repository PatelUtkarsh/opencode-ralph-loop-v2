# 05: `/cancel-ralph`, `/ralph-status`, and the remaining Stop Reasons

**What to build:** A user can stop a Loop with `/cancel-ralph` and see the Iteration reached. `/ralph-status` shows Iteration, Max Iterations, paused state, and Task, or says no Loop is active. Pressing Esc cancels the Loop. A provider failure stops the Loop unless `stopOnFailure` is false. Deleting the session removes its Loop.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** done

- [x] Command `cancel-ralph`: removes state, posts Notice with Stop Reason `cancelled` and Iteration reached; posts "no active Loop" Notice when none exists
- [x] Command `ralph-status`: posts Notice with Iteration, Max Iterations, paused, Task; or "no active Loop"
- [x] `session.execution.interrupted` stops with reason `interrupted` and a Notice
- [x] `session.execution.failed` stops with reason `failed` and a Notice when `stopOnFailure` is true (default); when false it is handled as a Turn End
- [x] `session.deleted` removes state without a Notice
- [x] Context-seam tests for every path above

## Comments

Implemented by generalising `src/loop.ts`'s Turn End `stop()` into an
exported `stopLoop(context, sessionID, state, reason)` that handles all
five Stop Reasons (`completed`, `max-iterations`, `cancelled`,
`interrupted`, `failed`). `completed` and `max-iterations` still compute
and report cost/token deltas via `computeDeltas`; the other three report
only the Iteration reached, via the new `buildStoppedNotice(reason,
iteration)` in `src/prompts.ts`.

`subscribeToTurnEnd` gained a second parameter `{ stopOnFailure? }`
(default `true`) and now dispatches on three more event types inside the
same subscription loop: `session.execution.interrupted` stops with reason
`interrupted`; `session.execution.failed` stops with reason `failed`, or
is routed through the existing Turn End path when `stopOnFailure` is
`false`; `session.deleted` removes the Loop state directly with no
Notice. Sessions with no Loop in storage are ignored for `interrupted`
and `failed` (mirrors the existing Turn End guard).

`src/commands.ts` gained `createCancelLoopCommand(context)` and
`createStatusCommand(context)`, built the same way as
`createStartLoopCommand`. Cancel calls `stopLoop(..., "cancelled")` when
a Loop exists, else posts `buildNoActiveLoopNotice()`. Status posts
`buildStatusNotice({ iteration, maxIterations, paused, task })` when a
Loop exists, else the same no-active-Loop Notice.

`src/index.ts` registers both new commands via the same
`ctx.command.transform` call, reads `stopOnFailure` from `ctx.options`
(default `true`, same pattern as `maxIterations` and `promise`), and
passes it to `subscribeToTurnEnd`.

Tests: `test/cancel-status-and-stop-reasons.test.ts`, one test per path
named in the ticket (8 tests): cancel with an active Loop, cancel with no
Loop, status with an active Loop (paused), status with no Loop,
`session.execution.interrupted`, `session.execution.failed` with the
default option, `session.execution.failed` with `stopOnFailure: false`
(asserts the Continuation Prompt is sent and Iteration increments), and
`session.deleted` (state gone, no Notice). Full suite: 38 pass, 0 fail.
`tsc --noEmit` clean.

Left for later tickets: Skipped Idle checks (ticket 04, sibling
worktree) and Resume on `setup` (ticket 06, sibling worktree) both touch
the same `subscribeToTurnEnd` function in `src/loop.ts`; this ticket's
diff there was kept to the `stop`/`stopLoop` extraction and the
dispatch's `if`/`else if` chain to minimise merge conflicts.
