import type { OpenCodeEvent, OpenCodePluginContext, PermissionEvaluatePayload } from '../../src/server/opencode-ctx.js'

export interface TestEventBus {
  subscribe(type?: string): AsyncIterable<OpenCodeEvent>
  push(event: OpenCodeEvent): void
  close(): void
  readonly receivedSubscriptions: number
}

/** Push-driven async iterable standing in for `ctx.event.subscribe()`. */
export function createTestEventBus(): TestEventBus {
  const queue: OpenCodeEvent[] = []
  let wake: (() => void) | null = null
  let closed = false
  let receivedSubscriptions = 0

  return {
    get receivedSubscriptions() {
      return receivedSubscriptions
    },
    subscribe(): AsyncIterable<OpenCodeEvent> {
      receivedSubscriptions += 1
      return {
        [Symbol.asyncIterator](): AsyncIterator<OpenCodeEvent> {
          return {
            async next(): Promise<IteratorResult<OpenCodeEvent>> {
              while (queue.length === 0 && !closed) {
                await new Promise<void>((resolve) => {
                  wake = resolve
                })
              }
              const value = queue.shift()
              if (value !== undefined) return { value, done: false }
              return { value: undefined, done: true }
            },
          }
        },
      }
    },
    push(event: OpenCodeEvent): void {
      queue.push(event)
      const resolver = wake
      wake = null
      resolver?.()
    },
    close(): void {
      closed = true
      const resolver = wake
      wake = null
      resolver?.()
    },
  }
}

export interface TestCtxOptions {
  directory?: string
  bus?: TestEventBus
  serviceVersion?: string
  permissionHook?: (name: string, callback: (payload: PermissionEvaluatePayload) => unknown) => { dispose?: () => void }
}

export function createTestCtx(options: TestCtxOptions = {}): OpenCodePluginContext {
  const ctx: OpenCodePluginContext = {}
  if (options.directory !== undefined) ctx.location = { directory: options.directory }
  if (options.serviceVersion !== undefined) ctx.app = { version: options.serviceVersion }
  if (options.bus !== undefined) ctx.event = { subscribe: (type?: string) => options.bus!.subscribe(type) }
  if (options.permissionHook !== undefined) {
    ctx.permission = { hook: options.permissionHook }
  }
  return ctx
}

export function sessionEvent(
  type: string,
  sessionID: string,
  directory: string,
  data: Record<string, unknown> = {},
): OpenCodeEvent {
  return {
    id: `${type}:${sessionID}:${Math.random().toString(36).slice(2, 8)}`,
    created: new Date().toISOString(),
    type,
    location: { directory },
    data: { sessionID, ...data },
  }
}
