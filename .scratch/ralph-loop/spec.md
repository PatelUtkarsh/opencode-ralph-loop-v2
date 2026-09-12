# Spec: Ralph Loop plugin for OpenCode V2

Status: ready-for-agent

## Problem Statement

Long tasks in OpenCode stop when the agent ends a turn, even when the work is not finished. The user must type "continue" repeatedly or leave the session unattended and come back to a stalled agent. The existing Ralph Loop plugin only runs on OpenCode V1; V2 changed the plugin API, so it does not load. The existing global skills (`ralph-loop`, `cancel-ralph`, `help`) tell the agent to write a state file by shell, which is fragile and lets the agent escape the loop by deleting the file.

## Solution

A standalone OpenCode V2 plugin (`opencode-ralph-loop-v2`) that starts a Loop in the current session with `/ralph-loop <task>`. At every Turn End the plugin checks the transcript for the Completion Promise. If absent, it sends a Continuation Prompt with the Iteration header, the Rules, and the Task. The Loop stops on a truthful Completion Promise, Max Iterations, `/cancel-ralph`, user interrupt, provider failure, or session deletion. A companion TUI plugin shows an Indicator under the prompt with the current Iteration and paused state.

## User Stories

1. As a user, I want to start a Loop with `/ralph-loop <task>`, so that the agent keeps working without me typing "continue".
2. As a user, I want the Loop to stop when the agent outputs the Completion Promise, so that a finished task does not waste tokens.
3. As a user, I want the Completion Promise to be only accepted from assistant messages after the last user or synthetic message, so that an early stray promise does not end the Loop.
4. As a user, I want the Completion Promise to be found even when the agent posts a closing line after it, so that the Loop is not stuck on a formatting detail.
5. As a user, I want to set a custom promise with `--promise "TEXT"`, so that I can demand a verifiable statement instead of a generic token.
6. As a user, I want to set `--max N` per Loop, so that I can bound an experimental run.
7. As a user, I want a plugin option `maxIterations` as the default Max Iterations, so that I do not repeat `--max` on every Loop.
8. As a user, I want the plugin to clamp `--max` to the Hard Cap (500) and tell me, so that a typo does not run forever.
9. As a user, I want unknown flags to produce an error Notice and no Loop, so that a mistyped flag does not silently become part of the Task.
10. As a user, I want the Continuation Prompt to repeat the Task verbatim every Iteration, so that compaction does not lose the goal.
11. As a user, I want the Continuation Prompt to include the Rules, so that the agent does not output a false Completion Promise to escape.
12. As a user, I want the Loop to skip a Turn End when a permission request is pending, so that the plugin does not bury the permission prompt.
13. As a user, I want the Loop to skip a Turn End when the agent's last message is a question to me (open question tool call), so that I can answer before the Loop continues.
14. As a user, I want the Loop to skip a Turn End when my own message is already queued in the inbox, so that my message goes first.
15. As a user, I want a Skipped Idle to not count as an Iteration, so that pauses do not eat my budget.
16. As a user, I want the Loop to resume on the next Turn End after a Skipped Idle, so that I do not need to restart it.
17. As a user, I want `/cancel-ralph` to stop the Loop and report the Iteration reached, so that I regain manual control.
18. As a user, I want `/ralph-status` to show Iteration, Max Iterations, paused state, and Task, so that I can check progress without reading the transcript.
19. As a user, I want pressing Esc (interrupt) to cancel the Loop, so that my intent to stop is respected.
20. As a user, I want a provider failure to stop the Loop by default, so that a dead provider does not burn Iterations.
21. As a user, I want a plugin option `stopOnFailure: false` to keep the Loop going after a failure, so that transient errors do not end an unattended run.
22. As a user, I want deleting the session to remove its Loop, so that stale state does not linger.
23. As a user, I want the Loop to survive an OpenCode service restart and Resume, so that a restart does not lose an unattended run.
24. As a user, I want Loops whose session no longer exists to be discarded on Resume, so that storage stays clean.
25. As a user, I want a Notice in the transcript when a Loop starts, completes, hits Max Iterations, fails, is interrupted, or is cancelled, so that I can see the Stop Reason in context.
26. As a user, I want the completion and Max Iterations Notices to include the cost and token delta for the Loop, so that I know what the run cost.
27. As a user, I want starting a Loop when one is already active in the session to fail with a Notice, so that I do not silently replace a running Loop.
28. As a user, I want the Loop to bind only to the session where I invoked `/ralph-loop`, so that child sessions are never re-prompted.
29. As a user, I want an Indicator under the prompt showing `ralph N/M` for the viewed session, so that I can see progress at a glance.
30. As a user, I want the Indicator to show `paused` during a Skipped Idle, so that I know the Loop is waiting on me.
31. As a user, I want the Indicator to be absent when the viewed session has no Loop, so that the footer stays quiet.
32. As a user, I want a toast when a Loop starts and stops, so that I notice state changes without reading the transcript.
33. As a user, I want an attention notification with the `done` sound when a Loop completes or hits Max Iterations while the terminal is blurred, so that unattended runs get my attention.
34. As a user, I want a plugin option `notify: false` to disable toasts and attention notifications, so that I can keep the TUI quiet.
35. As a user, I want the plugin loadable from a local path via `plugins: ["/abs/path"]`, so that I can use it before it is published.
36. As a user, I want the Indicator to seed its state on TUI start and follow RPC events, so that it is correct after a reconnect.
37. As a user, I want the plugin to have a stable id `ralph-loop`, so that storage and diagnostics are consistent across versions.
38. As a maintainer, I want the loop logic tested through a fake plugin Context, so that behaviour is verified without a live model.
39. As a maintainer, I want flag parsing and completion detection to be pure functions with unit tests, so that edge cases are cheap to cover.
40. As a maintainer, I want a manual end-to-end checklist, so that the real API shapes are verified once before first use.

