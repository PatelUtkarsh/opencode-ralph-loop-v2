# 09: README, manual checklist, global install, remove old skills

**What to build:** A user can read the README to install and configure the plugin. The full manual checklist has been run once against the real service and passed. The plugin is loaded globally for the user, and the three old shell-based skills are gone so the agent can no longer write the stale state file.

**Blocked by:** 05 (`/cancel-ralph`, `/ralph-status`, and the remaining Stop Reasons), 06 (Resume Loops after a service restart), 08 (TUI Indicator, toasts, and attention notifications)

**Status:** blocked-on-user

- [x] README: what it does, install by absolute path, options (`maxIterations`, `promise`, `stopOnFailure`, `notify`), commands, Completion Promise rules, `--minimum-release-age=0` note, credits
- [x] Manual checklist executed and results recorded under `## Comments`: plugin list shows both ids active; `--max 3` loop hits Max Iterations; promise loop completes with cost delta; `/cancel-ralph`; Esc; permission pause shows `paused`; `opencode service restart` mid-loop resumes
- [x] Plugin added to the user's global `opencode.json` `plugin`/`plugins` array by absolute path
- [ ] `~/.config/opencode/skills/ralph-loop`, `cancel-ralph`, `help` removed
- [ ] `.scratch/ralph-loop/spec.md` status left unchanged; this ticket marked done

## Comments

### Scope of this run

The README, the API-driven half of the manual checklist, and the global
install were done. The TUI half of the checklist (ticket 08's steps 1 to 9:
Indicator text, toasts, attention sound, the `notify: false` gate) and the
removal of the three old skills were deliberately left for the user, who
runs the TUI by hand. Both remaining boxes are unticked and the ticket sits
at `blocked-on-user`.

### Test rig

A scratch project at
`/private/var/folders/95/.../T/opencode/ralph-e2e` with only
`{"$schema":..., "plugins":["/Users/spock/Documents/playground/opencode-ralph-loop-v2"]}`
and a `git init`, driven entirely through `opencode api` with
`-H "x-opencode-directory:<that dir>"`. Sessions used
`cliproxyapi/claude-haiku-4-5-20251001`. The scratch directory and all 22
sessions it created were deleted at the end.

Important: the repo's own `opencode.json` self-load had to be removed for
the duration of the run. See "Two loaded locations run two plugin
instances" below.

### 1. Plugin active, features server / tui / rpc

`opencode api get /api/plugin` for the scratch directory returns exactly
one entry:

```json
{"id":"ralph-loop",
 "source":{"type":"local","path":"/Users/spock/Documents/playground/opencode-ralph-loop-v2/index.ts"},
 "features":{"server":true,"tui":true,"rpc":true},
 "state":{"status":"active"}}
```

Confirms ticket 08's note: there is no separate `ralph-loop.tui` entry.
`tui: true` on the one entry is how the server reports that `./tui`
resolves.

### 2. `--max 2` Loop reaches Max Iterations

Two runs. The first one completed early, because the model output the
Completion Promise at Iteration 2, which is correct behaviour and not a
Max Iterations stop. The second run used
`--max 2 --promise NEVER_EMIT_THIS_TOKEN` with a Task that forbids the
promise, which forces the Max Iterations path. Transcript in order:

```
synthetic  Ralph Loop started. Max Iterations: 2. Completion Promise: <promise>NEVER_EMIT_THIS_TOKEN</promise>.
user       <Start Prompt: Task + Rules + "When the task is complete, output: ...">
assistant  ok
user       [RALPH LOOP - ITERATION 1/2] ...
assistant  <refuses to emit the promise>
user       [RALPH LOOP - ITERATION 2/2] ...
assistant  I am blocked. The original task contains a logical contradiction ...
synthetic  Ralph Loop stopped: reached Max Iterations (2/2).
           Cost delta: +0. Token delta: +16037.
```

Start Notice, Start Prompt, exactly two Continuation Prompts, and the Max
Iterations Notice with both deltas. The cost delta is `+0` because this
provider reports no cost; the token delta is real.

No `loop/` key is left. `/ralph-status` posted after the stop returns:

```
No active Ralph Loop in this session.
```

### 3. Promise Loop completes on the first Turn End

First attempt failed for a reason worth recording: given
`/ralph-loop Reply with exactly this and nothing else: <promise>DONE</promise>`,
the model ignored the Task, ran `glob` and `read` against the empty scratch
repo, and then called the `question` tool to ask what the task was. The
plugin correctly did not re-prompt into an open question, but the
`rpc.status` call at that moment reported `paused: false`, because a
Skipped Idle is only evaluated at a Turn End and an open `question` tool
call means the turn never ended. That is consistent with ADR-0002, and it
also means the Indicator will not show `paused` until the next Turn End.

Second attempt with a Task the model could not mistake for an empty prompt:

```
/ralph-loop Do not use any tools. Do not ask any questions.
            Your entire reply must be exactly this one line: <promise>DONE</promise>
```

