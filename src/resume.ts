// Resume: on plugin load, re-attaches to Loops persisted from before a
// service restart when their Loop Session still exists. See spec.md
// "Resume" and CONTEXT.md's "Resume" glossary entry.
import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

/** The page shape `ctx.storage.scan` resolves with, taken from the real
 * domain type rather than redeclared. */
type StorageScanPage = Awaited<ReturnType<Context["storage"]["scan"]>>

const LOOP_STORAGE_PREFIX = "loop/"

/** Narrows an unknown value to the `Session.Info` shape needed to decide
 * whether a session is idle. Anything that does not match is treated as
 * "cannot tell", so the caller falls back to leaving the Loop untouched. */
function isSessionInfo(
  value: unknown,
): value is { readonly outcome?: unknown; readonly time?: { readonly updated?: unknown; readonly idle?: unknown } | undefined } {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const time = record["time"]
  return time === undefined || (typeof time === "object" && time !== null)
}

/**
 * Determines whether a thrown `ctx.session.get` error means the session no
 * longer exists, as opposed to a transient failure (network error, timeout,
 * unrelated server error). Only a not-found error should discard the Loop;
 * anything else must leave the storage key alone so a temporary blip does
 * not silently drop a Loop. Checks, in order: an effect-style `_tag` of
 * `SessionNotFoundError`, an HTTP-style `status` of 404, or a `name`/`message`
 * containing "not found" (case-insensitive).
 */
function isSessionNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  if (record["_tag"] === "SessionNotFoundError") return true
  if (record["status"] === 404) return true
  const name = typeof record["name"] === "string" ? record["name"] : ""
  const message = typeof record["message"] === "string" ? record["message"] : ""
  return /not found/i.test(name) || /not found/i.test(message)
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

  for (;;) {
    let page: StorageScanPage
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
        } catch (error) {
          if (isSessionNotFound(error)) {
            await context.storage.remove(entry.key)
          } else {
            console.error(`[ralph-loop] Resume could not read session ${sessionID}; leaving the Loop in place`, error)
          }
          continue
        }

        if (isSessionIdle(info)) {
          await onTurnEnd(sessionID)
        }
      } catch (error) {
        console.error(`[ralph-loop] Resume failed for session ${sessionID}`, error)
      }
    }

    // Stop when the backend signals no more pages, or when it repeats the
    // same cursor (would otherwise loop forever), or when a page came back
    // empty (nothing left to page through).
    if (page.next === undefined || page.next === cursor || page.entries.length === 0) break
    cursor = page.next
  }
}
