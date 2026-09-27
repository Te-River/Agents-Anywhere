/**
 * Bridge Hub — one per OpenCode service process.
 *
 * Listens on `127.0.0.1:0` (random port), speaks NDJSON JSON-RPC 2.0 with a hard
 * 8 MiB frame cap, and publishes a loopback endpoint file for the local
 * Connector to attach to. The hub is a JSON-RPC *server*: it serves the P1
 * read-only surface plus the P3 write surface (`session.createAndStart` /
 * `startTurn` / `interrupt` / `updateSelections` / `respondInteraction`, and a
 * fail-closed `steerTurn`), rejects every unknown method with `-32601`, and
 * itself only ever emits notifications (never requests).
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  BRIDGE_NOTIFICATION_METHODS,
  CAPABILITY_IDS,
  CATALOG_METHOD_LIST,
  CATALOG_METHODS,
  HISTORY_HASH_PATTERN,
  MAX_FRAME_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  RPC_ERROR_DATA,
  RPC_METHODS,
  READ_ONLY_METHODS,
  RUNTIME,
  WRITE_METHODS,
  WRITE_METHOD_LIST,
  platformSessionId,
  protocolMajor,
  type CapabilityWire,
  type DiscoveryState,
  type JsonObject,
} from '../shared/protocol.js'
import { endpointDirectories } from '../shared/endpoint-store.js'
import {
  SESSION_INDEX_FILENAME,
  SessionIndex,
  sessionIndexPath,
} from '../shared/session-index.js'
import { createLogger, type Logger } from '../shared/logger.js'
import {
  evaluateHostVersion,
  type HostVersionGate,
  type HostVersionSource,
} from '../shared/version-gate.js'
import type { Cleanup, OpenCodeEvent, OpenCodePluginContext, SessionApi } from './opencode-ctx.js'
import { readDirectory, readServiceVersion } from './opencode-ctx.js'
import type { AgentApi, ModelApi } from './opencode-ctx.js'
import { isAbsoluteDirectory, normalizeDirectory } from './paths.js'
import { PermissionObserver } from './permission-bridge.js'
import { Projector, type ProjectionNotice, type ProjectionSnapshot, type ProjectionState } from './projector.js'
import { EndpointRegistry } from './registry.js'
import { recordMatchesLocation, SessionRegistry, type SessionRecord } from './session-registry.js'
import { SyncTracker, type SessionChange, type SessionView, type SyncSelection } from './sync.js'

export const HUB_GLOBAL_KEY = 'agents-anywhere.opencode.hub'

export interface HubOptions {
  /**
   * Override the endpoint registry directory (tests pass one temp dir). When
   * unset, production publishes into **both** the shared registry and the
   * spawned Connector's registry (`endpointDirectories`).
   */
  endpointsDirectory?: string
  /**
   * Override the TUI-written session index path. When `endpointsDirectory` is
   * overridden (tests) the index defaults beside it, so a test never reads the
   * user's real `~/.agents-anywhere` index; production leaves both unset.
   */
  sessionIndexPath?: string
  /** Freshness ceiling for the session index (tests shrink it). */
  sessionIndexMaxAgeMs?: number
  host?: '127.0.0.1'
  serviceVersion?: string
  /** Items per `sync.batch` `items` page (tests shrink it to force paging). */
  syncPageItems?: number
  logger?: Logger
}

export interface HubMetrics {
  acceptedEvents: number
  filteredEvents: number
  unattributedEvents: number
  incomingNotifications: number
  handshakeFailures: number
  ignoredResponses: number
  rejectedRequests: number
  connections: number
}

const DEFAULT_HOST = '127.0.0.1'

/** Gate state before any version is known (skipped, recorded as `unknown`). */
const UNKNOWN_VERSION_GATE: HostVersionGate = evaluateHostVersion(undefined)

export class BridgeHub {
  readonly #logger: Logger
  readonly #host: string
  readonly #endpointsDirectory: string | undefined
  readonly #serviceVersion: string | undefined
  /**
   * Host version gate (P6). Re-evaluated on every `install(ctx)` so a hub
   * created without a version can still learn it from a later plugin instance.
   */
  #hostVersion: HostVersionGate = UNKNOWN_VERSION_GATE
  #versionWarned = false
  #versionUnknownLogged = false
  readonly #bridgeId = randomUUID()
  readonly #locations = new Map<string, string>()
  readonly #connections = new Set<BridgeConnection>()
  readonly #sessions: SessionRegistry
  /**
   * TUI-written session index (parent/child linkage). Read fail-soft; when no
   * fresh index is available the Hub reports `parentRelation: "unavailable"`
   * and never filters on a stale one.
   */
  readonly #sessionIndex: SessionIndex
  readonly #projector = new Projector()
  readonly #sync = new SyncTracker()
  readonly #syncPageItems: number
  readonly #permission: PermissionObserver

  /** The host's `ctx.session` write surface, captured on first `install()`. */
  #sessionApi: SessionApi | undefined = undefined

  /** `ctx.agent` / `ctx.model` directory surfaces, captured on first `install()`. */
  #agentApi: AgentApi | undefined = undefined
  #modelApi: ModelApi | undefined = undefined

  /**
   * §6⑤: native session id → connectorId of the connection that claimed it
   * (first claim wins). Populated when a connection materialises/or drives a
   * session, so a notice can be bound to the device that owns it.
   */
  readonly #sessionOwners = new Map<string, string>()

