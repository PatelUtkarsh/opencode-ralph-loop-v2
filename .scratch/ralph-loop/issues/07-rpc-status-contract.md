# 07: RPC Loop Status contract and change events

**What to build:** Any OpenCode client can ask the server plugin for the Loop Status of a session and subscribe to changes. This is the channel the TUI Indicator will use.

**Blocked by:** 03 (Turn End continues the Loop or completes it), 04 (Skipped Idle pauses the Loop while the agent waits on the user)

**Status:** ready-for-agent

- [ ] `./rpc` export: `Rpc.define({ id: "ralph-loop" })` with method `status({ sessionID }) -> { status?: LoopStatus, notify: boolean }` and event `changed { sessionID, status?: LoopStatus, reason?: StopReason }`
- [ ] `LoopStatus = { iteration, maxIterations, paused, task, promise }`
- [ ] Server plugin registers the RPC in setup; `status` reads storage; `notify` comes from plugin option `notify` (default true)
- [ ] `changed` emitted on start, every Iteration increment, every pause/unpause, and every stop (with `status` undefined and `reason` set)
- [ ] Context-seam tests: `status` for a session with and without a Loop; `changed` sequence across start, continue, pause, stop
