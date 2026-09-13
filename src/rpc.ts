// RPC contract for the Loop Status channel (ADR-0003). Any OpenCode client
// (the TUI Indicator, in ticket 08, or any other) reads a session's Loop
// Status through the `status` method and follows it live through the
// `changed` event. See spec.md "RPC" and CONTEXT.md "Loop Status".
import { Rpc } from "@opencode/plugin/rpc"

/** Why a Loop stopped (spec.md "Stop Reason"). Owned here rather than in
 * `src/loop.ts` so `loop.ts` can import `RalphRpc` (to emit `changed`)
 * without a circular import: `rpc.ts` never imports from `loop.ts`. */
export type StopReason = "completed" | "max-iterations" | "cancelled" | "interrupted" | "failed" | "deleted"

/** The read-only view of one Loop exposed over RPC (CONTEXT.md "Loop
 * Status"). Absent when the session has no Loop. */
export interface LoopStatus {
  readonly iteration: number
  readonly maxIterations: number
  readonly paused: boolean
  readonly task: string
  readonly promise: string
}

const sessionIDInputSchema = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
}

const loopStatusSchema = {
  type: "object",
  // `satisfies` ties the schema's properties to `LoopStatus`, so adding a
  // field to the interface without adding it here is a type error.
  properties: {
    iteration: { type: "integer" },
    maxIterations: { type: "integer" },
    paused: { type: "boolean" },
    task: { type: "string" },
    promise: { type: "string" },
  } satisfies Record<keyof LoopStatus, unknown>,
  required: ["iteration", "maxIterations", "paused", "task", "promise"],
  additionalProperties: false,
}

const stopReasonSchema = {
  type: "string",
  enum: ["completed", "max-iterations", "cancelled", "interrupted", "failed", "deleted"] satisfies StopReason[],
}

/** The shared RPC definition (ADR-0003). One method, `status({ sessionID })
 * -> { status?, notify }`; one event, `changed { sessionID, status?, reason?
 * }`, emitted on start, every Iteration increment, every pause/unpause, and
 * every stop. */
export const RalphRpc = Rpc.define({
  id: "ralph-loop",
  methods: {
    status: {
      input: sessionIDInputSchema,
      output: {
        type: "object",
        properties: {
          status: loopStatusSchema,
          notify: { type: "boolean" },
        },
        required: ["notify"],
        additionalProperties: false,
      },
      // JSON Schema input is `unknown` at the TypeScript boundary, so the
      // handler narrows it itself and reports a malformed call as this
      // declared failure rather than throwing a TypeError at the caller.
      errors: {
        invalid_input: {
          type: "object",
          properties: { received: { type: "string" } },
          required: ["received"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          status: loopStatusSchema,
          reason: stopReasonSchema,
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})
