// Pure argument parsing for `/ralph-loop`. See spec.md "Argument grammar".
//
// Grammar: leading `--max <int>` and `--promise <text>` flags, in any order,
// followed by the Task (the remainder of the text). Double or single quotes
// group words together, both inside a flag value and inside the Task.
// An unknown leading `--flag` or an empty Task is an error. A `--max` above
// the Hard Cap is silently clamped; the caller is told via `clamped` so it
// can post a Notice.

/** The absolute Max Iterations the plugin permits (spec.md "Hard Cap"). */
export const HARD_CAP_MAX_ITERATIONS = 500

export interface LoopArgDefaults {
  readonly maxIterations: number
  readonly promise: string
}

export interface ParsedLoopArgs {
  readonly maxIterations: number
  readonly promise: string
  readonly task: string
  /** True when the requested `--max` exceeded the Hard Cap and was clamped. */
  readonly clamped: boolean
}

export type ParseLoopArgsResult =
  | { readonly ok: true; readonly args: ParsedLoopArgs }
  | { readonly ok: false; readonly error: string }

/** Splits on whitespace, honouring single and double quotes as word groups. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inToken = false
  let quote: '"' | "'" | undefined
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      inToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current)
        current = ""
        inToken = false
      }
      continue
    }
    current += char
    inToken = true
  }
  if (inToken) tokens.push(current)
  return tokens
}

export function parseLoopArgs(text: string, defaults: LoopArgDefaults): ParseLoopArgsResult {
  const tokens = tokenize(text)

  let maxIterations = defaults.maxIterations
  let promise = defaults.promise
  let clamped = false
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break

    if (token === "--max") {
      const value = tokens[index + 1]
      if (value === undefined || !/^\d+$/.test(value)) {
        return { ok: false, error: "--max requires a positive integer argument" }
      }
      const requested = Number.parseInt(value, 10)
      if (requested > HARD_CAP_MAX_ITERATIONS) {
        maxIterations = HARD_CAP_MAX_ITERATIONS
        clamped = true
      } else {
        maxIterations = requested
      }
      index += 2
      continue
    }

    if (token === "--promise") {
      const value = tokens[index + 1]
      if (value === undefined) {
        return { ok: false, error: "--promise requires a text argument" }
      }
      promise = value
      index += 2
      continue
    }

    if (token.startsWith("--")) {
      return { ok: false, error: `Unknown flag: ${token}` }
    }

    break
  }

  const task = tokens.slice(index).join(" ").trim()
  if (task.length === 0) {
    return { ok: false, error: "Task must not be empty" }
  }

  return { ok: true, args: { maxIterations, promise, task, clamped } }
}
