// Test helper: builds a fake plugin Context double for driving `setup(ctx)`
// through its public seam. See spec.md "Seam 1: fake plugin Context".
//
// The real `Context` type (see @opencode/plugin) pulls in dozens of nested
// domains (agent, aisdk, catalog, mcp, vcs, ...) that this plugin never
// touches. Modelling every one of them precisely would fight the type
// system for no test value, so this helper builds only the slice the spec
// names, types it with local interfaces, and performs a single cast to
// `Context` at the boundary where the fake is handed to `setup()`.
import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

/** The event shape the plugin subscribes to. Mirrors `session.execution.*`
 * and friends: a discriminated `type`, optional `data`, optional `location`. */
export interface FakeEvent {
  readonly type: string
  readonly data?: Record<string, unknown>
  readonly location?: { readonly directory: string }
}

export interface FakeCommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: FakeCommandInvocation) => Promise<void>
}

export interface FakeCommandInvocation {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
  readonly delivery: unknown
}

export interface FakeCommandEditor {
  add(definition: FakeCommandDefinition): void
}

/** The second argument the RPC runtime passes to a method handler: a
 * cancellation `signal` and the `error` factory for the errors the method
 * declared in `Rpc.define`. */
export interface FakeRpcCallContext {
  readonly signal: AbortSignal
  readonly error: (type: string, message: string, data?: unknown) => unknown
}

export interface FakeRpcRegistration {
  readonly definition: unknown
  readonly handlers: Record<string, (input: unknown, context: FakeRpcCallContext) => Promise<unknown>>
}

export interface FakeContextCalls {
  readonly sessionPrompt: Array<Record<string, unknown>>
  readonly sessionSynthetic: Array<Record<string, unknown>>
  readonly sessionGet: Array<Record<string, unknown>>
  readonly sessionContext: Array<Record<string, unknown>>
  readonly permissionList: Array<Record<string, unknown>>
  readonly storageGet: string[]
  readonly storageSet: Array<{ key: string; value: unknown }>
  readonly storageRemove: string[]
  readonly storageScan: Array<{ prefix: string; after?: string; limit?: number }>
  /** Every `events.emit(name, data)` call made on an `rpc.register` result,
   * across every registration. `data` is recorded as given; the RPC layer
   * requires it to be an object (see the RPC docs), never a scalar. */
  readonly rpcEmit: Array<{ name: string; data: Record<string, unknown> }>
}

export interface FakeContext {
  /** The Context double, cast to the real type for handing to `setup()`. */
  readonly context: Context
  /** Recorded calls, keyed by the domain method the spec names. */
  readonly calls: FakeContextCalls
  /** Command executors registered via `ctx.command.transform`, by name. */
  readonly commands: Map<string, FakeCommandDefinition>
  /** RPC registrations captured from every `ctx.rpc.register` call. */
  readonly rpcRegistrations: FakeRpcRegistration[]
  /** In-memory storage backing `ctx.storage`, for assertions in tests. */
  readonly storage: Map<string, unknown>
  /** Pushes an event to every active `ctx.event.subscribe` iterator. */
  push(event: FakeEvent): void
  /** Overrides `ctx.session.context` for a test. Use this for behaviour the
   * static `sessionContextResult` seed cannot express, e.g. a response that
   * varies per call, is delayed, or throws. */
  setSessionContext(handler: (input: Record<string, unknown>) => Promise<unknown[]>): void
  /** Overrides `ctx.session.get` for a test. Use this for behaviour the
   * static `sessionGetResult` seed cannot express, e.g. throwing for one
   * sessionID (not found) while returning a busy/idle shape for others. */
  setSessionGet(handler: (input: Record<string, unknown>) => Promise<unknown>): void
  /** Overrides `ctx.permission.list` for a test. Use this for behaviour the
   * static `permissionListResult` seed cannot express, e.g. a pending
   * permission that appears at one Turn End and clears by the next. */
  setPermissionList(handler: (input: Record<string, unknown>) => Promise<unknown[]>): void
  /** Overrides what an `rpc.register` result's `events.emit(name, data)`
   * does after recording the call to `calls.rpcEmit`. Use this to make a
   * `changed` emit fail, synchronously or by rejecting, and assert that the
   * Loop survives it. */
  setRpcEmit(handler: (name: string, data: Record<string, unknown>) => Promise<void>): void
}

