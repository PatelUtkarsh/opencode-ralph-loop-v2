import { Plugin } from "@opencode/plugin"
import { createCancelLoopCommand, createStartLoopCommand, createStatusCommand } from "./commands.ts"
import { subscribeToTurnEnd } from "./loop.ts"
import { resumeLoops } from "./resume.ts"

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_PROMISE = "DONE"
const DEFAULT_STOP_ON_FAILURE = true

export default Plugin.define({
  id: "ralph-loop",
  async setup(context) {
    const defaults = {
      maxIterations:
        typeof context.options["maxIterations"] === "number" ? context.options["maxIterations"] : DEFAULT_MAX_ITERATIONS,
      promise: typeof context.options["promise"] === "string" ? context.options["promise"] : DEFAULT_PROMISE,
    }
    const stopOnFailure =
      typeof context.options["stopOnFailure"] === "boolean" ? context.options["stopOnFailure"] : DEFAULT_STOP_ON_FAILURE

    await context.command.transform((editor) => {
      editor.add({
        name: "ralph-loop",
        description: "Start a Ralph Loop for this session",
        execute: createStartLoopCommand(context, defaults),
      })
      editor.add({
        name: "cancel-ralph",
        description: "Cancel the active Ralph Loop for this session",
        execute: createCancelLoopCommand(context),
      })
      editor.add({
        name: "ralph-status",
        description: "Show the active Ralph Loop's status for this session",
        execute: createStatusCommand(context),
      })
    })

    const turnEndController = new AbortController()
    const { handleTurnEnd } = subscribeToTurnEnd(context, turnEndController.signal, { stopOnFailure })

    // Resume never throws (see src/resume.ts), so this is fire-and-forget:
    // setup does not need to wait for every Loop Session to be resumed
    // before it returns.
    void resumeLoops(context, handleTurnEnd)

    return () => {
      turnEndController.abort()
    }
  },
})
