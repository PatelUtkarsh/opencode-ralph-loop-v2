import { describe, expect, test } from "bun:test"
import { findCompletion, type TranscriptMessage } from "../src/loop.ts"

function assistant(text: string): TranscriptMessage {
  return { type: "assistant", content: [{ type: "text", text }] }
}

function user(text: string): TranscriptMessage {
  return { type: "user", text }
}

function synthetic(text: string): TranscriptMessage {
  return { type: "synthetic", text }
}

describe("findCompletion", () => {
  test("matches the Completion Promise in the last assistant message", () => {
    const messages: TranscriptMessage[] = [user("Do the thing"), assistant("<promise>DONE</promise>")]

    expect(findCompletion(messages, "DONE")).toBe(true)
  })

  test("tolerates a trailing closing line after the promise", () => {
    const messages: TranscriptMessage[] = [
      user("Do the thing"),
      assistant("Here is my work.\n<promise>DONE</promise>\nAll set!"),
    ]

    expect(findCompletion(messages, "DONE")).toBe(true)
  })

  test("ignores a stray promise that appears before the last user message", () => {
    const messages: TranscriptMessage[] = [
      assistant("<promise>DONE</promise>"),
      user("Do the thing"),
      assistant("Still working on it."),
    ]

    expect(findCompletion(messages, "DONE")).toBe(false)
  })

  test("is case and whitespace tolerant", () => {
    const messages: TranscriptMessage[] = [user("Do the thing"), assistant("<PROMISE>   done   </PROMISE>")]

    expect(findCompletion(messages, "DONE")).toBe(true)
  })

  test("joins text across multiple assistant messages after the last synthetic message", () => {
    const messages: TranscriptMessage[] = [
      synthetic("Ralph Loop started."),
      assistant("Working on it, almost there: <prom"),
      assistant("ise>DONE</promise>"),
    ]

    expect(findCompletion(messages, "DONE")).toBe(true)
  })

  test("returns false when there is no promise at all", () => {
    const messages: TranscriptMessage[] = [user("Do the thing"), assistant("Still working.")]

    expect(findCompletion(messages, "DONE")).toBe(false)
  })

  test("regex-escapes special characters in the promise string", () => {
    const messages: TranscriptMessage[] = [user("Do the thing"), assistant("<promise>a.b(c)</promise>")]

    expect(findCompletion(messages, "a.b(c)")).toBe(true)
    expect(findCompletion(messages, "aXb(c)")).toBe(false)
  })
})
