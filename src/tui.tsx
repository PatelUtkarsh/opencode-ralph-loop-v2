/** @jsxImportSource @opentui/solid */
// The pragma above is load-bearing. Bun reads tsconfig.json relative to the
// process cwd, not this file, so when OpenCode loads this plugin from its
// npm cache the tsconfig's jsxImportSource is not seen and JSX falls back to
// React. The per-file pragma applies everywhere.
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
import { createEffect, onCleanup, Show } from "solid-js"
import { RalphRpc, type LoopStatus, type StopReason } from "./rpc.ts"

/** What the TUI knows about one session. `status` absent means the session has
 * no Loop; the entry itself is absent while the session has never been seeded.
 * `notify` caches the server's `notify` option from the last `status` call and
 * defaults to true until one answers. */
interface SessionEntry {
  readonly status?: LoopStatus
  readonly notify: boolean
  /** True while this entry is only a placeholder, written after a `status`
   * call failed. The TUI does not yet know whether the session has a Loop, so
   * a later `status` that fills it in is not a transition to announce, but a
   * `changed` event arriving first still has a previous entry to compare
   * against and can raise its toast. */
  readonly pending?: true
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
 * client hands back `unknown` and this side has to check it. A declared
 * `invalid_input` failure does not arrive here: the promise client rejects on
 * a declared error, so `refresh`'s `catch` handles that case. */
function isStatusResponse(value: unknown): value is { status?: LoopStatus; notify: boolean } {
  if (!isRecord(value)) return false
  if (typeof value["notify"] !== "boolean") return false
  const status = value["status"]
  // A `status` this client cannot read is not the same as no Loop, so the
  // whole response fails the check and the caller ignores it.
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

/** One-shot guard for the malformed-payload log. A server that emits a shape
 * this client cannot read will emit it on every Loop change, and the TUI must
 * not spill a log line into the terminal on each one. */
let warnedMalformed = false

function warnMalformed(what: string, value: unknown): void {
  if (warnedMalformed) return
  warnedMalformed = true
  console.error(`[ralph-loop.tui] ignoring malformed ${what}; further ones are not logged`, value)
}

/** Narrows a `changed` event payload. Event data is a plain record at the
 * TypeScript boundary for the same JSON Schema reason as above. Returns
 * `undefined` for anything unreadable, including a `status` key this client
 * cannot parse: a status it cannot read is not the same as no Loop, so the
 * caller ignores the event rather than clearing the Indicator. */
function readChangedEvent(data: unknown): { sessionID: string; status?: LoopStatus; reason?: StopReason } | undefined {
  if (!isRecord(data)) return undefined
  const sessionID = data["sessionID"]
  if (typeof sessionID !== "string") return undefined
  const status = data["status"]
  if (status !== undefined && !isLoopStatus(status)) {
    warnMalformed("changed event", data)
    return undefined
  }
  const reason = data["reason"]
  return {
    sessionID,
    ...(status === undefined ? {} : { status }),
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

    // Bumped for a session on every `changed` event. A `status` call captures
    // it before its await and discards its own answer if it moved, so a slow
    // seed cannot overwrite a newer event with a stale Loop Status.
    const revision = new Map<string, number>()

    function revisionOf(sessionID: string): number {
      return revision.get(sessionID) ?? 0
    }

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
      // Captured before the await. Any `changed` event that lands while the
      // call is in flight moves this, and that event is by definition newer
      // than the answer being awaited.
      const before = revisionOf(sessionID)
      let response: unknown
      try {
        response = await rpc.status({ sessionID })
      } catch (error: unknown) {
        // Includes a declared `invalid_input` failure: the promise client
        // rejects on those rather than resolving with them.
        console.error("[ralph-loop.tui] status call failed", error)
        // Let a later render try again, and leave a placeholder entry behind
        // so a `changed` event arriving before that retry still has a
        // previous entry to compare against and can raise its toast.
        seeded.delete(sessionID)
        if (entryFor(sessionID) === undefined) putEntry(sessionID, { notify: true, pending: true })
        return
      }
      if (revisionOf(sessionID) !== before) return
      if (!isStatusResponse(response)) {
        // A shape this client cannot read. Ignore it rather than claim the
        // session has no Loop, and let a later render retry.
        warnMalformed("status response", response)
        seeded.delete(sessionID)
        return
      }
      const existing = entryFor(sessionID)
      // A placeholder from a failed seed counts as "never seeded" here: this
      // response is that seed finally landing, not a Loop starting.
      const previous = existing?.pending === true ? undefined : existing
      const next: SessionEntry = {
        ...(response.status === undefined ? {} : { status: response.status }),
        notify: response.notify,
      }
      // A Loop that is over has no Stop Reason left to report, so a stale one
      // cannot leak into a later stop toast for the same session.
      if (response.status === undefined) lastReason.delete(sessionID)
      putEntry(sessionID, next)
      announceTransition(previous, sessionID, next)
    }

    const stopChanged = rpc.events.on("changed", (event) => {
      const data = readChangedEvent(event.data)
      if (data === undefined) return
      // Before anything else: this event is now the freshest word on the
      // session, so any `status` call still in flight for it must stand down.
      revision.set(data.sessionID, revisionOf(data.sessionID) + 1)
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
      // Once the footer is gone there is no viewed session, so a Turn End
      // must not re-seed the one this component last showed.
      onCleanup(() => {
        viewedSessionID = undefined
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
