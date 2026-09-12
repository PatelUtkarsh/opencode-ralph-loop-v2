# 05: `/cancel-ralph`, `/ralph-status`, and the remaining Stop Reasons

**What to build:** A user can stop a Loop with `/cancel-ralph` and see the Iteration reached. `/ralph-status` shows Iteration, Max Iterations, paused state, and Task, or says no Loop is active. Pressing Esc cancels the Loop. A provider failure stops the Loop unless `stopOnFailure` is false. Deleting the session removes its Loop.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** ready-for-agent

- [ ] Command `cancel-ralph`: removes state, posts Notice with Stop Reason `cancelled` and Iteration reached; posts "no active Loop" Notice when none exists
- [ ] Command `ralph-status`: posts Notice with Iteration, Max Iterations, paused, Task; or "no active Loop"
- [ ] `session.execution.interrupted` stops with reason `interrupted` and a Notice
- [ ] `session.execution.failed` stops with reason `failed` and a Notice when `stopOnFailure` is true (default); when false it is handled as a Turn End
- [ ] `session.deleted` removes state without a Notice
- [ ] Context-seam tests for every path above
