# opencode-ralph-loop-v2

> **OpenCode V2 only.** This plugin uses the `@opencode/plugin` V2 API and
> does not load on OpenCode 1.x. For V1, use
> [`charfeng1/opencode-ralph-loop`](https://github.com/charfeng1/opencode-ralph-loop).
> Tested against OpenCode 2.0.2.

An OpenCode V2 plugin that keeps one session working on a Task until the
agent says the work is done. You start a Loop with `/ralph-loop <task>`.
At every Turn End the plugin looks in the transcript for the Completion
Promise. If the promise is not there, the plugin sends a Continuation
Prompt that repeats the Iteration header, the Rules, and the Task word for
word. The Loop stops on a Completion Promise, at Max Iterations, on
`/cancel-ralph`, on an interrupt, on a provider failure, or when the Loop
Session is deleted. Each stop posts a Notice to the transcript, and the
TUI shows an Indicator under the prompt while the Loop runs.

## Requirements

- OpenCode **2.0.0 or later** (`opencode --version`). V1 is not supported.
- [Bun](https://bun.sh) 1.3 or later, for `bun install` and the test suite.

## Install

### From GitHub (recommended)

```sh
# Pinned to a release (recommended)
opencode plugin add "github:PatelUtkarsh/opencode-ralph-loop-v2#v1.0.1"

# Follow main
opencode plugin add github:PatelUtkarsh/opencode-ralph-loop-v2
```

Either form adds the plugin to `~/.config/opencode/opencode.json` and
installs it. A tag stays fixed until you change it; the bare form pins to
the current `main` commit and `opencode plugin update` moves it forward.
Verify with `opencode plugin list`, then restart the TUI so the Indicator
loads.

To move to a newer release, remove the old pin and add the new one:

```sh
opencode plugin remove "github:PatelUtkarsh/opencode-ralph-loop-v2#v1.0.0"
opencode plugin add "github:PatelUtkarsh/opencode-ralph-loop-v2#v1.0.2"
```

Releases are listed at
<https://github.com/PatelUtkarsh/opencode-ralph-loop-v2/releases>.

Release-age filters: OpenCode installs plugin dependencies with the npm
settings on your machine. If `~/.npmrc` has `min-release-age` (or
`~/.bunfig.toml` has `minimumReleaseAge`) and `@opencode/plugin` was
published more recently than that window, the install fails with
`No matching version found for @opencode/plugin@2.0.2 with a date before
...`. Comment the setting out, install, then restore it. The cached package
keeps working afterwards.

### From a local checkout (contributors)

```sh
git clone https://github.com/PatelUtkarsh/opencode-ralph-loop-v2.git
cd opencode-ralph-loop-v2
bun install --minimum-release-age=0
```

Then add the plugin directory to the `plugins` array of an `opencode.json`
or `opencode.jsonc`, in the project or in `~/.config/opencode/`. Do not
load the same plugin from both a package and a local path in one location:
OpenCode rejects the second as `Duplicate plugin ID: ralph-loop`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-ralph-loop-v2"]
}
```

A relative path such as `"./"` or `"../opencode-ralph-loop-v2"`, or a
`file://` URL, works too.

The trap: a bare `"."` does not work. OpenCode reads `"."` as an npm
package name and the load fails. Write `"./"` with the trailing slash, or
give the absolute path (ADR-0005).

If your global config still uses the V1 `plugin` key, append the path to
that same array. Do not add a second `plugins` key next to it. A global
config change takes effect after `opencode service restart`.

About `--minimum-release-age=0`: this repo pins `@opencode/plugin` to the
installed OpenCode version. The flag overrides a `minimumReleaseAge` in your
`bunfig.toml` for one install.

## Commands

| Command | What it does |
| --- | --- |
| `/ralph-loop [--max N] [--promise TEXT] <task>` | Starts a Loop in this session. `--max N` sets Max Iterations for this Loop. `--promise TEXT` sets the Completion Promise text. Quotes group words. Everything after the leading flags is the Task. |
| `/cancel-ralph` | Stops the active Loop in this session and posts a Notice with the Iteration reached. |
| `/ralph-status` | Posts a Notice with the Iteration, the Max Iterations, the paused flag, and the Task. |

Both flags must come before the Task. An unknown leading flag or an empty
Task gives an error Notice and starts no Loop. Starting a Loop in a session
that already has one is refused with a Notice.

## Options

Plugin options go in the object form of a `plugins` entry:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-ralph-loop-v2",
      "options": {
        "maxIterations": 50,
        "promise": "SHIPPED",
        "stopOnFailure": false,
        "notify": false
      }
    }
  ]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `maxIterations` | `100` | Default Max Iterations for a Loop with no `--max`. The Hard Cap is 500: a larger value is clamped and the start Notice says so. |
