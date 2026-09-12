// Command executors registered via `ctx.command.transform`.
import type { Plugin } from "@opencode/plugin"
import { parseLoopArgs, type LoopArgDefaults } from "./args.ts"
import {
  buildAlreadyActiveNotice,
  buildArgumentErrorNotice,
  buildNoActiveLoopNotice,
  buildStartNotice,
  buildStartPrompt,
  buildStatusNotice,
} from "./prompts.ts"
import { isSessionCostInfo, stopLoop } from "./loop.ts"
import { readLoopState, writeLoopState, type LoopState } from "./state.ts"

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

    const rawInfo: unknown = await context.session.get({ sessionID })
    const info = isSessionCostInfo(rawInfo) ? rawInfo : { cost: 0, tokens: { input: 0, output: 0 } }

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

/** Builds the `cancel-ralph` command executor: stops an active Loop with
 * reason `cancelled`, or posts a "no active Loop" Notice. */
export function createCancelLoopCommand(context: Context) {
  return async function execute(input: RalphCommandInput): Promise<void> {
    const { sessionID } = input

    const state = await readLoopState(context, sessionID)
    if (state === undefined) {
      await context.session.synthetic({ sessionID, text: buildNoActiveLoopNotice() })
      return
    }

    await stopLoop(context, sessionID, state, "cancelled")
  }
}

/** Builds the `ralph-status` command executor: posts a Notice with the
 * Loop's Iteration, Max Iterations, paused flag, and Task, or a "no active
 * Loop" Notice. */
export function createStatusCommand(context: Context) {
  return async function execute(input: RalphCommandInput): Promise<void> {
    const { sessionID } = input

    const state = await readLoopState(context, sessionID)
    if (state === undefined) {
      await context.session.synthetic({ sessionID, text: buildNoActiveLoopNotice() })
      return
    }

    await context.session.synthetic({
      sessionID,
      text: buildStatusNotice({
        iteration: state.iteration,
        maxIterations: state.maxIterations,
        paused: state.paused,
        task: state.task,
      }),
    })
  }
}