  #server: Server | null = null
  #registry: EndpointRegistry | null = null
  #port = 0
  #token = ''
  #refs = 0
  #bound = false
  #stopped = false
  #metrics = {
    acceptedEvents: 0,
    filteredEvents: 0,
    unattributedEvents: 0,
    incomingNotifications: 0,
    handshakeFailures: 0,
    ignoredResponses: 0,
    rejectedRequests: 0,
    connections: 0,
  }

  constructor(options: HubOptions = {}) {
    this.#logger = options.logger ?? createLogger('bridge-hub')
    this.#host = options.host ?? DEFAULT_HOST
    this.#endpointsDirectory = options.endpointsDirectory
    this.#serviceVersion = options.serviceVersion
    this.#setHostVersion(options.serviceVersion, 'ctx.app.version')
    this.#syncPageItems = options.syncPageItems ?? 500
    this.#sessions = new SessionRegistry({ logger: this.#logger })
    this.#sessionIndex = new SessionIndex({
      path:
        options.sessionIndexPath ??
        (options.endpointsDirectory !== undefined
          ? join(options.endpointsDirectory, SESSION_INDEX_FILENAME)
          : sessionIndexPath()),
      ...(options.sessionIndexMaxAgeMs !== undefined ? { maxAgeMs: options.sessionIndexMaxAgeMs } : {}),
      logger: this.#logger,
    })
    this.#permission = new PermissionObserver(this.#logger, (entry) => {
      // §6 audit: every remote answer, no secrets (token/code never enter here).
      this.#logger.info('remote permission answer', { ...entry })
    })
  }

  get port(): number {
    return this.#port
  }

  get token(): string {
    return this.#token
  }

  get bridgeId(): string {
    return this.#bridgeId
  }

  get endpointPath(): string | null {
    return this.#registry?.path ?? null
  }

  get stopped(): boolean {
    return this.#stopped
  }

  /**
   * Evaluate the host version against the supported range (P6). Warns **once**
   * per hub when the host is out of range — naming the current version, the
   * supported range and the likely consequence — and records once when the
   * version cannot be obtained. It never flips the gate silently.
   */
  #setHostVersion(version: string | undefined, source: HostVersionSource): void {
    this.#hostVersion = evaluateHostVersion(version, source)
    if (this.#hostVersion.supported === false) {
      if (this.#versionWarned) return
      this.#versionWarned = true
      this.#logger.warn(this.#hostVersion.warning ?? 'host version is outside the supported range', {
        hostVersion: this.#hostVersion.version,
        hostVersionSource: this.#hostVersion.source,
        reason: this.#hostVersion.reason,
      })
      return
    }
    if (this.#hostVersion.supported === null && !this.#versionUnknownLogged) {
      this.#versionUnknownLogged = true
      this.#logger.info('宿主 OpenCode 版本获取失败，版本门已跳过（能力不改标，仅记录）', {
        reason: this.#hostVersion.reason,
      })
    }
  }

  get sessions(): SessionRegistry {
    return this.#sessions
  }

  /** Fail-soft TUI session index (parent/child linkage). */
  get sessionIndex(): SessionIndex {
    return this.#sessionIndex
  }

  get projector(): Projector {
    return this.#projector
  }

  get metrics(): HubMetrics {
    return { ...this.#metrics, connections: this.#connections.size }
  }

  async start(): Promise<void> {
    if (this.#server !== null) return
    this.#stopped = false
    const server = createServer((socket) => this.#accept(socket))
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => rejectPromise(error)
      server.once('error', onError)
      server.listen(0, this.#host, () => {
        server.off('error', onError)
        resolvePromise()
      })
    })
    server.on('error', (error) => {
      this.#logger.warn('bridge server error', { error: error.name })
    })
    this.#server = server
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await this.stop()
      throw new Error('bridge server did not bind a TCP port')
    }
    this.#port = address.port
    this.#token = randomBytes(32).toString('base64url')
    this.#registry = new EndpointRegistry({
      directories:
        this.#endpointsDirectory !== undefined ? [this.#endpointsDirectory] : endpointDirectories(),
      pid: process.pid,
      port: this.#port,
      bridgeId: this.#bridgeId,
      token: this.#token,
      ...(this.#serviceVersion !== undefined ? { serviceVersion: this.#serviceVersion } : {}),
      logger: this.#logger,
    })
    await this.#registry.publish([...this.#locations.values()])
    // Load the TUI-written session index once at startup. Fail-soft: a missing
    // or stale index is the normal headless case and simply leaves the parent
    // relation unavailable.
    await this.#sessionIndex.refresh()
    this.#logger.info('bridge hub listening', { port: this.#port, locations: this.#locations.size })
  }

  async stop(): Promise<void> {
    this.#stopped = true
    for (const connection of this.#connections) connection.close()
    this.#connections.clear()
    try {
      await this.#registry?.remove()
    } catch {
      // already logged inside the registry
    }
    this.#registry = null
    const server = this.#server
    this.#server = null
    if (server !== null) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    }
    this.#permission.dispose()
  }

  /**
   * Adopt this hub for a plugin instance. The first call performs the one-time
   * wiring (single full event subscription, one permission hook); every call
   * increments a refcount and returns an idempotent cleanup.
   */
  async install(ctx: OpenCodePluginContext): Promise<Cleanup> {
    if (this.#stopped) throw new Error('bridge hub has been stopped')
    // P6: refresh the host version gate from this instance's context (a hub
    // created without a version, e.g. re-adopted, can still learn it here).
    this.#setHostVersion(readServiceVersion(ctx), 'ctx.app.version')
    const rawDirectory = readDirectory(ctx)
    if (rawDirectory !== null) {
      this.#locations.set(normalizeDirectory(rawDirectory), rawDirectory)
      this.#sessions.allowDirectory(rawDirectory)
    }
    if (!this.#bound) {
      this.#bound = true
      this.#bindContext(ctx)
      // First adoption: pick up any TUI-published index already on disk.
      await this.#sessionIndex.refresh()
    }
    this.#refs += 1
    try {
      await this.#registry?.setLocations([...this.#locations.values()])
    } catch (error) {
      this.#logger.warn('failed to advertise bridge locations', {
        error: error instanceof Error ? error.name : typeof error,
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.#refs -= 1
      if (rawDirectory !== null) {
        this.#locations.delete(normalizeDirectory(rawDirectory))
        this.#sessions.revokeDirectory(rawDirectory)
      }
      if (this.#refs <= 0) return this.stop()
      return undefined
    }
  }

  /**
   * Feed one event through the double filter and, when accepted, the projector.
   * Returns whether the event reached the projection.
   */
  ingest(event: OpenCodeEvent): boolean {
    const decision = this.#sessions.ingest(event)
    if (!decision.accepted) {
      this.#metrics.filteredEvents += 1
      return false
    }
    if (decision.nativeId === null) {
      this.#metrics.unattributedEvents += 1
      return false
    }
    try {
      this.#projector.apply(decision.nativeId, event)
    } catch (error) {
      this.#logger.warn('projection failed', { error: error instanceof Error ? error.name : typeof error })
      return false
    }
    // §6: the approval broker tracks the same accepted permission events the
    // projector turns into notices, so an answer can be validated against them.
    // §6⑤: bind the notice to the device that claimed this session.
    try {
      this.#permission.observe(event, this.#sessionOwners.get(decision.nativeId) ?? null)
    } catch {
      // Approval tracking is fail-soft; it never affects projection.
    }
    this.#metrics.acceptedEvents += 1
    this.#publishSessionChange(decision.nativeId, event)
    return true
  }

  /**
   * Fold an accepted event into the sync tracker and push the resulting
   * `phase:"notifications"` batch to every connection subscribed to this
   * session. Runs even with no subscribers so a later resume is calibrated.
   */
  #publishSessionChange(nativeId: string, event: OpenCodeEvent): void {
    const record = this.#sessions.get(nativeId)
    if (record === undefined) return
    const change = this.#sync.observe(nativeId, event, this.#view(record, nativeId))
    if (
      change.itemIds.length === 0 &&
      change.state === null &&
      change.notices.length === 0 &&
      change.meta === null
    ) {
      return
    }
    for (const connection of this.#connections) {
      const location = connection.location
      if (location === null || !recordMatchesLocation(record, location)) continue
      const sessionId = platformSessionId(connection.namespace, nativeId)
      const streamId = connection.subscriptions.get(sessionId)
      if (streamId === undefined) continue
      this.#pushNotifications(connection, record, sessionId, streamId, change)
    }
  }

  #pushNotifications(
    connection: BridgeConnection,
    record: SessionRecord,
    sessionId: string,
    streamId: string,
    change: SessionChange,
  ): void {
    const notifications: JsonObject[] = []
    if (change.itemIds.length > 0) {
      const wanted = new Set(change.itemIds)
      for (const item of this.#projector.timeline(record.nativeId)) {
        if (!wanted.has(item.id)) continue
        notifications.push({
          method: 'timeline.itemUpsert',
          params: { sessionId, item: { ...item, sessionId } },
        })
      }
    }
    if (change.meta !== null) {
      notifications.push({ method: 'session.meta.upsert', params: this.#metaWire(connection, record) })
    }
    if (change.state !== null) {
      notifications.push({
        method: 'session.state.updated',
        params: this.#stateWire(connection, record, change.state),
      })
    }
    for (const notice of change.notices) {
      notifications.push({
        method: 'notice.upsert',
        params: this.#noticeWire(notice, sessionId),
      })
    }
    this.#sendSyncBatch(connection, {
      sessionId,
      streamId,
      phase: 'notifications',
      notifications,
      throughSeq: change.head.throughSeq,
      diagnostics: { skippedEventCount: change.skippedEventCount },
    })
  }

  #view(record: SessionRecord, nativeId: string): SessionView {
    return {
      items: this.#projector.timeline(nativeId),
      state: this.#projector.state(nativeId),
      // The tracker only diffs ids/status; the sessionId is re-keyed per peer.
      notices: this.#projector.notices(nativeId, ''),
      meta: {
        title: record.title,
        directory: record.directory,
        lastActivityAt: record.lastActivityAt,
      },
      skippedEventCount: this.#projector.skippedEvents(nativeId),
    }
  }

  #bindContext(ctx: OpenCodePluginContext): void {
    const subscribe = ctx?.event?.subscribe
    if (typeof subscribe === 'function') {
      try {
        const stream = subscribe.call(ctx.event)
        if (isAsyncIterable(stream)) {
          // Fire-and-forget: the loop swallows its own errors and never rejects.
          void this.#consume(stream)
        } else {
          this.#logger.warn('event.subscribe returned a non-async-iterable; discovery stays partial(empty)')
        }
      } catch (error) {
        this.#logger.warn('event.subscribe failed; discovery stays partial(empty)', {
          error: error instanceof Error ? error.name : typeof error,
        })
      }
    } else {
      this.#logger.warn('event.subscribe unavailable; discovery stays partial(empty)')
    }
    // The host's session write surface is optional: when absent, the write
    // methods answer fail-closed with UNSUPPORTED_OPERATION.
    this.#sessionApi = ctx?.session
    // Directory surfaces (D3/D4). Also optional; a missing domain keeps its
    // capability row unavailable rather than advertising a catalog that cannot
    // be listed.
    this.#agentApi = ctx?.agent
    this.#modelApi = ctx?.model
    this.#permission.install(ctx)
  }

  async #consume(stream: AsyncIterable<OpenCodeEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.#stopped) break
        try {
          this.ingest(event)
        } catch {
          // Defensive: one bad event never ends the subscription.
        }
      }
    } catch (error) {
      if (!this.#stopped) {
        this.#logger.warn('event stream ended', { error: error instanceof Error ? error.name : typeof error })
      }
    }
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true)
    this.#metrics.connections += 1
    const connection = new BridgeConnection(socket, {
      onMessage: (message) => this.#onMessage(connection, message),
      onError: () => {
        this.#connections.delete(connection)
        socket.destroy()
      },
      onClose: () => {
        this.#connections.delete(connection)
      },
    })
    socket.on('error', () => socket.destroy())
    this.#connections.add(connection)
  }

  #onMessage(connection: BridgeConnection, message: unknown): void {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      sendError(connection, null, RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, 'invalid JSON-RPC frame')
      return
    }
    const frame = message as Record<string, unknown>
    if (frame['jsonrpc'] !== '2.0') {
      sendError(connection, idOrNull(frame), RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, 'jsonrpc must be "2.0"')
      return
    }
    if (typeof frame['method'] === 'string') {
      const id = frame['id']
      if (id === undefined || id === null) {
        this.#onNotification(connection, frame['method'])
      } else if (typeof id === 'string' || typeof id === 'number') {
        this.#onRequest(connection, id, frame['method'], frame['params'])
      } else {
        sendError(connection, null, RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, 'invalid request id')
      }
      return
    }
    if ('result' in frame || 'error' in frame) {
      // The bridge never issues requests, so this is an unsolicited response.
      this.#metrics.ignoredResponses += 1
      return
    }
    sendError(connection, idOrNull(frame), RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, 'not a JSON-RPC request or notification')
  }

  #onNotification(connection: BridgeConnection, method: string): void {
    if (!connection.initialized) return
    // Notifications are accepted but carry no P1 side effect (e.g. runtime.sync.ack).
    this.#metrics.incomingNotifications += 1
    this.#logger.debug('bridge notification received', { method })
  }

  #onRequest(connection: BridgeConnection, id: string | number, method: string, params: unknown): void {
    if (!connection.initialized) {
      if (method !== RPC_METHODS.initialize) {
        this.#metrics.handshakeFailures += 1
        sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.handshakeRequired, 'initialize must be the first frame')
        connection.close()
        return
      }
      this.#initialize(connection, id, params)
      return
    }
    if (method === RPC_METHODS.initialize) {
      sendError(connection, id, RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, 'already initialized')
      return
    }
    if (WRITE_METHOD_LIST.includes(method)) {
      // Write methods await the host (`ctx.session.*` / `ctx.permission.reply`),
      // so they answer asynchronously. Unknown/still-unsupported methods never
      // reach here.
      void this.#dispatchWrite(connection, id, method, params)
      return
    }
    if (CATALOG_METHOD_LIST.includes(method)) {
      // Every catalog row answers asynchronously: `catalog.listAgents` /
      // `catalog.listModels` query the in-process host (`ctx.agent` /
      // `ctx.model`) when present, and a row whose surface is missing fails
      // closed with `UNSUPPORTED_OPERATION` — distinct from an unknown method's
      // `METHOD_NOT_FOUND`, and matching the capability rows that advertise
      // these as unavailable.
      void this.#dispatchCatalog(connection, id, method, params)
      return
    }
    if (!READ_ONLY_METHODS.includes(method)) {
      // Rejects every unknown method — the bridge initiates nothing.
      this.#metrics.rejectedRequests += 1
      sendError(connection, id, RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.methodNotFound, `method not found: ${method}`)
      return
    }
    this.#dispatch(connection, id, method, params)
  }

  #initialize(connection: BridgeConnection, id: string | number, params: unknown): void {
    const values = asObject(params)
    const token = values['authToken']
    if (typeof token !== 'string' || !constantTimeEquals(token, this.#token)) {
      this.#metrics.handshakeFailures += 1
      sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.unauthorized, 'invalid auth token')
      connection.close()
      return
    }
    if (values['runtime'] !== RUNTIME) {
      this.#metrics.handshakeFailures += 1
      sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.runtimeMismatch, 'runtime must be "opencode"')
      connection.close()
      return
    }
    if (protocolMajor(values['protocolVersion']) !== PROTOCOL_MAJOR) {
      this.#metrics.handshakeFailures += 1
      sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.protocolIncompatible, `protocol major must be ${PROTOCOL_MAJOR}`)
      connection.close()
      return
    }
    // rev3 ruling 1: an opencode connection must declare the absolute project
    // location it serves. Missing/empty/relative → error frame + close, so a
    // connection can never accidentally see another location's sessions.
    // (Spec: the upstream live test `test_live_handshake_fails_closed` asserts
    // -32602 INVALID_PARAMS + connection closed for missing/relative location.)
    const rawLocation = firstString(values['location'])
    if (rawLocation === null || !isAbsoluteDirectory(rawLocation)) {
      this.#metrics.handshakeFailures += 1
      sendError(
        connection,
        id,
        RPC_ERROR_CODES.invalidParams,
        RPC_ERROR_DATA.invalidParams,
        'location must be an absolute directory for the opencode runtime',
      )
      connection.close()
      return
    }
    // Mirrors `BridgeClient.session_namespace = session_namespace or connector_id`
    // (connector/runtimes/opencode/bridge/client.py). Both sides MUST change
    // together: this namespace feeds `platformSessionId`, the exact value the
    // Connector derives with `stable_runtime_session_id`.
    const namespace = firstString(values['sessionNamespace']) ?? firstString(values['connectorId']) ?? ''
    connection.initialized = true
    connection.namespace = namespace
    connection.connectorId = firstString(values['connectorId']) ?? ''
    // §6 device identity: the answering identity is the handshake's, never a
    // value a later frame can claim. `clientInfo.userId` is authoritative when
    // the Connector supplies it; otherwise the connectorId identifies the device.
    connection.userId = readClientUserId(values['clientInfo']) ?? connection.connectorId
    connection.location = normalizeDirectory(rawLocation)
    connection.send({
      jsonrpc: '2.0',
      id,
      result: {
        identity: {
          runtime: RUNTIME,
          protocolVersion: PROTOCOL_VERSION,
          runtimeVersion: this.#serviceVersion ?? 'unknown',
          displayName: 'OpenCode',
        },
        features: { syncMode: 'events', readOnly: false },
        capabilities: this.#capabilities(),
      },
    })
  }

  #dispatch(connection: BridgeConnection, id: string | number, method: string, params: unknown): void {
    try {
      const values = asObject(params)
      let result: unknown
      switch (method) {
        case RPC_METHODS.ping:
          result = { ok: true, runtime: RUNTIME, protocolVersion: PROTOCOL_VERSION }
          break
        case RPC_METHODS.runtimeGetCapabilities:
          result = this.#capabilities()
          break
        case RPC_METHODS.sessionList:
          result = this.#sessionList(connection, values)
          break
        case RPC_METHODS.sessionGetSnapshot:
          result = this.#sessionSnapshot(connection, values)
          break
        case RPC_METHODS.sessionGetState:
          result = this.#sessionState(connection, values)
          break
        case RPC_METHODS.sessionGetNotices:
          result = this.#sessionNotices(connection, values)
          break
        case RPC_METHODS.runtimeSyncSubscribe:
          result = this.#syncSubscribe(connection, values)
          break
        case RPC_METHODS.runtimeSyncAck:
          result = this.#syncAck(values)
          break
        default:
          sendError(connection, id, RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.methodNotFound, `method not found: ${method}`)
          return
      }
      connection.send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (error instanceof RpcFault) {
        sendError(connection, id, error.rpcCode, error.dataCode, error.message)
        return
      }
      this.#logger.warn('bridge method failed', { method, error: error instanceof Error ? error.name : typeof error })
      sendError(connection, id, RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.internalError, 'bridge method failed')
    }
  }

  /**
   * Directory surface (D3/D4). Answers asynchronously because a host `list()`
   * may be a promise; a missing surface becomes `UNSUPPORTED_OPERATION`, never
   * an internal error, so the Connector can attribute it correctly.
   */
  async #dispatchCatalog(
    connection: BridgeConnection,
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const values = asObject(params)
      let result: JsonObject
      switch (method) {
        case CATALOG_METHODS.listAgents:
          result = await this.#listAgents(values)
          break
        case CATALOG_METHODS.listModels:
          result = await this.#listModels(values)
          break
        default:
          throw new RpcFault(
            RPC_ERROR_CODES.methodNotFound,
            RPC_ERROR_DATA.unsupportedOperation,
            `method not supported by this runtime: ${method}`,
          )
      }
      connection.send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (error instanceof RpcFault) {
        sendError(connection, id, error.rpcCode, error.dataCode, error.message)
        return
      }
      this.#logger.warn('bridge catalog method failed', {
        method,
        error: error instanceof Error ? error.name : typeof error,
      })
      sendError(connection, id, RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.upstreamError, 'bridge catalog method failed')
    }
  }

  /**
   * `catalog.listAgents` → `{ agents: [{ id, name?, description?, mode, hidden }] }`
   * (`mode ∈ {"primary","subagent","all"}`). Sourced from `ctx.agent.list()` (an
   * object `{ location, data }`) or, when only `transform` exists, from the
   * draft's `list()` inside `ctx.agent.transform(cb)`.
   */
  async #listAgents(values: JsonObject): Promise<JsonObject> {
    void values
    const items = await collectCatalogItems(this.#agentApi)
    if (items === null) {
      throw new RpcFault(
        RPC_ERROR_CODES.methodNotFound,
        RPC_ERROR_DATA.unsupportedOperation,
        'the host exposes no agent catalog (ctx.agent.list/transform)',
      )
    }
    const agents: JsonObject[] = []
    for (const raw of items) {
      const agentId = firstString(raw['id'])
      if (agentId === null) continue
      const name = firstString(raw['name'])
      const description = firstString(raw['description'])
      agents.push({
        id: agentId,
        ...(name !== null ? { name } : {}),
        ...(description !== null ? { description } : {}),
        mode: normalizeAgentMode(raw['mode']),
        // Filtering by `hidden` is unverified on 2.0.18: the flag is passed
        // through verbatim and this catalog never drops an agent because of it.
        hidden: raw['hidden'] === true,
      })
    }
    return { agents }
  }

  /**
   * `catalog.listModels` → the envelope `models.model_catalog` decodes
   * (`{ runtime, revision, models: [{ id, title, ... }] }`). `ctx.model`'s item
   * shape is unverified (A10 probe did not expand it), so fields are read
   * defensively and a title falls back to the id, which the Connector requires.
   */
  async #listModels(values: JsonObject): Promise<JsonObject> {
    void values
    const items = await collectCatalogItems(this.#modelApi)
    if (items === null) {
      throw new RpcFault(
        RPC_ERROR_CODES.methodNotFound,
        RPC_ERROR_DATA.unsupportedOperation,
        'the host exposes no model catalog (ctx.model.list/transform)',
      )
    }
    const models: JsonObject[] = []
    for (const raw of items) {
      const fallbackId = firstString(raw['modelID'])
      const rawId = firstString(raw['id'])
      const name = firstString(raw['name'])
      const modelId = rawId ?? fallbackId ?? name
      if (modelId === null) continue
      const providerId = firstString(raw['providerID'])
      const id = rawId === null && providerId !== null ? `${providerId}/${modelId}` : modelId
      const title = firstString(raw['title']) ?? name ?? id
      const description = firstString(raw['description'])
      models.push({
        id,
        title,
        ...(description !== null ? { description } : {}),
        selectionId: id,
      })
    }
    return { runtime: RUNTIME, revision: 1, models }
  }

  /**
   * Write surface (design §2.3, P3). Answers asynchronously because every method
   * awaits the host. Failures map to the same fault vocabulary as reads, plus
   * `UNSUPPORTED_OPERATION` when the host lacks the API.
   */
  async #dispatchWrite(
    connection: BridgeConnection,
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      const values = asObject(params)
      let result: unknown
      switch (method) {
        case WRITE_METHODS.sessionCreateAndStart:
          result = await this.#createAndStart(connection, values)
          break
        case WRITE_METHODS.sessionStartTurn:
          result = await this.#startTurn(connection, values)
          break
        case WRITE_METHODS.sessionSteerTurn:
          // Design rev2 §2.3: V2 has no native steer → explicit capability error.
          throw new RpcFault(
            RPC_ERROR_CODES.methodNotFound,
            RPC_ERROR_DATA.unsupportedOperation,
            'session.steer is not supported by this runtime',
          )
        case WRITE_METHODS.sessionInterrupt:
          result = await this.#interrupt(connection, values)
          break
        case WRITE_METHODS.sessionUpdateSelections:
          result = await this.#updateSelections(connection, values)
          break
        case WRITE_METHODS.sessionRespondInteraction:
          result = await this.#respondInteraction(connection, values)
          break
        default:
          throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.methodNotFound, `method not found: ${method}`)
      }
      connection.send({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (error instanceof RpcFault) {
        sendError(connection, id, error.rpcCode, error.dataCode, error.message)
        return
      }
      this.#logger.warn('bridge write method failed', {
        method,
        error: error instanceof Error ? error.name : typeof error,
      })
      sendError(connection, id, RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.upstreamError, 'bridge write method failed')
    }
  }

  #sessionWriteApi(): SessionApi {
    const session = this.#sessionApi
    if (session === undefined) {
      throw new RpcFault(
        RPC_ERROR_CODES.methodNotFound,
        RPC_ERROR_DATA.unsupportedOperation,
        'the host exposes no session write surface',
      )
    }
    return session
  }

  async #createAndStart(connection: BridgeConnection, values: JsonObject): Promise<JsonObject> {
    const session = this.#sessionWriteApi()
    // Validate required input before touching the host; the prompt carries it.
    requireString(values['content'], 'content')
    rejectAttachments(values['attachments'])
    const cwd = firstString(values['cwd'])
    const create = session.create
    const prompt = session.prompt
    if (typeof create !== 'function' || typeof prompt !== 'function') {
      throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, 'session.create/prompt unavailable on this host')
    }
    const createOptions: JsonObject = {}
    if (cwd !== null) createOptions['directory'] = cwd
    const created = await create.call(session, createOptions)
    const nativeId = readNativeSessionId(created)
    if (nativeId === null) {
      throw new RpcFault(RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.upstreamError, 'session.create returned no session id')
    }
    // §6⑤: the creating device owns the session it just minted.
    this.#claim(nativeId, connection.connectorId)
    await prompt.call(session, promptOptions(nativeId, values, cwd))
    return {
      ok: true,
      runtime: RUNTIME,
      sessionId: platformSessionId(connection.namespace, nativeId),
      externalSessionId: nativeId,
    }
  }

  async #startTurn(connection: BridgeConnection, values: JsonObject): Promise<JsonObject> {
    const session = this.#sessionWriteApi()
    // Same required input as createAndStart: validate before touching the host.
    requireString(values['content'], 'content')
    rejectAttachments(values['attachments'])
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    // §6⑤: driving the session claims it for this device.
    this.#claim(record.nativeId, connection.connectorId)
    const prompt = session.prompt
    if (typeof prompt !== 'function') {
      throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, 'session.prompt unavailable on this host')
    }
    await prompt.call(session, promptOptions(record.nativeId, values, firstString(values['cwd'])))
    return { ok: true, runtime: RUNTIME, sessionId, externalSessionId: record.nativeId }
  }

  async #interrupt(connection: BridgeConnection, values: JsonObject): Promise<JsonObject> {
    const session = this.#sessionWriteApi()
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    const interrupt = session.interrupt
    if (typeof interrupt !== 'function') {
      throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, 'session.interrupt unavailable on this host')
    }
    const reason = firstString(values['reason'])
    const options: JsonObject = { sessionID: record.nativeId }
    if (reason !== null) options['reason'] = reason
    await interrupt.call(session, options)
    return { ok: true, runtime: RUNTIME, sessionId, externalSessionId: record.nativeId }
  }

  async #updateSelections(connection: BridgeConnection, values: JsonObject): Promise<JsonObject> {
    const session = this.#sessionWriteApi()
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    const selections = asObject(values['selections'])
    const applied: string[] = []
    // Unrecognised keys are reported back instead of silently dropped.
    const ignored: string[] = []
    for (const [key, raw] of Object.entries(selections)) {
      const target = selectionTarget(key)
      if (target === null) {
        ignored.push(key)
        continue
      }
      const selection = typeof raw === 'string' ? raw : null
      const method = session[target]
      if (typeof method !== 'function') {
        throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, `session.${target} unavailable on this host`)
      }
      await method.call(session, { sessionID: record.nativeId, [target === 'switchModel' ? 'model' : 'agent']: selection })
      applied.push(key)
    }
    return { ok: true, runtime: RUNTIME, sessionId, externalSessionId: record.nativeId, applied, ignored }
  }

  async #respondInteraction(connection: BridgeConnection, values: JsonObject): Promise<JsonObject> {
    const sessionId = requireSessionId(values)
    const noticeId = requireString(values['noticeId'], 'noticeId')
    const actionId = requireString(values['actionId'], 'actionId')
    // Resolve first: a session from another location is invisible here, which
    // binds the notice to this connection's device/session (§6 ①⑤).
    const record = this.#resolve(connection, sessionId)
    const outcome = await this.#permission.answer({
      noticeId,
      actionId,
      userId: connection.userId,
      nativeSessionId: record.nativeId,
      // §6⑤: the answering device identity from the handshake, never a later frame.
      connectorId: connection.connectorId,
    })
    if (outcome.ok) {
      return {
        ok: true,
        runtime: RUNTIME,
        sessionId,
        noticeId,
        actionId,
        result: { requestId: outcome.requestId, actionId: outcome.actionId },
      }
    }
    return { ok: false, runtime: RUNTIME, sessionId, noticeId, actionId, code: outcome.code, message: outcome.message }
  }

  #sessionList(connection: BridgeConnection, values: JsonObject): JsonObject {
    const limit = optionalLimit(values['limit']) ?? undefined
    // Pick up TUI index updates without a timer (throttled, fail-soft).
    this.#sessionIndex.maybeRefresh()
    // Child sessions are not listed (user decision: align with the DSH model,
    // where a subagent surfaces inside its parent instead of as its own row).
    // Only a *fresh* index can say which sessions are children; with no usable
    // index nothing is filtered, so a stale file can never hide a session.
    // `limit` is applied *after* filtering, so children cannot consume the page.
    const records = this.#sessions
      .list(undefined, connection.location ?? undefined)
      .filter((record) => !this.#sessionIndex.isChild(record.nativeId))
    const page = limit !== undefined && limit >= 0 ? records.slice(0, limit) : records
    return {
      runtime: RUNTIME,
      partial: this.#sessions.partial,
      sessions: page.map((record) => this.#sessionMeta(connection, record)),
    }
  }

  #sessionMeta(connection: BridgeConnection, record: SessionRecord): JsonObject {
    return {
      sessionId: platformSessionId(connection.namespace, record.nativeId),
      externalSessionId: record.nativeId,
      runtime: RUNTIME,
      ...(record.title !== null ? { title: record.title } : {}),
      ...(record.directory.length > 0 ? { cwd: record.directory } : {}),
      ...(record.lastActivityAt !== null ? { orderingTime: record.lastActivityAt } : {}),
      metadata: { partial: true, discovery: 'event-stream', directory: record.directory },
    }
  }

  #sessionSnapshot(connection: BridgeConnection, values: JsonObject): JsonObject {
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    const snapshot: ProjectionSnapshot | null = this.#projector.snapshot(record.nativeId, sessionId)
    if (snapshot === null) {
      throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.sessionNotFound, 'session has no projected timeline yet')
    }
    return {
      sessionId,
      externalSessionId: record.nativeId,
      runtime: RUNTIME,
      items: snapshot.items,
      watermark: snapshot.watermark,
      snapshotComplete: snapshot.complete,
      metadata: {
        totalItems: snapshot.totalItems,
        partial: true,
        skippedEvents: snapshot.skippedEvents,
        limit: optionalLimit(values['limit']),
      },
    }
  }

  #sessionState(connection: BridgeConnection, values: JsonObject): JsonObject {
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    const state: ProjectionState =
      this.#projector.state(record.nativeId) ?? {
        status: 'idle',
        statusReason: null,
        selections: {},
        error: null,
        openInteractions: 0,
      }
    return {
      sessionId,
      externalSessionId: record.nativeId,
      runtime: RUNTIME,
      status: state.status,
      selections: state.selections,
      ...(state.statusReason !== null ? { statusReason: state.statusReason } : {}),
      ...(state.error !== null ? { error: state.error } : {}),
      metadata: { partial: true, openInteractions: state.openInteractions },
    }
  }

  #sessionNotices(connection: BridgeConnection, values: JsonObject): JsonObject {
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    const notices = this.#projector.notices(record.nativeId, sessionId).map((notice) => this.#noticeWire(notice, sessionId))
    return { runtime: RUNTIME, notices }
  }

  /**
   * Re-key one projected notice onto the peer's platform session id. The
   * projector only knows the native id, so `blocking.targetId` (AA
   * `{scope:'session', targetId}`) is rewritten here to the wire session id.
   */
  #noticeWire(notice: ProjectionNotice, sessionId: string): JsonObject {
    const blocking = notice.blocking
    return {
      ...notice,
      sessionId,
      runtime: RUNTIME,
      blocking:
        blocking !== null && blocking['scope'] === 'session' ? { ...blocking, targetId: sessionId } : blocking,
    }
  }

  /**
   * Open a push-sync calibration (design §2.3 / rev3 ruling 3). The response is
   * the subscription handle; the history itself follows as `sync.batch` frames
   * (begin → items → commit), exactly the page protocol the Connector's
   * `SyncRelay` reassembles.
   */
  #syncSubscribe(connection: BridgeConnection, values: JsonObject): JsonObject {
    const sessionId = requireSessionId(values)
    const record = this.#resolve(connection, sessionId)
    // §6⑤: opening the session stream is how a device claims the session.
    this.#claim(record.nativeId, connection.connectorId)
    const selection: SyncSelection = this.#sync.select(
      record.nativeId,
      optionalSequence(values['fromSeq']),
      historyHashOrNull(values['historyHash']),
    )
    const streamId = randomUUID()
    connection.subscriptions.set(sessionId, streamId)
    const diagnostics = { skippedEventCount: this.#projector.skippedEvents(record.nativeId) }
    const selected = selection.itemIds
    const items =
      selected === null
        ? this.#projector.timeline(record.nativeId)
        : this.#projector.timeline(record.nativeId).filter((item) => selected.includes(item.id))

    this.#sendSyncBatch(connection, {
      sessionId,
      streamId,
      phase: 'begin',
      resume: selection.mode,
      ...(selection.fromSeq !== null ? { fromSeq: selection.fromSeq } : {}),
      throughSeq: selection.throughSeq,
      historyHash: selection.historyHash,
      meta: this.#metaWire(connection, record),
      diagnostics,
    })
    for (let index = 0; index < items.length; index += this.#syncPageItems) {
      const page = items.slice(index, index + this.#syncPageItems)
      this.#sendSyncBatch(connection, {
        sessionId,
        streamId,
        phase: 'items',
        items: page.map((item) => ({ ...item, sessionId })),
      })
    }
    this.#sendSyncBatch(connection, {
      sessionId,
      streamId,
      phase: 'commit',
      // Only a full snapshot is a complete replacement; an incremental resume
      // is a delta the Connector merges (sync.py: complete/snapshotComplete).
      complete: selection.mode === 'snapshot',
      externalSessionId: record.nativeId,
      throughSeq: selection.throughSeq,
      historyHash: selection.historyHash,
      diagnostics,
    })
    return {
      sessionId,
      streamId,
      resume: selection.mode,
      throughSeq: selection.throughSeq,
      historyHash: selection.historyHash,
    }
  }

  /**
   * Checkpoint ack. `throughSeq` is Hub-owned (rev3 §4.1): this only confirms
   * that the Connector's ingest completed, it never moves the value itself.
   * The Connector sends this as a request, so it must be answered.
   */
  #syncAck(values: JsonObject): JsonObject {
    const sessionId = requireSessionId(values)
    const throughSeq = values['throughSeq']
    if (typeof throughSeq !== 'number' || !Number.isInteger(throughSeq) || throughSeq < -1) {
      throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, 'throughSeq is required')
    }
    return { ok: true, sessionId, throughSeq }
  }

  #metaWire(connection: BridgeConnection, record: SessionRecord): JsonObject {
    return {
      sessionId: platformSessionId(connection.namespace, record.nativeId),
      externalSessionId: record.nativeId,
      runtime: RUNTIME,
      ...(record.title !== null ? { title: record.title } : {}),
      ...(record.directory.length > 0 ? { cwd: record.directory } : {}),
      ...(record.lastActivityAt !== null ? { orderingTime: record.lastActivityAt } : {}),
      metadata: { partial: true, discovery: 'event-stream', directory: record.directory },
    }
  }

  #stateWire(
    connection: BridgeConnection,
    record: SessionRecord,
    state: ProjectionState,
  ): JsonObject {
    return {
      sessionId: platformSessionId(connection.namespace, record.nativeId),
      externalSessionId: record.nativeId,
      runtime: RUNTIME,
      status: state.status,
      selections: state.selections,
      ...(state.statusReason !== null ? { statusReason: state.statusReason } : {}),
      ...(state.error !== null ? { error: state.error } : {}),
      metadata: { partial: true, openInteractions: state.openInteractions },
    }
  }

  #sendSyncBatch(connection: BridgeConnection, params: JsonObject): void {
    connection.send({
      jsonrpc: '2.0',
      method: BRIDGE_NOTIFICATION_METHODS.syncBatch,
      params,
    })
  }

  #resolve(connection: BridgeConnection, sessionId: string): SessionRecord {
    const record = this.#sessions.findByPlatformId(
      sessionId,
      connection.namespace,
      connection.location ?? undefined,
    )
    if (record === undefined) {
      throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.sessionNotFound, 'unknown session')
    }
    return record
  }

  /**
   * §6⑤: record the first device to claim a session. First claim wins so a
   * later connection cannot steal a notice already bound to another device.
   */
  #claim(nativeId: string, connectorId: string): void {
    if (connectorId.length === 0) return
    if (!this.#sessionOwners.has(nativeId)) {
      this.#sessionOwners.set(nativeId, connectorId)
      // §6⑤ (R4): notices observed before any claim carry no owner and would be
      // permanently unanswerable. Bind those still-open ones to this claiming
      // device — one-time, exactly like the claim itself.
      this.#permission.bindPending(nativeId, connectorId)
    }
  }

  #capabilities(): JsonObject {
    // `complete` is unreachable (see SessionRegistry#partial): the registry only
    // ever sees the global event stream, so `discoveryState` stays `partial` and
    // is reported as such to the Connector. If a full-reconciliation channel
    // ever lands, the flip must be announced with
    // BRIDGE_NOTIFICATION_METHODS.capabilityUpdated (`runtime.capability.updated`)
    // — never by silently changing this value.
    const discoveryState: DiscoveryState = this.#sessions.partial ? 'partial' : 'complete'
    // The TUI may have published a newer index since the last request; reload on
    // this (throttled) path so the row below reflects the current file state.
    this.#sessionIndex.maybeRefresh()
    // §6: write capabilities are derived from the *real* `install()`-captured
    // host surface, never hardcoded. `ctx.session.*` is unverified on the host
    // (research doc 02), so a missing method must not advertise `supported` —
    // that would enable a write UI whose first click fails.
    const session = this.#sessionApi
    const canCreate = typeof session?.create === 'function'
    const canPrompt = typeof session?.prompt === 'function'
    const canInterrupt = typeof session?.interrupt === 'function'
    // Directory capabilities (D3/D4) are likewise derived from the real host
    // surface: `ctx.agent` / `ctx.model` are unverified on 2.0.18, so a meeting
    // of `list`/`transform` is what advertises the catalog — never a hardcode.
    const canListAgents = hasCatalogSurface(this.#agentApi)
    const canListModels = hasCatalogSurface(this.#modelApi)
    const rows: CapabilityWire[] = [
      capability(CAPABILITY_IDS.sessionList),
      capability(CAPABILITY_IDS.sessionSnapshot),
      capability(CAPABILITY_IDS.sessionState),
      capability(CAPABILITY_IDS.sessionNotices),
      discoveryRow(discoveryState),
      subagentsRow(discoveryState, this.#sessionIndex),
      // P3 write surface: createAndStart/startTurn (session.send_message),
      // interrupt and remote approval — each gated on the probed host surface;
      // steer stays false (no native steer in V2, design rev2 §2.3).
      derived(CAPABILITY_IDS.sessionSendMessage, canCreate && canPrompt, 'host exposes no session.create/prompt'),
      derived(CAPABILITY_IDS.sessionInterrupt, canInterrupt, 'host exposes no session.interrupt'),
      derived(
        CAPABILITY_IDS.sessionInteractionApproval,
        this.#permission.replyAvailable && this.#permission.attached,
        'host exposes no permission.reply / evaluate hook',
      ),
      unavailable(CAPABILITY_IDS.catalogPermission),
      derived(CAPABILITY_IDS.catalogModel, canListModels, 'host exposes no model.list/transform'),
      derived(CAPABILITY_IDS.catalogAgent, canListAgents, 'host exposes no agent.list/transform'),
      unavailable(CAPABILITY_IDS.sessionSteer),
      unavailable(CAPABILITY_IDS.sessionCommands),
      unavailable(CAPABILITY_IDS.runtimeAttachment),
    ]
    const capabilities =
      this.#hostVersion.supported === false ? rows.map((row) => markVersionUnverified(row)) : rows
    return {
      runtime: RUNTIME,
      revision: 1,
      capabilities,
      metadata: {
        readOnly: false,
        syncMode: 'events',
        discoveryState,
        filtered: this.#sessions.filtered,
        // P6 host version gate: always reported, honest about `unknown`.
        hostVersion: this.#hostVersion.version,
        hostVersionSource: this.#hostVersion.source,
        hostVersionSupported: this.#hostVersion.supported,
        ...(this.#hostVersion.reason !== null ? { hostVersionReason: this.#hostVersion.reason } : {}),
      },
    }
  }
}

class RpcFault extends Error {
  readonly rpcCode: number
  readonly dataCode: string

  constructor(rpcCode: number, dataCode: string, message: string) {
    super(message)
    this.rpcCode = rpcCode
    this.dataCode = dataCode
  }
}

interface ConnectionHandlers {
  onMessage: (message: unknown) => void
  onError: () => void
  onClose: () => void
}

/** One NDJSON connection: line framing with an 8 MiB per-frame ceiling. */
class BridgeConnection {
  readonly socket: Socket
  initialized = false
  namespace = ''
  connectorId = ''
  /** Handshake-bound answering identity (§6 ①⑤); never re-read from later frames. */
  userId = ''
  /** Normalised `location` this connection may see (rev3 ruling 1). */
  location: string | null = null
  /** Platform sessionId → live `sync.batch` streamId for this connection. */
  readonly subscriptions = new Map<string, string>()
  readonly #handlers: ConnectionHandlers
  #buffer: Buffer = Buffer.alloc(0)
  #closed = false

  constructor(socket: Socket, handlers: ConnectionHandlers) {
    this.socket = socket
    this.#handlers = handlers
    socket.on('data', (chunk: Buffer) => this.#push(chunk))
    socket.on('close', () => {
      this.#closed = true
      this.#handlers.onClose()
    })
    socket.on('error', () => this.#handlers.onError())
  }

  send(frame: JsonObject): void {
    if (this.#closed || this.socket.destroyed) return
    let encoded: Buffer
    try {
      encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')
    } catch {
      return
    }
    if (encoded.length > MAX_FRAME_BYTES) {
      this.close()
      return
    }
    try {
      this.socket.write(encoded)
    } catch {
      // A dead socket is not an error worth propagating to the plugin.
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.socket.end()
    } catch {
      this.socket.destroy()
    }
  }

  #push(chunk: Buffer): void {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.length > MAX_FRAME_BYTES && this.#buffer.indexOf(0x0a) === -1) {
      // No frame terminator within the ceiling: the peer is violating the cap.
      this.send(errorFrame(null, RPC_ERROR_CODES.parseError, RPC_ERROR_DATA.parseError, 'frame exceeds 8 MiB'))
      this.socket.destroy()
      return
    }
    let index = this.#buffer.indexOf(0x0a)
    while (index !== -1) {
      const line = this.#buffer.subarray(0, index)
      this.#buffer = this.#buffer.subarray(index + 1)
      if (index > MAX_FRAME_BYTES) {
        this.send(errorFrame(null, RPC_ERROR_CODES.parseError, RPC_ERROR_DATA.parseError, 'frame exceeds 8 MiB'))
        this.socket.destroy()
        return
      }
      if (line.length > 0) this.#handleLine(line)
      index = this.#buffer.indexOf(0x0a)
    }
  }

  #handleLine(line: Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch {
      this.send(errorFrame(null, RPC_ERROR_CODES.parseError, RPC_ERROR_DATA.parseError, 'invalid JSON'))
      return
    }
    this.#handlers.onMessage(parsed)
  }
}

function sendError(
  connection: BridgeConnection,
  id: string | number | null,
  code: number,
  dataCode: string,
  message: string,
): void {
  connection.send(errorFrame(id, code, dataCode, message))
}

function errorFrame(id: string | number | null, code: number, dataCode: string, message: string): JsonObject {
  return { jsonrpc: '2.0', id, error: { code, message, data: { code: dataCode, retryable: false } } }
}

function capability(capabilityId: string): CapabilityWire {
  return {
    capabilityId,
    scope: 'runtime',
    runtime: RUNTIME,
    version: '1',
    supported: true,
    available: true,
    allowed: true,
    metadata: {},
  }
}

/**
 * A capability whose support is derived at `install()` time. `probe:'unverified'`
 * records that the host surface itself is not confirmed (research doc 02): the
 * row reflects what `ctx.session` currently exposes, not a guarantee.
 */
function derived(capabilityId: string, ok: boolean, reason: string): CapabilityWire {
  if (ok) {
    return {
      capabilityId,
      scope: 'runtime',
      runtime: RUNTIME,
      version: '1',
      supported: true,
      available: true,
      allowed: true,
      metadata: { probe: 'unverified' },
    }
  }
  return {
    capabilityId,
    scope: 'runtime',
    runtime: RUNTIME,
    version: '1',
    supported: false,
    available: false,
    allowed: false,
    unavailableReason: reason,
    metadata: { probe: 'unverified' },
  }
}

function unavailable(capabilityId: string): CapabilityWire {
  return {
    capabilityId,
    scope: 'runtime',
    runtime: RUNTIME,
    version: '1',
    supported: false,
    available: false,
    allowed: false,
    unavailableReason: 'not implemented by this runtime',
    metadata: {},
  }
}

/**
 * P6: when the host version is out of the supported range the surface may still
 * answer, but we cannot vouch for it. Annotate the row `probe:"unverified"`
 * (same wording as `derived`) and flag the cause — never silently healthy.
 */
function markVersionUnverified(row: CapabilityWire): CapabilityWire {
  return {
    ...row,
    metadata: { ...row.metadata, probe: 'unverified', hostVersionOutOfRange: true },
  }
}

/**
 * `session.discovery` row (rev3 ruling 2). The row stays a normal boolean
 * capability — the Connector's `opencode_capabilities` gates on
 * supported/available/allowed — while the partial/complete state rides
 * `metadata.discoveryState`, never a root `sessionDiscovery` field.
 */
function discoveryRow(state: DiscoveryState): CapabilityWire {
  return {
    capabilityId: CAPABILITY_IDS.sessionDiscovery,
    scope: 'runtime',
    runtime: RUNTIME,
    version: '1',
    supported: true,
    available: true,
    allowed: true,
    metadata: {
      discoveryState: state,
      ...(state === 'partial'
        ? {
            reason:
              'cold-start blind spot: sessions are discovered from the global event stream only',
          }
        : {}),
    },
  }
}

/**
 * `session.subagents` row — honest subagent coverage.
 *
 * Measured (spike 02 §3.1–§3.3): a subagent session's own events reach the
 * global stream with its own `sessionID`, so such a session is discovered and
 * projected exactly like any other — that is the *only* thing the row's
 * `supported:true` claims.
 *
 * The parent/child linkage comes from a **separate, TUI-only channel**: the TUI
 * plugin enumerates sessions through the host SDK client (`api.client`, whose v2
 * `Session` type carries `parentID`) and writes `session-index.json`; the Hub
 * reads that file. The row therefore reports `parentRelation: "supported"` with
 * `parentRelationSource: "tui-session-index"` **only while the index is fresh**,
 * and falls back to `"unavailable"` with a reason when it is missing, corrupt or
 * expired. It never claims more than the channel can back: the runtime's own
 * surface (`session.created` payload, `ctx.session.get`, `/session/{id}/children`)
 * still exposes no parentID, and the TUI channel itself is not yet verified on a
 * real host (A10).
 *
 * `discoveryState` mirrors `session.discovery`: child events are visible only
 * from the subscribe point (no replay).
 */
function subagentsRow(state: DiscoveryState, index: SessionIndex): CapabilityWire {
  const base: Omit<CapabilityWire, 'metadata'> = {
    capabilityId: CAPABILITY_IDS.sessionSubagents,
    scope: 'runtime',
    runtime: RUNTIME,
    version: '1',
    supported: true,
    available: true,
    allowed: true,
  }
  if (index.available) {
    return {
      ...base,
      metadata: {
        // What `supported:true` means: the event layer, not the hierarchy.
        eventVisibility: 'supported',
        parentRelation: 'supported',
        parentRelationSource: 'tui-session-index',
        parentRelationReason:
          'parent/child linkage read from the TUI-written session index (host client api.client.session.list). The TUI channel itself is not yet verified on a real host (A10), so this follows the index only while it is fresh',
        sessionIndexState: index.state,
        sessionIndexUpdatedAt: index.updatedAt,
        discoveryState: state,
        evidence: 'session-index.json (TUI write) + spike 02 §3.1-§3.3, §4',
      },
    }
  }
  return {
    ...base,
    metadata: {
      eventVisibility: 'supported',
      parentRelation: 'unavailable',
      parentRelationReason: `no usable TUI session index (state=${index.state}): the runtime exposes no parentID (session.created payload has no info field, ctx.session.get has no parentID/children, and /session/{id}/children is 404 on this build), and the TUI channel has not published a fresh index`,
      sessionIndexState: index.state,
      discoveryState: state,
      evidence: 'spike 02 §3.1-§3.3, §4',
    },
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function idOrNull(frame: Record<string, unknown>): string | number | null {
  const id = frame['id']
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Agent `mode` vocabulary from the published `AgentV2Info` type. */
export type AgentMode = 'primary' | 'subagent' | 'all'

/**
 * Normalize an agent's `mode`. An unknown/absent value becomes `"all"`, which
 * callers treat as switchable — never silently dropped from the directory.
 */
export function normalizeAgentMode(value: unknown): AgentMode {
  return value === 'primary' || value === 'subagent' || value === 'all' ? value : 'all'
}

/** Does the host domain expose a way to enumerate its catalog? */
export function hasCatalogSurface(api: AgentApi | ModelApi | undefined): boolean {
  return typeof api?.list === 'function' || typeof api?.transform === 'function'
}

/**
 * Collect catalog items from `ctx.<domain>`, tolerating all three observed
 * shapes: a bare array, a `{ data: [] }` envelope (the A10-measured
 * `ctx.agent.list()` shape), or a `transform(cb)` draft with a `list()` method.
 * Returns `null` when the host exposes neither surface (→ UNSUPPORTED).
 */
export async function collectCatalogItems(
  api: AgentApi | ModelApi | undefined,
): Promise<JsonObject[] | null> {
  if (api === undefined) return null
  if (typeof api.list === 'function') {
    const items = readCatalogItems(await api.list.call(api))
    if (items !== null) return items
  }
  if (typeof api.transform === 'function') {
    const holder: { items: JsonObject[] | null } = { items: null }
    await api.transform.call(api, (draft: unknown) => {
      const list = asObject(draft)['list']
      if (typeof list === 'function') {
        const items = readCatalogItems((list as () => unknown).call(draft))
        if (items !== null) holder.items = items
      }
    })
    if (holder.items !== null) return holder.items
  }
  return null
}

function readCatalogItems(snapshot: unknown): JsonObject[] | null {
  if (Array.isArray(snapshot)) return snapshot.filter(isJsonObject)
  if (snapshot !== null && typeof snapshot === 'object') {
    const data = (snapshot as JsonObject)['data']
    if (Array.isArray(data)) return data.filter(isJsonObject)
  }
  return null
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** `fromSeq`: a known durable sequence, or `null` (treated as absent). */
function optionalSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** A malformed/absent `historyHash` degrades to a full snapshot (rev3 ruling 3). */
function historyHashOrNull(value: unknown): string | null {
  return typeof value === 'string' && HISTORY_HASH_PATTERN.test(value) ? value : null
}

function requireSessionId(values: JsonObject): string {
  const sessionId = firstString(values['sessionId'])
  if (sessionId === null) {
    throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, 'sessionId is required')
  }
  return sessionId
}

/**
 * The Hub advertises `runtime.attachment` as unavailable (P3 scope) and the
 * Connector refuses attachments too — this keeps the two ends consistent: a
 * non-empty attachment list is refused loudly, never silently dropped.
 */
function rejectAttachments(value: unknown): void {
  if (Array.isArray(value) && value.length > 0) {
    throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, 'attachments are not supported by this runtime')
  }
}

function requireString(value: unknown, label: string): string {
  const text = firstString(value)
  if (text === null) {
    throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, `${label} is required`)
  }
  return text
}

/** The `ctx.session.prompt` options object (session method shapes are unverified; see opencode-ctx). */
function promptOptions(nativeId: string, values: JsonObject, cwd: string | null): JsonObject {
  const options: JsonObject = { sessionID: nativeId }
  if (typeof values['content'] === 'string') options['content'] = values['content']
  if (values['selections'] !== undefined) options['selections'] = asObject(values['selections'])
  // `attachments` are never forwarded: non-empty ones are refused up front
  // (`rejectAttachments`), so the Hub never silently drops them at the host.
  const clientMessageId = firstString(values['clientMessageId'])
  if (clientMessageId !== null) options['clientMessageId'] = clientMessageId
  if (cwd !== null) options['cwd'] = cwd
  return options
}

/** `ctx.session.create` returns `{id}` (SDK style); accept a bare string too. */
function readNativeSessionId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return firstString(record['id']) ?? firstString(record['sessionID']) ?? firstString(record['sessionId'])
  }
  return null
}

