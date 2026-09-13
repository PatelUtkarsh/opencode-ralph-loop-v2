import { Plugin } from "@opencode/plugin"
import { createCancelLoopCommand, createStartLoopCommand, createStatusCommand } from "./commands.ts"
import { subscribeToTurnEnd } from "./loop.ts"
import { RalphRpc } from "./rpc.ts"
import { resumeLoops } from "./resume.ts"
import { readLoopState } from "./state.ts"
import { setStatusEmitter, toLoopStatus } from "./status.ts"

const DEFAULT_MAX_ITERATIONS = 100
const DEFAULT_PROMISE = "DONE"
const DEFAULT_STOP_ON_FAILURE = true
const DEFAULT_NOTIFY = true

/** Narrows the `status` method's input. JSON Schema input arrives as
 * `unknown` at the TypeScript boundary (see the RPC docs, "Input and
 * output"), so a malformed call must be reported as the declared
 * `invalid_input` error rather than crashing the handler on a cast. */
function isStatusInput(value: unknown): value is { sessionID: string } {
  if (typeof value !== "object" || value === null) return false
  return typeof (value as Record<string, unknown>)["sessionID"] === "string"
}

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
    const notify = typeof context.options["notify"] === "boolean" ? context.options["notify"] : DEFAULT_NOTIFY

    // RPC (ADR-0003): `status` reads storage directly; `changed` is emitted
    // by src/loop.ts and src/commands.ts through the setStatusEmitter seam
    // in src/status.ts, so those modules never need a reference to this
    // registration.
    const rpcRegistration = await context.rpc.register(RalphRpc, {
      status: async (input, call) => {
        if (!isStatusInput(input)) {
          return call.error("invalid_input", "status requires a string sessionID", { received: typeof input })
        }
        const { sessionID } = input
        const state = await readLoopState(context, sessionID)
        return { status: state === undefined ? undefined : toLoopStatus(state), notify }
      },
    })
    const disposeStatusEmitter = setStatusEmitter((data) => rpcRegistration.events.emit("changed", data))

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

    return async () => {
      turnEndController.abort()
      disposeStatusEmitter()
      await rpcRegistration.dispose()
    }
  },
})
