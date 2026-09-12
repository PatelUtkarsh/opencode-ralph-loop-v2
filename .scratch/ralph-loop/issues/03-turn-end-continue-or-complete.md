# 03: Turn End continues the Loop or completes it

**What to build:** After the agent finishes a turn in a Loop Session, the plugin either sees the Completion Promise and posts a completion Notice with cost and token deltas, or sees Max Iterations reached and posts a Notice, or sends the next Continuation Prompt. The user never has to type "continue".

**Blocked by:** 02 (`/ralph-loop` starts a Loop and sends the Start Prompt)

**Status:** ready-for-agent

- [ ] Event subscription via `ctx.event.subscribe` started in setup and aborted in cleanup
- [ ] Acts on `session.execution.succeeded`; ignores `session.idle`; ignores sessions without a Loop; ignores events whose `location.directory` is present and differs from `ctx.location.directory`
- [ ] `findCompletion(messages, promise)` pure function: joins text content of all `assistant` messages after the last `user` or `synthetic` message; matches `<promise>\s*PROMISE\s*</promise>` case-insensitively
- [ ] On match: remove state, post completion Notice with Iteration count, cost delta, token delta
- [ ] On `iteration >= maxIterations`: remove state, post Max Iterations Notice with deltas
- [ ] Otherwise: increment Iteration, persist, send Continuation Prompt (`[RALPH LOOP - ITERATION i/max]`, Rules, `Original task:` verbatim)
- [ ] Re-entrancy guard: a second Turn End for the same session while one is being handled is dropped
- [ ] Unit tests for `findCompletion` (trailing closing line, early stray promise before a user message, case and whitespace); Context-seam tests for continue, complete, max, guard, foreign location
