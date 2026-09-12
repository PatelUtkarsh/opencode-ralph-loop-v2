// Command executors registered via `ctx.command.transform`.
import type { Plugin } from "@opencode/plugin"
import { parseLoopArgs, type LoopArgDefaults } from "./args.ts"
import {
  buildAlreadyActiveNotice,
  buildArgumentErrorNotice,
  buildStartNotice,
  buildStartPrompt,
} from "./prompts.ts"
import { readLoopState, writeLoopState, type LoopState, type LoopTokenUsage } from "./state.ts"

type Context = Plugin.Context

/** The command editor's `add` callback parameter, i.e. `CommandInvocation`. */
type CommandEditor = Parameters<Parameters<Context["command"]["transform"]>[0]>[0]
type CommandDefinition = Parameters<CommandEditor["add"]>[0]
export type RalphCommandInput = Parameters<CommandDefinition["execute"]>[0]

/** Builds the `ralph-loop` command executor: starts a Loop and sends the Start Prompt. */
export function createStartLoopCommand(context: Context, defaults: LoopArgDefaults) {
  return async function execute(input: RalphCommandInput): Promise<void> {
    const { sessionID, prompt, delivery } = input

    const existing = await readLoopState(context, sessionID)
    if (existing !== undefined) {
      await context.session.synthetic({ sessionID, text: buildAlreadyActiveNotice() })
      return
    }

    const parsed = parseLoopArgs(prompt.text, defaults)
    if (!parsed.ok) {
      await context.session.synthetic({ sessionID, text: buildArgumentErrorNotice(parsed.error) })
      return
    }

    const { task, promise, maxIterations, clamped } = parsed.args

    const info = (await context.session.get({ sessionID })) as { cost: number; tokens: LoopTokenUsage }

    const state: LoopState = {
      sessionID,
      task,
      promise,
      iteration: 0,
      maxIterations,
      paused: false,
      startedAt: new Date().toISOString(),
      startCost: info.cost,
      startTokens: info.tokens,
    }
    await writeLoopState(context, state)

    await context.session.synthetic({
      sessionID,
      text: buildStartNotice({ task, maxIterations, promise, clamped }),
    })

    await context.session.prompt({
      sessionID,
      text: buildStartPrompt(task, promise),
      delivery,
    })
  }
}
