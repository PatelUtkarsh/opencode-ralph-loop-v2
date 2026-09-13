// The TUI plugin: the Indicator under the prompt, plus the start/stop toasts
// and the attention notification (spec.md "TUI plugin", CONTEXT.md
// "Indicator").
//
// This process cannot read the server plugin's Loop state, so everything here
// comes over the RPC channel from ADR-0003: one `status` call to seed a
// session, then the `changed` event stream to follow it. There are no
// automated tests for this file (spec.md); ticket 08's Comments record the
// manual TUI checklist instead.
import { Plugin } from "@opencode/plugin/tui"
import type { SlotMap } from "@opencode/plugin/tui/context"
import { createEffect, Show } from "solid-js"
import { RalphRpc, type LoopStatus, type StopReason } from "./rpc.ts"

/** What the TUI knows about one session. `status` absent means the session has
 * no Loop; the entry itself is absent while the session has never been seeded.
 * `notify` caches the server's `notify` option from the last `status` call and
 * defaults to true until one answers. */
interface SessionEntry {
  readonly status?: LoopStatus
  readonly notify: boolean
}

interface IndicatorStore {
  readonly entries: Record<string, SessionEntry>
}

/** The Stop Reasons that deserve the `done` sound and a system notification
 * (spec.md user story 33): the Loop ended on its own, so an unattended run has
 * finished. A cancel or an interrupt was the user's own doing. */
