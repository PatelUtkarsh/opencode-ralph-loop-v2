# 04: Skipped Idle pauses the Loop while the agent waits on the user

**What to build:** When the agent stops to ask a permission or a question, or when the user already has a message queued, the Loop does not re-prompt and does not spend an Iteration. `/ralph-status` and the Indicator later show `paused`. On the next Turn End the Loop resumes as normal.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** ready-for-agent

- [ ] Turn End check order: pending permission (`ctx.permission.list`), open question tool call in the last assistant message, pending inbox items; any hit sets `paused: true`, persists, sends no prompt, leaves Iteration unchanged
- [ ] A later Turn End with none of those conditions clears `paused` and proceeds with the normal continue/complete path
- [ ] Context-seam tests for each of the three pause causes and for resume after pause
