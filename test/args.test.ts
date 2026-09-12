import { describe, expect, test } from "bun:test"
import { HARD_CAP_MAX_ITERATIONS, parseLoopArgs } from "../src/args.ts"

const defaults = { maxIterations: 100, promise: "DONE" }

describe("parseLoopArgs", () => {
  test("parses a Task with no flags", () => {
    const result = parseLoopArgs("Build the API", defaults)

    expect(result).toEqual({
      ok: true,
      args: { maxIterations: 100, promise: "DONE", task: "Build the API", clamped: false },
    })
  })

  test("parses --max and --promise flags with a quoted Task", () => {
    const result = parseLoopArgs('--max 30 --promise "TESTS GREEN" Build the API', defaults)

    expect(result).toEqual({
      ok: true,
      args: { maxIterations: 30, promise: "TESTS GREEN", task: "Build the API", clamped: false },
    })
  })

  test("groups quoted words inside the Task", () => {
    const result = parseLoopArgs('Reply "step one" and stop', defaults)

    expect(result).toEqual({
      ok: true,
      args: { maxIterations: 100, promise: "DONE", task: "Reply step one and stop", clamped: false },
    })
  })

  test("clamps --max above the Hard Cap and reports it", () => {
    const result = parseLoopArgs("--max 9000 Build the API", defaults)

    expect(result).toEqual({
      ok: true,
      args: {
        maxIterations: HARD_CAP_MAX_ITERATIONS,
        promise: "DONE",
        task: "Build the API",
        clamped: true,
      },
    })
  })

  test("errors on an unknown leading flag", () => {
    const result = parseLoopArgs("--bogus Build the API", defaults)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toMatch(/unknown flag/i)
  })

  test("errors on an empty Task", () => {
    const result = parseLoopArgs("--max 10", defaults)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toMatch(/task/i)
  })

  test("errors when --max is not a positive integer", () => {
    const result = parseLoopArgs("--max abc Build the API", defaults)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toMatch(/--max/i)
  })
})
