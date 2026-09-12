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

export interface FakeRpcRegistration {
  readonly definition: unknown
  readonly handlers: Record<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>>
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
}

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

/** Builds a fake plugin `Context` double. See module doc for the casting note. */
export function createFakeContext(): FakeContext {
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
  }
  const commands = new Map<string, FakeCommandDefinition>()
  const rpcRegistrations: FakeRpcRegistration[] = []
  const storage = new Map<string, unknown>()
  const events = createEventSource()

  const editor: FakeCommandEditor = {
    add(definition) {
      commands.set(definition.name, definition)
    },
  }

  const raw = {
    app: { name: "opencode", version: "2.0.2", channel: "stable" },
    location: { directory: "/tmp/ralph-loop-fake", project: { id: "fake-project", directory: "/tmp/ralph-loop-fake", canonical: "/tmp/ralph-loop-fake" } },
    options: {},
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
        return []
      },
    },
    rpc: {
      register: async (definition: unknown, handlers: Record<string, (input: unknown, context: { signal: AbortSignal }) => Promise<unknown>>) => {
        rpcRegistrations.push({ definition, handlers })
        return { dispose: async () => {}, events: { emit: async () => {} } }
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
        return { id: input["sessionID"], cost: 0, tokens: { input: 0, output: 0 } }
      },
      context: async (input: Record<string, unknown>) => {
        calls.sessionContext.push(input)
        return []
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
      scan: async (options: { prefix: string; after?: string; limit?: number }) => {
        calls.storageScan.push(options)
        const entries = [...storage.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value }))
        return { entries }
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
  }
}
