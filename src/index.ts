import { Plugin } from "@opencode/plugin"
import { createStartLoopCommand } from "./commands.ts"
import { subscribeToTurnEnd } from "./loop.ts"
import { resumeLoops } from "./resume.ts"

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
    const { handleTurnEnd } = subscribeToTurnEnd(context, turnEndController.signal)

    // Resume never throws (see src/resume.ts), so this is fire-and-forget:
    // setup does not need to wait for every Loop Session to be resumed
    // before it returns.
    void resumeLoops(context, handleTurnEnd)

    return () => {
      turnEndController.abort()
    }
  },
})
