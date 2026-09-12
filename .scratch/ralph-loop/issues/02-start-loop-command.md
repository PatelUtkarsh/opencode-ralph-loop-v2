# 02: `/ralph-loop` starts a Loop and sends the Start Prompt

**What to build:** A user types `/ralph-loop --max 30 --promise "TESTS GREEN" Build the API` and sees a start Notice in the transcript, then the agent receives the Task with the Rules and the exact Completion Promise to output. A bad flag or an empty Task produces an error Notice and no Loop. Starting a second Loop in the same session is refused with a Notice.

**Blocked by:** 01 (Scaffold the repo and load an empty plugin)

**Status:** done

- [x] `parseLoopArgs(text, defaults)` pure function: leading `--max <int>` and `--promise <text>`, quotes group words, remainder is the Task; returns an error for unknown leading flags or empty Task
- [x] `--max` above the Hard Cap (500) is clamped and the start Notice says so
- [x] Plugin options `maxIterations` (100) and `promise` (`DONE`) supply defaults
- [x] Command `ralph-loop` registered via `ctx.command.transform`; executor reads `prompt.text` as the argument string
- [x] Loop state persisted at `loop/<sessionID>` with `sessionID, task, promise, iteration: 0, maxIterations, paused: false, startedAt, startCost, startTokens` (cost and tokens from `ctx.session.get`)
- [x] Start Notice posted via `ctx.session.synthetic`; Start Prompt sent via `ctx.session.prompt` with the invocation's `delivery`
- [x] Existing Loop for the session: error Notice, no state change, no prompt
- [x] Unit tests for `parseLoopArgs`; Context-seam tests for start, duplicate, bad flag, clamp

## Comments

Implemented `src/args.ts` (parseLoopArgs), `src/state.ts` (LoopState + storage
helpers), `src/prompts.ts` (Rules block, Start Prompt, Notice builders), and
`src/commands.ts` (createStartLoopCommand), wired from a thin `src/index.ts`.
15 tests pass (`bun test`), `tsc --noEmit` is clean. Extended
`test/fake-context.ts` with optional `options` and `sessionGetResult` seeding
so tests can cover plugin-level defaults and `startCost`/`startTokens`.
Turn End handling, `/cancel-ralph`, and `/ralph-status` are out of scope here
(tickets 03 and 05).