/** The `ctx.location.directory` a fake uses when the `location` seed is
 * omitted. Exported so a test's `LoopState` fixture can claim ownership for
 * the default fake without repeating the string (ADR-0006). */
export const FAKE_DIRECTORY = "/tmp/ralph-loop-fake"

interface PendingPull {
  resolve: (result: IteratorResult<FakeEvent>) => void
}

function createEventSource() {
  const iterators = new Set<{ queue: FakeEvent[]; waiter: PendingPull | null; closed: boolean }>()

  function push(event: FakeEvent): void {
    for (const iterator of iterators) {
      if (iterator.closed) continue
      if (iterator.waiter) {
        iterator.waiter.resolve({ value: event, done: false })
        iterator.waiter = null
      } else {
        iterator.queue.push(event)
      }
    }
  }

  function subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<FakeEvent> {
    const state = { queue: [] as FakeEvent[], waiter: null as PendingPull | null, closed: false }
    iterators.add(state)

    const signal = options?.signal
    const close = () => {
      state.closed = true
      iterators.delete(state)
      if (state.waiter) {
        state.waiter.resolve({ value: undefined, done: true })
        state.waiter = null
      }
    }
    if (signal) {
      if (signal.aborted) close()
      else signal.addEventListener("abort", close, { once: true })
    }

    return {
      [Symbol.asyncIterator](): AsyncIterator<FakeEvent> {
        return {
          next(): Promise<IteratorResult<FakeEvent>> {
            if (state.closed) return Promise.resolve({ value: undefined, done: true })
            const queued = state.queue.shift()
            if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
            return new Promise<IteratorResult<FakeEvent>>((resolve) => {
              state.waiter = { resolve }
            })
          },
          return(): Promise<IteratorResult<FakeEvent>> {
            close()
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  return { push, subscribe }
}

export interface FakeContextOptions {
  /** Seeds `ctx.options`, e.g. plugin options like `maxIterations` and `promise`. */
  readonly options?: Record<string, unknown>
  /** Seeds the result `ctx.session.get` returns, keyed by sessionID; falls back to the default. */
  readonly sessionGetResult?: Record<string, unknown>
  /** Seeds the result `ctx.session.context` returns; falls back to an empty array. Tests
   * that need per-call behaviour (e.g. a slow or throwing response) should instead use
   * `setSessionContext` on the returned `FakeContext`. */
  readonly sessionContextResult?: readonly unknown[]
  /** Caps the number of entries `ctx.storage.scan` returns per call, regardless of the
   * caller's requested `limit`, simulating a backend that enforces its own page size.
   * Use this to test cursor pagination (`next`) across more than one call. */
  readonly storageScanPageSize?: number
  /** Seeds the result `ctx.permission.list` returns; falls back to an empty array
   * (no pending permission). */
  readonly permissionListResult?: readonly unknown[]
  /** Seeds `ctx.location`, i.e. the directory this plugin instance is loaded
   * for; falls back to `/tmp/ralph-loop-fake`. Two fakes with different
   * directories model the two plugin instances OpenCode runs when the plugin
   * is loaded from two locations (ADR-0006). */
  readonly location?: { readonly directory: string }
  /** Seeds the `Map` backing `ctx.storage`, so two fakes can be given the
   * same instance and share one storage backend, as the real plugin
   * instances do (ADR-0006). Falls back to a fresh empty `Map`. */
  readonly storage?: Map<string, unknown>
}

/** Builds a fake plugin `Context` double. See module doc for the casting note. */
export function createFakeContext(options?: FakeContextOptions): FakeContext {
  const calls: FakeContextCalls = {
    sessionPrompt: [],
    sessionSynthetic: [],
    sessionGet: [],
    sessionContext: [],
    permissionList: [],
    storageGet: [],
    storageSet: [],
    storageRemove: [],
    storageScan: [],
    rpcEmit: [],
  }
  const commands = new Map<string, FakeCommandDefinition>()
  const rpcRegistrations: FakeRpcRegistration[] = []
  const storage = options?.storage ?? new Map<string, unknown>()
  const events = createEventSource()
  const directory = options?.location?.directory ?? FAKE_DIRECTORY

  const editor: FakeCommandEditor = {
    add(definition) {
      commands.set(definition.name, definition)
    },
  }

  let sessionContextHandler = async (_input: Record<string, unknown>): Promise<unknown[]> => [...(options?.sessionContextResult ?? [])]
  let sessionGetHandler = async (input: Record<string, unknown>): Promise<unknown> =>
    options?.sessionGetResult ?? { id: input["sessionID"], cost: 0, tokens: { input: 0, output: 0 } }
  let permissionListHandler = async (_input: Record<string, unknown>): Promise<unknown[]> => [...(options?.permissionListResult ?? [])]
  let rpcEmitHandler = async (_name: string, _data: Record<string, unknown>): Promise<void> => {}

  const raw = {
    app: { name: "opencode", version: "2.0.2", channel: "stable" },
    location: { directory, project: { id: "fake-project", directory, canonical: directory } },
    options: options?.options ?? {},
    command: {
      transform: async (callback: (input: FakeCommandEditor) => void) => {
        callback(editor)
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: (options?: { readonly signal?: AbortSignal }) => events.subscribe(options),
    },
    permission: {
      list: async (input: Record<string, unknown>) => {
        calls.permissionList.push(input)
        return permissionListHandler(input)
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: Record<string, (input: unknown, context: FakeRpcCallContext) => Promise<unknown>>) => {
        rpcRegistrations.push({ definition, handlers })
        return {
          dispose: async () => {},
          events: {
            emit: async (name: string, data: Record<string, unknown>) => {
              calls.rpcEmit.push({ name, data })
              return rpcEmitHandler(name, data)
            },
          },
        }
      },
    },
    session: {
      prompt: async (input: Record<string, unknown>) => {
        calls.sessionPrompt.push(input)
        return { id: "fake-message-id" }
      },
      synthetic: async (input: Record<string, unknown>) => {
        calls.sessionSynthetic.push(input)
        return { id: "fake-message-id" }
      },
      get: async (input: Record<string, unknown>) => {
        calls.sessionGet.push(input)
        return sessionGetHandler(input)
      },
      context: async (input: Record<string, unknown>) => {
        calls.sessionContext.push(input)
        return sessionContextHandler(input)
      },
    },
    storage: {
      get: async (key: string) => {
        calls.storageGet.push(key)
        return storage.get(key)
      },
      set: async (key: string, value: unknown) => {
        calls.storageSet.push({ key, value })
        storage.set(key, value)
      },
      remove: async (key: string) => {
        calls.storageRemove.push(key)
        storage.delete(key)
      },
      scan: async (scanOptions: { prefix: string; after?: string; limit?: number }) => {
        calls.storageScan.push(scanOptions)
        const matching = [...storage.entries()]
          .filter(([key]) => key.startsWith(scanOptions.prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => ({ key, value }))
        const startIndex = scanOptions.after === undefined ? 0 : matching.findIndex(({ key }) => key === scanOptions.after) + 1
        const requestedLimit = scanOptions.limit ?? matching.length
        const pageSize = options?.storageScanPageSize
        const limit = pageSize === undefined ? requestedLimit : Math.min(requestedLimit, pageSize)
        const page = matching.slice(startIndex, startIndex + limit)
        const next = startIndex + limit < matching.length ? page.at(-1)?.key : undefined
        return { entries: page, next }
      },
    },
  }

  return {
    context: raw as unknown as Context,
    calls,
    commands,
    rpcRegistrations,
    storage,
    push: events.push,
    setSessionContext(handler) {
      sessionContextHandler = handler
    },
    setSessionGet(handler) {
      sessionGetHandler = handler
    },
    setPermissionList(handler) {
      permissionListHandler = handler
    },
    setRpcEmit(handler) {
      rpcEmitHandler = handler
    },
  }
}
