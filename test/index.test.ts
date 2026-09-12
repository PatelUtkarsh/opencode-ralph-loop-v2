import { describe, expect, test } from "bun:test"
import Plugin from "../src/index.ts"
import { createFakeContext } from "./fake-context.ts"

describe("ralph-loop plugin setup", () => {
  test("setup(fakeContext) resolves and its cleanup runs without error", async () => {
    const fake = createFakeContext()

    const cleanup = await Plugin.setup(fake.context)

    expect(typeof cleanup).toBe("function")
    if (typeof cleanup !== "function") throw new Error("unreachable")
    await cleanup()
  })
})
