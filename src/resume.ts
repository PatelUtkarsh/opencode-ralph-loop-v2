// Resume: on plugin load, re-attaches to Loops persisted from before a
// service restart when their Loop Session still exists. See spec.md
// "Resume" and CONTEXT.md's "Resume" glossary entry.
import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

const LOOP_STORAGE_PREFIX = "loop/"

/** Narrows an unknown value to the `Session.Info` shape needed to decide
 * whether a session is idle. Anything that does not match is treated as
 * "cannot tell", so the caller falls back to leaving the Loop untouched. */
function isSessionInfo(value: unknown): value is { readonly outcome?: unknown; readonly time?: { readonly updated?: unknown; readonly idle?: unknown } } {
  return typeof value === "object" && value !== null
}

/**
 * Determines whether a session is idle (not currently executing) from the
 * `Session.Info` shape `ctx.session.get` returns. A session is idle when
 * `time.idle` is defined and at least as recent as `time.updated`, or when
 * `outcome` is set (the last execution finished, one way or another).
 * Otherwise the session is treated as busy. This heuristic is unverified
 * against a live restart; ticket 09's manual checklist confirms it.
 */
function isSessionIdle(info: unknown): boolean {
  if (!isSessionInfo(info)) return false
  if (info.outcome !== undefined) return true
  const idle = info.time?.idle
  const updated = info.time?.updated
  if (typeof idle === "number" && typeof updated === "number") return idle >= updated
  return false
}

/**
 * Scans plugin storage for persisted Loops (prefix `loop/`) and re-attaches
 * to each one whose Loop Session still exists: idle sessions are handled as
 * a Turn End via `onTurnEnd`, busy sessions are left for their next live
 * Turn End event, and Loops whose session no longer exists are discarded.
 * Call once from `setup`, after the Turn End subscription has started.
 * Never throws: every per-entry error is caught and logged with a
 * `[ralph-loop]` prefix so one bad entry cannot stop Resume for the rest.
 */
export async function resumeLoops(context: Context, onTurnEnd: (sessionID: string) => Promise<void>): Promise<void> {
  let cursor: string | undefined = undefined

  do {
    let page: { entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>; readonly next?: string }
    try {
      page = await context.storage.scan({ prefix: LOOP_STORAGE_PREFIX, after: cursor })
    } catch (error) {
      console.error("[ralph-loop] Resume storage scan failed", error)
      return
    }

    for (const entry of page.entries) {
      const sessionID = entry.key.slice(LOOP_STORAGE_PREFIX.length)
      try {
        let info: unknown
        try {
          info = await context.session.get({ sessionID })
        } catch {
          await context.storage.remove(entry.key)
          continue
        }

        if (isSessionIdle(info)) {
          await onTurnEnd(sessionID)
        }
      } catch (error) {
        console.error(`[ralph-loop] Resume failed for session ${sessionID}`, error)
      }
    }

    cursor = page.next
  } while (cursor !== undefined)
}