```
synthetic  Ralph Loop started. Max Iterations: 100. Completion Promise: <promise>DONE</promise>.
user       <Start Prompt>
assistant  I understand. Ralph Loop is active ... <promise>DONE</promise>
synthetic  Ralph Loop completed after 0 Iterations.
           Cost delta: +0. Token delta: +15388.
```

Stops on the first Turn End, Iteration 0, no Continuation Prompt sent.

### 4. `/cancel-ralph` mid-Loop

`--max 50 --promise NEVER_DONE_TOKEN Count from 1 to 200, one number per turn.`
The Loop ran at roughly one Iteration per second. `rpc.status` mid-Loop:

```json
{"output":{"status":{"iteration":11,"maxIterations":50,"paused":false,
  "task":"Count from 1 to 200, one number per turn. Never output the completion promise.",
  "promise":"NEVER_DONE_TOKEN"},"notify":true}}
```

Then `/cancel-ralph`:

```
synthetic  Ralph Loop cancelled after 11 Iterations.
```

No deltas on this Notice, as designed. The Continuation Prompts stopped at
once.

A first attempt at this check used `--max 50 Count from 1 to 3, one number
per turn` as the ticket suggested, but the model finished counting and
emitted the promise at Iteration 2 before the cancel arrived, so the
Notice was the completion one. A Task that cannot finish is needed to test
cancel reliably.

### 5. Interrupt

`opencode api post /api/session/<id>/interrupt --data '{}'` while a Loop
was waiting on an open `question` tool call returned `{"interrupted":true}`
and produced:

```
synthetic  Ralph Loop interrupted after 0 Iterations.
```

`rpc.status` afterwards reports no Loop.

### 6. RPC over HTTP

The OpenAPI path is right, the request body shape is not obvious. From
`node_modules/@opencode/protocol/dist/groups/rpc.js`, the endpoint is
`POST /api/rpc/:rpcID/:method` with payload schema
`Rpc.Input = { input?: unknown }`, and the response is
`Rpc.Output = { output?: unknown }`. So **the method input must be wrapped
in an `input` key**:

```sh
opencode api post /api/rpc/ralph-loop/status \
  -H "x-opencode-directory:$DIR" \
  --data '{"input":{"sessionID":"ses_..."}}'
```

Observed shapes:

| Call | Result |
| --- | --- |
| active Loop, wrapped body | `200` `{"output":{"status":{"iteration":11,"maxIterations":50,"paused":false,"task":"...","promise":"NEVER_DONE_TOKEN"},"notify":true}}` |
| no Loop, wrapped body | `500` `{"_tag":"RpcInternalError","type":"rpc.invalid_output","message":"Expected object\n  at [\"status\"]"}` |
| unwrapped body `{"sessionID":"..."}` | `400` `{"_tag":"RpcError","type":"rpc.invalid_input","message":"Expected object"}` |
| `{"input":{}}` | `400` `{"_tag":"RpcError","type":"rpc.invalid_input","message":"Missing key\n  at [\"sessionID\"]"}` |
| unknown rpcID | `400` `{"_tag":"RpcError","type":"rpc.unavailable","message":"RPC is unavailable: nope"}` |
| unknown method | `400` `{"_tag":"RpcError","type":"rpc.method_not_found","message":"Unknown RPC method: ralph-loop.nope"}` |

**Bug found, not fixed here (out of scope for this ticket).** The no-Loop
case is meant to be the ordinary answer `{ status: undefined, notify }` and
instead fails output validation with HTTP 500. The handler in
`src/index.ts` returns a literal `status: undefined`, which serialises as a
present `status` key holding JSON `null`, and `loopStatusSchema` rejects
`null`. Two candidate fixes, for whoever picks this up:

- omit the key entirely when there is no Loop (build the object
  conditionally rather than assigning `undefined`), or
- allow `null` in the `status` schema.

The declared `invalid_input` error never fires over HTTP, because the
server validates the input against `sessionIDInputSchema` before the
handler runs and returns the built-in `rpc.invalid_input` first. The
handler's own `isStatusInput` guard is still correct defence, it is just
unreachable through this transport.

Note that the TUI (`src/tui.tsx`) is unaffected in the "no Loop" case only
by luck: it treats a rejected `status` call as "no status", which happens
to be the right answer here. A session that never had a Loop therefore
renders no Indicator, as intended, but for the wrong reason.

### 7. Resume after `opencode service restart`

`--max 40 --promise NEVER_DONE_TOKEN Count slowly from 1 to 200, one number
per turn.` Sequence:

1. Loop started, reached Iteration 2/40.
2. `opencode service restart`.
3. After the restart, `/api/plugin` shows `ralph-loop` active again, and
   `rpc.status` for the same session reports Iteration 13/40, so the Loop
   kept running.
4. The transcript shows an unbroken run of Continuation Prompts through
   Iteration 40 with gaps of about 1 second and nothing larger than 3.2
   seconds, so there was no stall and no second prompt for the same
   Iteration.