| `promise` | `DONE` | Default Completion Promise text. The agent must output `<promise>DONE</promise>` to stop the Loop. |
| `stopOnFailure` | `true` | Stops the Loop when a turn fails. Set it to `false` to treat a failed turn as a normal Turn End, so a transient provider error does not end an unattended run. |
| `notify` | `true` | Controls the TUI toasts and the attention notification. Set it to `false` to keep the TUI quiet. The Indicator still updates. |

## How it works

**Turn End.** The plugin subscribes to the event stream and acts on
`session.execution.succeeded`. It ignores `session.idle`, which OpenCode
2.0.2 never emits on the public stream (ADR-0004). It also ignores events
for a session that has no Loop, and events from another directory.

**Continuation Prompt.** When a Turn End does not stop the Loop, the plugin
increments the Iteration and sends a prompt with the header
`[RALPH LOOP - ITERATION i/max]`, the Rules, the exact Completion Promise
to output, and the Task word for word. Repeating the Task means compaction
cannot lose the goal.

**Rules.** The same fixed block goes in the Start Prompt and in every
Continuation Prompt:

```
Rules:
- Only output the Completion Promise when the task is completely and verifiably finished.
- The statement must be true; do not output a false Completion Promise to escape the Loop.
- If blocked, explain the blocker and ask for help instead of guessing.
- `/cancel-ralph` stops the Loop at any time.
```

**Completion Promise.** The plugin reads the assistant messages that come
after the last user or synthetic message and joins their text. A match on
`<promise>TEXT</promise>` stops the Loop. The match tolerates case and
whitespace, and a closing line after the promise does not hide it. A
promise from earlier in the transcript is ignored, so a stray mention
cannot end the Loop.

**Skipped Idle.** The plugin does not send a Continuation Prompt when the
agent is waiting on you: a pending permission, an open question or ask tool
call in the last assistant message, or a user message already queued in the
inbox. The Loop is marked paused, the Iteration does not move, and the next
clean Turn End continues the Loop (ADR-0002).

**Stop Reasons.** `completed`, `max-iterations`, `cancelled`,
`interrupted`, `failed`, and `deleted`. Every reason except `deleted` posts
a Notice. The `completed` and `max-iterations` Notices also report the cost
delta and the token delta for the whole Loop.

**Resume.** Loop state lives in plugin storage under `loop/<sessionID>`
(ADR-0001), so it survives an `opencode service restart`. On load the
plugin scans that prefix. A Loop whose session is gone is dropped. A Loop
whose session is idle gets a Turn End at once. A Loop whose session is busy
is left for its next live Turn End.

**Indicator.** The TUI plugin (`./tui`) shows `ralph 3/100` under the
prompt for the session you are viewing, or `ralph 3/100 · paused` during a
Skipped Idle, and nothing at all for a session with no Loop. It reads the
Loop Status over plugin RPC (ADR-0003), toasts on start and stop, and calls
for attention with the `done` sound when a Loop completes or hits Max
Iterations while the terminal is blurred.

## Development

```sh
bun install --minimum-release-age=0   # see the note above
bun test                              # the full suite
bunx tsc --noEmit                     # strict typecheck, no build step
```

To verify that the plugin loads:

```sh
opencode api get /api/plugin -H "x-opencode-directory:$PWD"
```

Expect one `ralph-loop` entry with `status: "active"` and the `server`,
`tui`, and `rpc` features all true. The TUI plugin is not a separate entry:
`tui: true` is how the server reports that `./tui` resolves, because the
TUI plugin loads in the TUI process.

The root files `index.ts`, `tui.ts`, and `rpc.ts` are one-line re-exports
of the modules under `src/`. They must stay. OpenCode resolves a local
plugin directory by those names and ignores the `exports` map in
`package.json` (ADR-0005).

Two packaging rules that a Git install depends on. OpenCode copies the
repo into its cache and transpiles `src/tui.tsx` there, so `@opentui/core`,
`@opentui/solid`, and `solid-js` must stay regular `dependencies` (not
peers), and `src/tui.tsx` must keep its first-line
`/** @jsxImportSource @opentui/solid */` pragma. Bun reads `tsconfig.json`
from the process cwd, not from the file, so the tsconfig setting is not
seen when OpenCode loads the plugin from its cache. Without the pragma the
TUI plugin fails with `Cannot find package 'react'`.

### Releasing

```sh
# bump "version" in package.json, then:
git commit -am "chore(release): Version X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

Keep `LoopState.directory` optional with its back-fill so stored Loop
state never forces a major version bump.

## Credits

- Anthropic's `ralph-wiggum` skill, the original idea of looping an agent
  on one task until it states the task is done.
- `charfeng1/opencode-ralph-loop`, the OpenCode V1 plugin this one
  replaces. Its file-based state and its tests shaped the design.
- Geoffrey Huntley's write-up at <https://ghuntley.com/ralph>, which named
  the technique.

## Licence

MIT.