## Implementation Decisions

### Package

- Standalone repo, package name `opencode-ralph-loop-v2`, MIT, `type: module`.
- Exports: `.` (server plugin), `./tui` (TUI plugin), `./rpc` (shared RPC contract).
- Dependency `@opencode/plugin` pinned to the installed OpenCode version (2.0.2). Peer deps `@opentui/core`, `@opentui/solid`, `solid-js` for the TUI entry.
- Tooling: `bun test`, `tsc --noEmit`. No build step; OpenCode loads TypeScript directly.
- The repo's own `opencode.json` adds `"plugins": ["."]` so the plugin self-loads when working in the repo.

### Server plugin (`Plugin.define({ id: "ralph-loop" })`)

- **Options** from `ctx.options`: `maxIterations` (default 100), `promise` (default `DONE`), `stopOnFailure` (default true), `notify` (default true, consumed by the TUI via RPC status).
- **Loop state** in `ctx.storage` at key `loop/<sessionID>` (ADR-0001). Shape: `{ sessionID, task, promise, iteration, maxIterations, paused, startedAt, startCost, startTokens }`.
- **Commands** registered via `ctx.command.transform`: `ralph-loop`, `cancel-ralph`, `ralph-status`. Command executors receive `{ sessionID, prompt, delivery }`; `prompt.text` is the argument string only (confirmed by probe).
- **Argument grammar** for `/ralph-loop`: leading flags `--max <int>` and `--promise <text>`; quotes group words; the remainder is the Task. Unknown leading `--flag` is an error. Empty Task is an error. `--max` above Hard Cap 500 is clamped with a Notice.
- **Start**: reject if a Loop exists for the session (Notice). Otherwise persist state with iteration 0, record `startCost` and `startTokens` from `ctx.session.get`, post a start Notice, then `ctx.session.prompt` the Start Prompt (Task plus Rules) using the invocation's `delivery`.
- **Turn End detection** (ADR-0004): subscribe with `ctx.event.subscribe`; act on `session.execution.succeeded`. Ignore `session.idle`. Ignore events whose `data.sessionID` has no Loop. Ignore events whose `location.directory` differs from `ctx.location.directory` when present.
- **On Turn End** for a Loop Session, in order:
  1. If `ctx.permission.list({sessionID})` is non-empty, set `paused: true`, persist, emit status, return.
  2. If the last assistant message contains a `question`-type tool call without a completed result, set paused, persist, emit, return.
  3. If the session inbox has pending user items, set paused, persist, emit, return.
  4. Read `ctx.session.context`. Take all `assistant` messages after the last `user` or `synthetic` message. Join their `text` content. If it matches `<promise>\s*PROMISE\s*</promise>` (case-insensitive, whitespace tolerant), stop with reason `completed`.
  5. If `iteration >= maxIterations`, stop with reason `max-iterations`.
  6. Increment `iteration`, set `paused: false`, persist, emit status, send the Continuation Prompt via `ctx.session.prompt`.
