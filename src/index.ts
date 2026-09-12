import { Plugin } from "@opencode/plugin"
import { createStartLoopCommand } from "./commands.ts"
import { subscribeToTurnEnd } from "./loop.ts"

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_PROMISE = "DONE"

export default Plugin.define({
  id: "ralph-loop",
  async setup(context) {
    const defaults = {
      maxIterations:
        typeof context.options["maxIterations"] === "number" ? context.options["maxIterations"] : DEFAULT_MAX_ITERATIONS,
      promise: typeof context.options["promise"] === "string" ? context.options["promise"] : DEFAULT_PROMISE,
    }

    await context.command.transform((editor) => {
      editor.add({
        name: "ralph-loop",
        description: "Start a Ralph Loop for this session",
        execute: createStartLoopCommand(context, defaults),
      })
    })

    const turnEndController = new AbortController()
    subscribeToTurnEnd(context, turnEndController.signal)

    return () => {
      turnEndController.abort()
    }
  },
})