const MODEL_SELECTION_KEYS: ReadonlySet<string> = new Set(['model', 'modelId', 'modelID'])
const AGENT_SELECTION_KEYS: ReadonlySet<string> = new Set(['agent', 'agentId', 'agentID'])

function selectionTarget(key: string): 'switchModel' | 'switchAgent' | null {
  if (MODEL_SELECTION_KEYS.has(key)) return 'switchModel'
  if (AGENT_SELECTION_KEYS.has(key)) return 'switchAgent'
  return null
}

/** `clientInfo.userId` from the initialize handshake (§6 device identity). */
function readClientUserId(clientInfo: unknown): string | null {
  if (clientInfo === null || typeof clientInfo !== 'object' || Array.isArray(clientInfo)) return null
  const record = clientInfo as Record<string, unknown>
  return firstString(record['userId']) ?? firstString(record['user']) ?? firstString(record['id'])
}

function isAsyncIterable(value: unknown): value is AsyncIterable<OpenCodeEvent> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AsyncIterable<OpenCodeEvent>)[Symbol.asyncIterator] === 'function'
  )
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) {
    // Compare equal-length buffers anyway so length is not leaked by timing.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

const NOOP_CLEANUP: Cleanup = () => undefined

/**
 * Entry point used by `server/index.ts`. Adopts an existing hub when a previous
 * `setup()` already started one (hot reload / second location), so the listener,
 * the event subscription and the permission hook are created exactly once.
 */
export async function installPlugin(ctx: OpenCodePluginContext): Promise<Cleanup> {
  const key = Symbol.for(HUB_GLOBAL_KEY)
  const globals = globalThis as unknown as Record<symbol, unknown>
  const existing = globals[key]
  let hub: BridgeHub
  if (existing instanceof BridgeHub) {
    hub = existing
  } else {
    const serviceVersion = readServiceVersion(ctx)
    const created = new BridgeHub(serviceVersion === undefined ? {} : { serviceVersion })
    try {
      await created.start()
    } catch (error) {
      // §4.1 fail-soft: a bridge that cannot start disables the plugin, never
      // the host.
      createLogger('bridge-hub').error('failed to start the bridge hub; plugin disabled', {
        error: error instanceof Error ? error.name : typeof error,
      })
      return NOOP_CLEANUP
    }
    globals[key] = created
    hub = created
  }
  let release: Cleanup
  try {
    release = await hub.install(ctx)
  } catch (error) {
    createLogger('bridge-hub').error('failed to adopt the bridge hub for this location', {
      error: error instanceof Error ? error.name : typeof error,
    })
    return NOOP_CLEANUP
  }
  // The wrapper is identical on the create and adopt paths so that releasing the
  // last reference always drops the global handle.
  return async () => {
    await release()
    if (hub.stopped && globals[key] === hub) delete globals[key]
  }
}
