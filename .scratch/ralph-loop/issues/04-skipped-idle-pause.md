# 04: Skipped Idle pauses the Loop while the agent waits on the user

**What to build:** When the agent stops to ask a permission or a question, or when the user already has a message queued, the Loop does not re-prompt and does not spend an Iteration. `/ralph-status` and the Indicator later show `paused`. On the next Turn End the Loop resumes as normal.

**Blocked by:** 03 (Turn End continues the Loop or completes it)

**Status:** done

- [x] Turn End check order: pending permission (`ctx.permission.list`), open question tool call in the last assistant message, pending inbox items; any hit sets `paused: true`, persists, sends no prompt, leaves Iteration unchanged
- [x] A later Turn End with none of those conditions clears `paused` and proceeds with the normal continue/complete path
- [x] Context-seam tests for each of the three pause causes and for resume after pause

## Comments

- Implemented as `detectSkippedIdle(context, sessionID, messages, since)` in `src/loop.ts`, called from `handleTurnEnd` before `findCompletion`. Returns `"permission" | "question" | "inbox" | undefined`.
- Question tool-call check: matches a `content` part with `type: "tool"` on the last `assistant` message whose `name` (lowercased) contains `"question"` or `"ask"` and whose `state.status` is not `"completed"`. The exact `tool` content-part shape (`{ type: "tool", name?, state?: { status? } }`) is an assumption, not confirmed against a live OpenCode server; recorded in the architecture skill and in `TranscriptMessage`'s docstring.
- Inbox check: `ctx.session`'s `SessionDomain` (`node_modules/@opencode/plugin/dist/promise/session.d.ts`) is `Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "rename" | "move" | "wait" | "context">`, no `inbox` method, and `Plugin.Context` exposes no other client handle. There is no way to read the session inbox directly from a plugin. Fell back to `ctx.session.get`'s `time.idle`/`time.updated` fields: treats `time.idle === undefined && time.updated > since` as a pending inbox item, where `since` is the last Turn End this module handled for the session (or the Loop's `startedAt` for the first one). This is a known-weak heuristic: `time.idle` is normally set by the time a `session.execution.succeeded` event reaches this handler, so in practice this branch is expected to fire rarely rather than on every queued message. A future ticket could tighten this if a direct inbox read becomes available on `Plugin.Context`.
- Added `permissionListResult` seed to `test/fake-context.ts` (mirrors the `sessionContextResult` pattern) so tests can make `permission.list` return a pending item. No new fake method was needed for the inbox path since it reuses `session.get`.
- Tests added to `test/loop.test.ts` in a new `describe("Turn End: Skipped Idle (ADR-0002)")` block: one per pause cause (permission, question, inbox) and one resume-after-pause test.