- **Re-entrancy guard**: an in-memory `Set<sessionID>` of Loop Sessions currently being handled; a second Turn End for the same session while handling is in progress is dropped.
- **Other events**: `session.execution.interrupted` stops with reason `interrupted`. `session.execution.failed` stops with reason `failed` unless `stopOnFailure` is false, in which case it is treated as a Turn End. `session.deleted` removes state silently (no Notice, the session is gone).
- **Stop**: remove storage key, compute cost and token delta from `ctx.session.get`, post a Notice with Stop Reason (and deltas for `completed` and `max-iterations`), emit RPC `changed` with `status: undefined` for the session.
- **Continuation Prompt** text: `[RALPH LOOP - ITERATION i/max]`, a sentence saying the previous turn did not output the Completion Promise, the Rules block, then `Original task:` and the Task verbatim. The Rules: only output the Completion Promise when the task is completely and verifiably finished; the statement must be true; do not output a false promise to escape; if blocked, explain and ask for help; `/cancel-ralph` stops the Loop.
- **Start Prompt** text: the Task, then the same Rules and the exact Completion Promise to output.
- **Resume**: on `setup`, scan `loop/`. For each entry, `ctx.session.get`; if it throws not-found, remove the key. Otherwise, if the session's latest execution has ended (no running status), treat as a Turn End. Otherwise leave it; the next Turn End event will pick it up.
- **RPC** (ADR-0003): `Rpc.define({ id: "ralph-loop" })` with method `status({ sessionID }) -> { status?: LoopStatus, notify: boolean }` and event `changed { sessionID, status?: LoopStatus }`. `LoopStatus = { iteration, maxIterations, paused, task, promise }`.

### TUI plugin (`Plugin.define({ id: "ralph-loop.tui" })` from `@opencode/plugin/tui`)

- On setup, create the RPC subclient from `context.client.rpc(RalphRpc)`.
- Keep a memory store `Map<sessionID, LoopStatus | undefined>`. Seed it by calling `status` for the viewed session when the slot renders with a new `sessionID`. Follow `changed` events. Re-seed on `session.execution.succeeded` for the viewed session.
- Slot `append: "prompt.footer.status"`. Render nothing when no status. Otherwise render `ralph {iteration}/{maxIterations}` and append ` · paused` when paused.
- Toast on `changed` transitions: none→status is "Ralph Loop started"; status→none is "Ralph Loop stopped" (the server includes `reason` in the `changed` event data so the toast can say why).
- Attention `notify({ message, sound: { name: "done", when: "blurred" }, notification: { when: "blurred" } })` when reason is `completed` or `max-iterations`.
- All toasts and attention gated by `notify` from the status response.

### Cleanup

- Last ticket: add the plugin to `~/.config/opencode/opencode.json` `plugins` by absolute path, then delete `~/.config/opencode/skills/{ralph-loop,cancel-ralph,help}`.

## Testing Decisions

- A good test drives the plugin through its public seam and asserts on observable effects: prompts sent, Notices posted, storage contents, RPC events emitted. It does not inspect internal variables.
- **Seam 1: fake plugin Context.** A test helper builds a `Context` double that records `session.prompt`, `session.synthetic`, `session.get`, `session.context`, `permission.list`, `storage.*`, `command.transform`, `rpc.register`, and exposes a push-based `event.subscribe`. Tests call the real `setup(ctx)`, capture the registered command executors and RPC handlers, then invoke commands and push events. All loop behaviour, stop reasons, Skipped Idle cases, Resume, and Notices are tested here.
- **Seam 2: pure helpers.** `parseLoopArgs(text, defaults)` and `findCompletion(messages, promise)` have direct unit tests covering quoting, unknown flags, clamping, multi-message promises, and case/whitespace tolerance.
- The TUI plugin has no automated tests. It is covered by the manual checklist.
- Prior art: the V1 reference plugin (`charfeng1/opencode-ralph-loop`) has `tests/state.test.ts` and `tests/completion.test.ts` in the same spirit; ours replace file state with the Context double.
- **Manual checklist** (run once before first real use): load via absolute path; confirm `ralph-loop` and `ralph-loop.tui` in `/api/plugin`; `/ralph-loop --max 3 Reply "step N" and stop` continues three times then posts the Max Iterations Notice; a task that ends with the Completion Promise stops with cost delta; `/cancel-ralph` mid-loop; Esc mid-loop; permission prompt pauses the Indicator; restart `opencode service restart` mid-loop and confirm Resume.

## Out of Scope

- Publishing to npm (after one week of local use).
- Compaction hook to inject the Task into summaries.
- Keybinds or palette commands in the TUI.
- Showing Loops from other sessions in the Indicator.
- A `/help` command.
- Multi-Loop per session or parallel Loops across child sessions.
- Migration of the old `.opencode/ralph-loop.local.md` state file.

## Further Notes

- OpenCode 2.0.2 does not emit `session.idle` on the public stream; the schema defines it but the probe never received it. ADR-0004 records the decision to use `session.execution.*`.
- `bun install` in this environment enforces `minimumReleaseAge = 604800`; installing a package released less than seven days ago needs `--minimum-release-age=0`. Document in README.
- The global `opencode.json` is still V1 syntax. V2 normalizes it, so adding a `plugins` array alongside the existing `plugin` array is legal; prefer editing the existing `plugin` array to avoid two competing keys.
