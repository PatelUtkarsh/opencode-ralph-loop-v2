# 03: Turn End continues the Loop or completes it

**What to build:** After the agent finishes a turn in a Loop Session, the plugin either sees the Completion Promise and posts a completion Notice with cost and token deltas, or sees Max Iterations reached and posts a Notice, or sends the next Continuation Prompt. The user never has to type "continue".

**Blocked by:** 02 (`/ralph-loop` starts a Loop and sends the Start Prompt)

**Status:** done

- [x] Event subscription via `ctx.event.subscribe` started in setup and aborted in cleanup
- [x] Acts on `session.execution.succeeded`; ignores `session.idle`; ignores sessions without a Loop; ignores events whose `location.directory` is present and differs from `ctx.location.directory`
- [x] `findCompletion(messages, promise)` pure function: joins text content of all `assistant` messages after the last `user` or `synthetic` message; matches `<promise>\s*PROMISE\s*</promise>` case-insensitively
- [x] On match: remove state, post completion Notice with Iteration count, cost delta, token delta
- [x] On `iteration >= maxIterations`: remove state, post Max Iterations Notice with deltas
- [x] Otherwise: increment Iteration, persist, send Continuation Prompt (`[RALPH LOOP - ITERATION i/max]`, Rules, `Original task:` verbatim)
- [x] Re-entrancy guard: a second Turn End for the same session while one is being handled is dropped
- [x] Unit tests for `findCompletion` (trailing closing line, early stray promise before a user message, case and whitespace); Context-seam tests for continue, complete, max, guard, foreign location

## Comments

Implemented in `src/loop.ts`: `subscribeToTurnEnd(context, signal)` runs a
single background loop over `ctx.event.subscribe`, guarded by an in-memory
`Set<sessionID>` for re-entrancy. `findCompletion` is pure and unit-tested
in `test/find-completion.test.ts` (7 cases, including regex-escaping the
promise string). `test/loop.test.ts` drives the real `Plugin.setup`
through the fake Context for continue, complete, Max Iterations, the
re-entrancy guard, a foreign `location.directory`, `session.idle`, and an
unrelated session with no Loop.

`buildContinuationPrompt`, `buildCompletionNotice`, and
`buildMaxIterationsNotice` were added to `src/prompts.ts`, reusing
`RULES_BLOCK`; a small `formatDeltaLine` helper avoids duplicating the
cost/token delta line between the two stop Notices.

Left for later tickets, per the ticket handover: Skipped Idle checks
(permission, question, inbox; ticket 04), `session.execution.failed` /
`.interrupted` / `session.deleted` handling (ticket 05), and Resume on
`setup` (ticket 06). `subscribeToTurnEnd` only reacts to
`session.execution.succeeded` today; the next tickets extend the same
event loop rather than replacing it.