5. It ended with
   `Ralph Loop stopped: reached Max Iterations (40/40). Cost delta: +0. Token delta: +25871.`

`grep '\[ralph-loop\]' ~/.local/share/opencode/log/opencode.log` shows no
plugin error from the run.

**The idle heuristic in `src/resume.ts` behaved.** No duplicate Continuation
Prompt, which is what a stale `outcome` on a busy session would have caused,
and no stalled Loop, which is what a wrongly "busy" verdict would have
caused. Honest caveat: the Loop was busy (mid-turn) at the moment of the
restart, so this run exercised the "leave it for the next live Turn End"
branch. The "idle at restart, needs a nudge" branch was not isolated. It is
covered by `test/resume.test.ts` at Seam 1 but is still unverified against a
real restart.

### Two loaded locations run two plugin instances (important)

This cost most of the debugging time, so it is written up in full.

The first checklist runs produced nonsense: a Loop that posted
`Ralph Loop completed after 1 Iteration` and then carried on to Iteration 2
and posted `completed after 2 Iterations`, then
`stopped: reached Max Iterations (2/2)`, three stop Notices for one Loop.
One run reached Iteration 5 and posted the same completion Notice twice.

Cause: the repo's own `opencode.json` has `"plugins": ["./"]`, and the
scratch project's `opencode.json` pointed at the same directory by absolute
path. OpenCode loads a plugin **per location**, so the server was running
two independent `ralph-loop` instances. They share `ctx.storage`, verified
by calling `rpc.status` for the same session from both directories and
getting identical state, and both subscribe to the same global event
stream. `/api/event` is documented as delivering events "across all server
locations".

So both instances saw every Turn End for every session. The directory guard
in `src/loop.ts`

```ts
if (event.location?.directory !== undefined && event.location.directory !== context.location.directory) continue
```

did not stop it. The guard is a no-op whenever the event carries no
`location`, and the observed behaviour says the execution events do not
carry one: the instance loaded at the repo path acted on events for a
session in the scratch directory. The in-memory re-entrancy guard cannot
help either, since each instance has its own `Set`.

Proof by elimination, each step a fresh `--max 2` Loop:

| Repo `plugins` | Scratch `plugins` | Result |
| --- | --- | --- |
| `["./"]` | abs path | duplicate Notices, Loop runs past its own completion |
| removed | abs path | clean single run |
| `["./"]` | removed | clean single run, and `/ralph-loop` in the scratch dir returns `CommandNotFoundError` as expected |

All checklist results above were gathered with the repo entry removed, one
instance loaded. The repo's `opencode.json` was restored afterwards and is
unchanged in git.

This is a real latent bug, not just a test-rig artefact: any user who has
the plugin in their global config and also opens the plugin repo itself
would hit it. It is filed for a follow-up ticket, not fixed here, since
this ticket is documentation and install only. Likely direction: key the
guard on something the events actually carry, or make the Loop ignore a
session whose directory does not match, using `ctx.session.get`'s own
location rather than the event's.

### Part C: global install

`~/.config/opencode/opencode.json` is a symlink to
`/Users/spock/dotfiles/config/opencode/opencode.json`; the edit went
through the symlink, so the dotfiles repo now has the change.

Correction to the spec's "Further Notes" and to this ticket's own wording:
the global config does **not** use a V1 `plugin` array. It already uses
`"plugins"`. The absolute path was appended to that existing array, so
there is still exactly one plugin key:

```json
"plugins": [
  "@ex-machina/opencode-anthropic-auth@next",
  "/Users/spock/Documents/playground/opencode-ralph-loop-v2"
],
```

A config edit alone is not enough; the change only took effect after
`opencode service restart`. After that:

- `/api/plugin` for `/Users/spock` (global config only) lists `ralph-loop`,
  active, features `server`, `tui`, `rpc` all true.
- `/api/plugin` for the plugin repo itself, where the global entry and the
  repo's own `"./"` both resolve to the same directory, lists **exactly one**
  `ralph-loop` entry. The plugin list deduplicates by resolved path.

So the question in the ticket brief is answered: one entry, not two. The
repo's `"plugins": ["./"]` was kept.

Be careful with what that dedup does and does not mean. It is one entry in
one location's list. It does not protect against the two-location problem
above, which is one instance per location, not two in the same list. With
the plugin now in the global config, every location the server loads gets
its own instance, so the duplicate-Notice bug is now reachable in normal
use as soon as two OpenCode projects are open at once. Worth treating the
follow-up ticket as a priority rather than a curiosity.

### Left for the user

1. The TUI checklist, ticket 08's steps 1 to 9. Ticket 08 stays open at
   `blocked-on-09` until those are run.
2. Deleting `~/.config/opencode/skills/{ralph-loop,cancel-ralph,help}`,
   after the TUI checks, so the old shell-based skills do not interfere
   with them.
