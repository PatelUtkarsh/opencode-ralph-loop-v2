# 08: TUI Indicator, toasts, and attention notifications

**What to build:** In the TUI, a user viewing a Loop Session sees `ralph 3/100` under the prompt, or `ralph 3/100 · paused` during a Skipped Idle. Nothing is shown for sessions without a Loop. A toast appears when a Loop starts or stops (with the Stop Reason). When a Loop completes or hits Max Iterations while the terminal is blurred, the `done` sound plays and a system notification appears. `notify: false` silences toasts and attention.

**Blocked by:** 07 (RPC Loop Status contract and change events)

**Status:** ready-for-agent

- [ ] `./tui` export: `Plugin.define({ id: "ralph-loop.tui" })` from `@opencode/plugin/tui`
- [ ] RPC subclient from `context.client.rpc(RalphRpc)`; memory store of `sessionID -> LoopStatus | undefined`
- [ ] Seed on first render for a `sessionID`; follow `changed`; re-seed on `session.execution.succeeded` for the viewed session
- [ ] Slot `append: "prompt.footer.status"` renders the Indicator text or nothing
- [ ] Toasts on start and stop; attention on `completed` and `max-iterations` with `when: "blurred"`
- [ ] Gated by `notify` from the `status` response
- [ ] Manual verification in the TUI (no automated tests); record the steps taken in the ticket comments
