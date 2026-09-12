# opencode-ralph-loop-v2

An OpenCode V2 plugin that keeps re-prompting one session until the agent
truthfully states that the Task is complete. Start a Loop with
`/ralph-loop <task>`; the plugin re-prompts at every Turn End until the
agent outputs the Completion Promise, Max Iterations is reached, the Loop
is cancelled, or the session ends.

## Install

If your `bunfig.toml` sets `minimumReleaseAge`, `bun install` blocks installing `@opencode/plugin@2.0.2` if it was released
more recently than that. Use:

```sh
bun install --minimum-release-age=0
```

## Load from a local path

Add the plugin directory to `plugins` in an `opencode.json(c)`. Use `./`,
a relative path such as `../opencode-ralph-loop-v2`, an absolute path, or a
`file://` URL. A bare `.` is treated as an npm package name and fails.

```jsonc
{ "plugins": ["/absolute/path/to/opencode-ralph-loop-v2"] }
```

OpenCode resolves `index.ts`, `tui.ts`, and `rpc.ts` at the package root;
they re-export the real modules under `src/`.