const ATTENTION_REASONS: readonly StopReason[] = ["completed", "max-iterations"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isLoopStatus(value: unknown): value is LoopStatus {
  if (!isRecord(value)) return false
  return (
    typeof value["iteration"] === "number" &&
    typeof value["maxIterations"] === "number" &&
    typeof value["paused"] === "boolean" &&
    typeof value["task"] === "string" &&
    typeof value["promise"] === "string"
  )
}

/** Narrows a `status` response. The RPC contract uses JSON Schema, so the
 * client hands back `unknown`; a declared `invalid_input` failure also arrives
 * through this path and fails the check, which the caller treats as "no
 * status" (ticket 08). */
function isStatusResponse(value: unknown): value is { status?: LoopStatus; notify: boolean } {
  if (!isRecord(value)) return false
  if (typeof value["notify"] !== "boolean") return false
  const status = value["status"]
  return status === undefined || isLoopStatus(status)
}

function isStopReason(value: unknown): value is StopReason {
  return (
    value === "completed" ||
    value === "max-iterations" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "deleted"
  )
}

/** Narrows a `changed` event payload. Event data is a plain record at the
 * TypeScript boundary for the same JSON Schema reason as above. */
function readChangedEvent(data: unknown): { sessionID: string; status?: LoopStatus; reason?: StopReason } | undefined {
  if (!isRecord(data)) return undefined
  const sessionID = data["sessionID"]
  if (typeof sessionID !== "string") return undefined
  const status = data["status"]
  const reason = data["reason"]
  return {
    sessionID,
    ...(isLoopStatus(status) ? { status } : {}),
    ...(isStopReason(reason) ? { reason } : {}),
  }
}

/** The Indicator text for a Loop: `ralph 3/100`, plus ` · paused` while the
 * Loop sits on a Skipped Idle (CONTEXT.md "Indicator"). */
function indicatorText(status: LoopStatus): string {
  const base = `ralph ${status.iteration}/${status.maxIterations}`
  return status.paused ? `${base} · paused` : base
}

export default Plugin.define({
  id: "ralph-loop.tui",
  setup(context) {
    const rpc = context.client.rpc(RalphRpc)

    // Memory storage, not durable storage: a Loop Status is only true for as
    // long as the server says so, and it survives a plugin hot reload but
    // must not survive the TUI itself.
    const [store, updateStore] = context.storage.memory<IndicatorStore>("ralph-loop.indicator", {
      initial: { entries: {} },
    })

    // Sessions whose seed call has been started, so a re-render of the same
    // session does not re-issue it. Deliberately not reactive: it gates an
    // effect rather than feeding the render.
    const seeded = new Set<string>()
    let viewedSessionID: string | undefined

    // The Stop Reason from the `changed` event that produced a session's
    // current entry, so the stop toast can name it.
    const lastReason = new Map<string, StopReason>()

    function entryFor(sessionID: string): SessionEntry | undefined {
      return store.entries[sessionID]
    }

    function putEntry(sessionID: string, entry: SessionEntry): void {
      // Always replace the whole entry rather than mutating a field, so a
      // Loop that stops drops its `status` key instead of holding an
      // `undefined` the Solid store would have to special-case.
      updateStore((draft) => {
        draft.entries[sessionID] = entry
      })
    }

    function announceTransition(previous: SessionEntry | undefined, sessionID: string, next: SessionEntry): void {
      // Only a session we already knew about can have a transition. An
      // unseeded session (one the user has never viewed) gets its state
      // recorded silently rather than a toast for a Loop they never saw.
      if (previous === undefined) return
      if (!next.notify) return
      const was = previous.status !== undefined
      const is = next.status !== undefined
      if (!was && is) {
        context.ui.toast.show({ title: "Ralph Loop", message: "Ralph Loop started", variant: "info" })
        return
      }
      if (was && !is) {
        const reason = lastReason.get(sessionID)
        const message = reason === undefined ? "Ralph Loop stopped" : `Ralph Loop stopped: ${reason}`
        context.ui.toast.show({ title: "Ralph Loop", message, variant: "info" })
        if (reason !== undefined && ATTENTION_REASONS.includes(reason)) {
          // Fire and forget: an attention request that fails must not break
          // the Indicator that triggered it.
          void context.attention
            .notify({
              title: "Ralph Loop",
              message,
              notification: { when: "blurred" },
              sound: { name: "done", when: "blurred" },
            })
            .catch((error: unknown) => {
              console.error("[ralph-loop.tui] attention notify failed", error)
            })
        }
      }
    }

    async function refresh(sessionID: string): Promise<void> {
      let response: unknown
      try {
        response = await rpc.status({ sessionID })
      } catch (error: unknown) {
        console.error("[ralph-loop.tui] status call failed", error)
        return
      }
      if (!isStatusResponse(response)) {
        // A declared `invalid_input` failure, or anything else this client
        // does not recognise: treat the session as having no Loop rather
        // than guessing.
        putEntry(sessionID, { notify: entryFor(sessionID)?.notify ?? true })
        return
      }
      const previous = entryFor(sessionID)
      const next: SessionEntry = {
        ...(response.status === undefined ? {} : { status: response.status }),
        notify: response.notify,
      }
      putEntry(sessionID, next)
      announceTransition(previous, sessionID, next)
    }

    const stopChanged = rpc.events.on("changed", (event) => {
      const data = readChangedEvent(event.data)
      if (data === undefined) return
      const previous = entryFor(data.sessionID)
      if (data.reason === undefined) lastReason.delete(data.sessionID)
      else lastReason.set(data.sessionID, data.reason)
      const next: SessionEntry = {
        ...(data.status === undefined ? {} : { status: data.status }),
        notify: previous?.notify ?? true,
      }
      putEntry(data.sessionID, next)
      announceTransition(previous, data.sessionID, next)
    })

    // A Turn End can change the Iteration without the `changed` event
    // reaching this client (a reconnect, say), so re-seed the viewed session
    // from the server whenever its turn ends.
    const stopSucceeded = context.data.on("session.execution.succeeded", (event) => {
      const sessionID = event.data.sessionID
      if (sessionID !== viewedSessionID) return
      void refresh(sessionID)
    })

    function Indicator(props: { readonly input: SlotMap["prompt.footer.status"] }) {
      createEffect(() => {
        const sessionID = props.input.sessionID
        viewedSessionID = sessionID
        if (sessionID === undefined || seeded.has(sessionID)) return
        seeded.add(sessionID)
        void refresh(sessionID)
      })
      const status = () => {
        const sessionID = props.input.sessionID
        return sessionID === undefined ? undefined : store.entries[sessionID]?.status
      }
      // `Show` renders nothing when the session has no Loop, which is exactly
      // the "footer stays quiet" requirement (spec.md user story 31).
      return <Show when={status()}>{(current: () => LoopStatus) => <text>{indicatorText(current())}</text>}</Show>
    }

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <Indicator input={input} />,
    })

    return () => {
      removeSlot()
      stopChanged()
      stopSucceeded()
    }
  },
})
