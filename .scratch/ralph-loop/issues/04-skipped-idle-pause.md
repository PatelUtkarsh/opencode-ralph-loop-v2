# 04: Skipped Idle pauses the Loop while the agent waits on the user

**What to build:** When the agent stops to ask a permission or a question, or when the user already has a message queued, the Loop does not re-prompt and does not spend an Iteration. `/ralph-status` and the Indicator later show `paused`. On the next Turn End the Loop resumes as normal.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** done

- [x] Turn End check order: pending permission (`ctx.permission.list`), open question tool call in the last assistant message, pending inbox items; any hit sets `paused: true`, persists, sends no prompt, leaves Iteration unchanged
- [x] A later Turn End with none of those conditions clears `paused` and proceeds with the normal continue/complete path
- [x] Context-seam tests for each of the three pause causes and for resume after pause

## Comments

- Implemented as `detectSkippedIdle(context, sessionID, messages, pendingInboxIDs)` in `src/loop.ts`, called from `handleTurnEnd` before `findCompletion`. Returns `"permission" | "question" | "inbox" | undefined`.
- Question tool-call check: matches a `content` part with `type: "tool"` on the last `assistant` message whose `name` matches the word-boundary pattern `/(^|[_.\-])(question|ask)([_.\-]|$)/i` (so `question`, `ask_user`, `duty_question` match, but `task` does not, since `ask` must be a whole word segment) and whose `state.status` is `"streaming"` or `"running"`. Verified tool content shape from the OpenCode 2.0.2 schema: `{ type: "tool", id, name, state: { status: "streaming" | "running" | "completed" | "error", ... }, time }`.
- Inbox check: `ctx.session`'s `SessionDomain` (`node_modules/@opencode/plugin/dist/promise/session.d.ts`) is `Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "rename" | "move" | "wait" | "context">`, no `inbox` method, and `Plugin.Context` exposes no other client handle. There is no way to read the session inbox directly from a plugin. Replaced the earlier `time.idle`/`time.updated` heuristic with exact tracking from the event stream `subscribeToTurnEnd` already consumes: a module-scope `pendingInbox: Map<sessionID, Set<inboxID>>` adds an `inboxID` on `session.inbox.enqueued` when `item.type === "user"`, and removes it on `session.inbox.delivered` or `session.inbox.cancelled`, deleting the session's entry once its set is empty and on `session.deleted`. `detectSkippedIdle`'s inbox check is then `pendingInboxIDs.size > 0`. This is in-memory only (cleared on stop and delete) but exact, not a heuristic; it also works across Resume/restart because a queued item that survives a restart is re-delivered and produces a fresh Turn End regardless.
- A `permission.list` rejection inside `detectSkippedIdle` is caught, logged with `[ralph-loop]`, and treated as "no pending permission" so it never aborts the Turn End.
- Added `permissionListResult` seed to `test/fake-context.ts` (mirrors the `sessionContextResult` pattern) so tests can make `permission.list` return a pending item. No new fake seed was needed for the inbox path: tests push `session.inbox.enqueued` / `session.inbox.delivered` events through `fake.push`.
- Tests added to `test/loop.test.ts` in a new `describe("Turn End: Skipped Idle (ADR-0002)")` block: one per pause cause (permission, question via `ask_user`, inbox via enqueue-then-Turn-End), a negative case for a running `task` tool call (name contains "ask" but not as a whole word), a negative case for a `completed` question tool call, an inbox resume test (enqueue pauses, `delivered` then resumes), a check-order test (pending permission and an open question at the same Turn End still produce exactly one `paused: true` storage write and no prompt), and the general resume-after-pause test.
