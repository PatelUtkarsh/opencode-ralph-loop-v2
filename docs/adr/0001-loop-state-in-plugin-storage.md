# Loop state lives in plugin storage, keyed by session

The V1 Ralph Loop plugin and the Anthropic original persist state in a project file (`.opencode/ralph-loop.local.md`) that the agent writes by shell. We store Loop state in `ctx.storage` under `loop/<sessionID>` instead. This gives one Loop per session rather than one per project, removes the need for a `.gitignore` entry, and means only the plugin can start or cancel a Loop (the agent cannot escape by deleting a file). The cost is that state is not human-inspectable from the repo; `/ralph-status` covers that.
