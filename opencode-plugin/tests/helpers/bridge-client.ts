import { once } from 'node:events'
import { connect, type Socket } from 'node:net'

export interface RpcErrorFrame {
  code: number
  message: string
  data?: Record<string, unknown>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/**
 * Minimal loopback client standing in for the Agents Anywhere Connector: NDJSON
 * frames over a raw socket, request/response correlation by id, and notification
 * capture. Deliberately independent of the plugin so the wire shape is tested,
 * not the implementation.
 */
export class FakeBridgeClient {
  readonly #socket: Socket
  readonly #pending = new Map<string | number, Pending>()
  readonly #notifications: Array<{ method: string; params: unknown }> = []
  readonly #inbound: Array<Record<string, unknown>> = []
  readonly #closeWaiters: Array<() => void> = []
  #buffer = ''
  #closed = false
  #counter = 0

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string | Buffer) => this.#onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8')))
    socket.on('close', () => this.#markClosed())
    socket.on('error', () => this.#markClosed())
  }

  static async connect(port: number): Promise<FakeBridgeClient> {
    const socket = connect({ host: '127.0.0.1', port })
    await once(socket, 'connect')
    return new FakeBridgeClient(socket)
  }

  get closed(): boolean {
    return this.#closed
  }

  get notifications(): ReadonlyArray<{ method: string; params: unknown }> {
    return this.#notifications
  }

  /** Every frame the bridge sent, in order (used to prove it stays silent). */
  get inboundFrames(): ReadonlyArray<Record<string, unknown>> {
    return this.#inbound
  }

  waitForClose(timeoutMs = 2000): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs)
      this.#closeWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  request(method: string, params?: unknown, timeoutMs = 3000): Promise<unknown> {
    const id = `t-${(this.#counter += 1)}`
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`bridge request timed out: ${method}`))
      }, timeoutMs)
    })
    this.#write({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return promise
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  /** Push a raw JSON-RPC frame (used for malformed-frame and response frames). */
  sendRawFrame(frame: unknown): void {
    this.#write(frame)
  }

  bytes(text: string): void {
    this.#socket.write(text)
  }

  async initialize(params: Record<string, unknown>): Promise<unknown> {
    return this.request('initialize', params)
  }

  static initializeParams(token: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      authToken: token,
      protocolVersion: '1.0',
      runtime: 'opencode',
      connectorId: 'connector-test',
      // rev3 ruling 1: `location` is required for the opencode runtime (the
      // Hub fail-closes the handshake without an absolute directory). Tests
      // override it to exercise cross-location isolation or that fail-closed
      // path.
      location: 'D:/proj/a',
      clientInfo: { name: 'agents-anywhere-connector', version: 'test' },
      ...overrides,
    }
  }

  close(): void {
    this.#socket.destroy()
  }

  #markClosed(): void {
    this.#closed = true
    const waiters = this.#closeWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  #write(frame: unknown): void {
    if (this.#closed) return
    this.#socket.write(`${JSON.stringify(frame)}\n`)
  }

  #onData(chunk: string): void {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length > 0) this.#onFrame(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  #onFrame(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>
    this.#inbound.push(frame)
    const hasMethod = typeof frame['method'] === 'string'
    if (frame['id'] !== undefined && !hasMethod && ('result' in frame || 'error' in frame)) {
      const pending = this.#pending.get(frame['id'] as string | number)
      if (pending) {
        this.#pending.delete(frame['id'] as string | number)
        if ('error' in frame) pending.reject(frame['error'])
        else pending.resolve(frame['result'])
      }
      return
    }
    if (hasMethod) this.#notifications.push({ method: frame['method'] as string, params: frame['params'] })
  }
}

export function expectRpcError(error: unknown): RpcErrorFrame {
  if (error === null || typeof error !== 'object' || typeof (error as RpcErrorFrame).code !== 'number') {
    throw new Error(`expected an RPC error frame, received: ${JSON.stringify(error)}`)
  }
  return error as RpcErrorFrame
}
