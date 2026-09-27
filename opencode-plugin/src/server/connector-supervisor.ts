/**
 * Connector supervisor — spawn the Agents Anywhere Connector as a child process
 * and keep it alive (design §5.1 step 6, §2.6 recovery).
 *
 * The Connector is the only outbound party: it dials the AA server **and** every
 * local bridge endpoint. The plugin never calls into it over the network; it owns
 * the process and speaks NDJSON JSON-RPC 2.0 over stdio, mirroring
 * `dsh-bridge-next/src/host/connector/process.ts` (methods `connector.getState` /
 * `connector.start` / `connector.stop`, notification `connector/state`).
 *
 * Zero runtime dependencies: `uv` is located on `PATH` at runtime. The Connector
 * source is either the copy bundled into this package at build time
 * (`lib/connector/` — the only form a Git-spec install can carry, because the
 * installer ships just this subdirectory and never runs a build; dist report 03)
 * or, in a development checkout, the sibling `../connector/`. Neither is an npm
 * dependency.
 *
 * Everything that touches the machine (spawn, uv resolution, retry scheduling,
 * the package directory) is injectable so the whole lifecycle is testable
 * against a **fake connector script** — tests must never spawn the real
 * Connector, and this module never does so on its own either.
 */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { constants } from 'node:fs'
import { access, appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, type Logger } from '../shared/logger.js'
import { writeJsonAtomic } from '../shared/credentials.js'
import { clearOwnChild, setOwnChild } from './connector-ownership.js'

export const CONNECTOR_SOURCE_ENV = 'AGENT_CONNECTOR_SOURCE'
export const CONNECTOR_UV_ENV = 'AGENT_CONNECTOR_UV'

/**
 * Where `scripts/bundle-connector.ts` copies the Connector at build time. This is
 * the first default source: a package (Git-spec / npm) install has no sibling
 * checkout, so this copy is what makes it self-contained.
 */
export const BUNDLED_CONNECTOR_SUBDIR = join('lib', 'connector')

/** Wall-clock bound for the first RPC: `uv` may still be installing wheels. */
const DEFAULT_FIRST_REQUEST_TIMEOUT_MS = 3_600_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_RECONNECT_DELAY_MS = 5_000
const DEFAULT_MAX_RESTART_ATTEMPTS = 5
const MAX_FRAME_BYTES = 1024 * 1024

export type ConnectorLauncher = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface SupervisorState {
  running: boolean
  authFailed: boolean
}

export interface ConnectorSpawnConfig {
  apiBaseUrl: string
  connectorId: string
  connectorToken: string
  /** Directory for `connector.json` and the Connector's sqlite state. */
  dataDir: string
  syncIntervalSeconds?: number
  heartbeatSeconds?: number
  reconnectSeconds?: number
}

export interface SupervisorOptions {
  logger?: Logger
  env?: NodeJS.ProcessEnv
  /** Highest-priority source override (beats `AGENT_CONNECTOR_SOURCE`). */
  sourceDir?: string
  uvPath?: string
  /** Package directory used to locate the sibling `connector/` (injectable). */
  packageDir?: string
  spawn?: ConnectorLauncher
  resolveUv?: (command: string) => Promise<string | null>
  firstRequestTimeoutMs?: number
  requestTimeoutMs?: number
  reconnectDelayMs?: number
  maxRestartAttempts?: number
  /** Retry scheduler (injectable so tests never wait on a real timer). */
  scheduleRetry?: (callback: () => void, delayMs: number) => () => void
  onState?: (state: SupervisorState) => void
  /** §2.6 crash report — surfaced to the bridge/logs, never carrying credentials. */
  onRuntimeError?: (info: { code: string; retryable: boolean; attempt: number }) => void
  /**
   * Fired once per launched child (including a reconnect's child). The plugin
   * records the pid so a later process can reuse it instead of spawning a
   * second tree, and can stop *its own* orphan — see `connector-ownership.ts`.
   */
  onChild?: (info: { pid: number; config: ConnectorSpawnConfig }) => void
}

/** The Connector source could not be located (actionable, never silent). */
export class ConnectorSourceError extends Error {
  readonly code = 'connector_source_missing'
}

/** `uv` could not be located (actionable, never silent). */
export class UvUnavailableError extends Error {
  readonly code = 'uv_unavailable'
}

/** Another Connector already holds the machine-wide OS lease. */
export class ConnectorOwnershipError extends Error {
  readonly code = 'connector_already_running'
  /** Who holds the lease (from the Connector's RPC error), so a caller can record it. */
  readonly owner: { kind: string | null; pid: number | null }
  constructor(
    message: string,
    owner: { kind: string | null; pid: number | null } = { kind: null, pid: null },
  ) {
    super(message)
    this.owner = owner
  }
}

/** The Connector rejected our stored device credential. */
export class ConnectorCredentialError extends Error {
  readonly code = 'connector_auth_failed'
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ConnectorSupervisor {
  readonly #logger: Logger
  readonly #env: NodeJS.ProcessEnv
  readonly #sourceDir: string | undefined
  readonly #uvPath: string | undefined
  readonly #packageDir: string
  readonly #launch: ConnectorLauncher
  readonly #resolveUvFn: (command: string) => Promise<string | null>
  readonly #firstRequestTimeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #reconnectDelayMs: number
  readonly #maxRestartAttempts: number
  readonly #scheduleRetry: (callback: () => void, delayMs: number) => () => void
  #onState: ((state: SupervisorState) => void) | undefined
  readonly #onRuntimeError: ((info: { code: string; retryable: boolean; attempt: number }) => void) | undefined
  readonly #onChild: ((info: { pid: number; config: ConnectorSpawnConfig }) => void) | undefined

  #child: ChildProcessWithoutNullStreams | null = null
  /** In-flight spawn, so concurrent `start()` calls share exactly one launch. */
  #starting: Promise<void> | null = null
  #nextId = 0
  #pending = new Map<number, Pending>()
  #buffer = ''
  #failure: Error | null = null
  /** The Connector's own `lastError` (why it is not running), surfaced to the user. */
  #remoteError: string | null = null
  #state: SupervisorState = { running: false, authFailed: false }
  #stopping: Promise<void> | null = null
  #lastConfig: ConnectorSpawnConfig | null = null
  #attempt = 0
  #cancelRetry: (() => void) | null = null
  #desired = false
  readonly #closed = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(options: SupervisorOptions = {}) {
    this.#logger = options.logger ?? createLogger('connector-supervisor')
    this.#env = options.env ?? process.env
    this.#sourceDir = options.sourceDir
    this.#uvPath = options.uvPath
    this.#packageDir = options.packageDir ?? defaultPackageDir()
    this.#launch = options.spawn ?? (spawn as ConnectorLauncher)
    this.#resolveUvFn = options.resolveUv ?? ((command) => resolveUvOnPath(command, this.#env))
    this.#firstRequestTimeoutMs = options.firstRequestTimeoutMs ?? DEFAULT_FIRST_REQUEST_TIMEOUT_MS
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.#maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS
    this.#scheduleRetry =
      options.scheduleRetry ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref?.()
        return () => clearTimeout(timer)
      })
    this.#onState = options.onState
    this.#onRuntimeError = options.onRuntimeError
    this.#onChild = options.onChild
  }

  get state(): SupervisorState {
    return { ...this.#state }
  }

  /**
   * Late-bound state listener, so the plugin's credential-health reporter can
   * attach to an already-constructed supervisor (including one a caller
   * injected). Replaces any listener passed via `options.onState`.
   */
  attachStateListener(listener: (state: SupervisorState) => void): void {
    this.#onState = listener
  }

  get running(): boolean {
    return this.#child !== null && this.#state.running && !this.#state.authFailed
  }

  get lastError(): string | null {
    return this.#failure?.message ?? this.#remoteError
  }

  get attempts(): number {
    return this.#attempt
  }

  // ── source / uv resolution ──────────────────────────────────────────────────

  /**
   * Resolution order (design §5; dist report 03):
   *   ① explicit `sourceDir` option or `AGENT_CONNECTOR_SOURCE` — an override
   *      always wins, so an operator can point at any checkout;
   *   ② the copy bundled into this package (`lib/connector/`) — the only source
   *      that survives a Git-spec install;
   *   ③ the development sibling `../connector/`;
   *   ④ an actionable error — never a silent skip.
   */
  resolveSourceDir(): string {
    return this.sourceCandidates()[0]!
  }

  /** Candidate paths checked by `prepare()`, in the order they were resolved. */
  sourceCandidates(): string[] {
    const explicit = this.#sourceDir ?? nonEmpty(this.#env[CONNECTOR_SOURCE_ENV])
    if (explicit !== undefined) return [explicit]
    return [join(this.#packageDir, BUNDLED_CONNECTOR_SUBDIR), join(dirname(this.#packageDir), 'connector')]
  }

  async resolveUv(): Promise<string | null> {
    const command = this.#uvPath ?? nonEmpty(this.#env[CONNECTOR_UV_ENV]) ?? 'uv'
    return await this.#resolveUvFn(command)
  }

  /**
   * Verify both prerequisites before spawning. Throws an actionable error naming
   * the exact remedy — the alternative (a silent no-op) is what makes a broken
   * install invisible.
   */
  async prepare(): Promise<void> {
    const candidates = this.sourceCandidates()
    let found = false
    for (const candidate of candidates) {
      if (await isConnectorSource(candidate)) {
        found = true
        break
      }
    }
    if (!found) {
      throw new ConnectorSourceError(
        `未找到 Connector 源码。本插件包内应自带 ${BUNDLED_CONNECTOR_SUBDIR}（随包分发，安装包损坏或版本不对时会缺失）；` +
          `也可设置 ${CONNECTOR_SOURCE_ENV} 指向包含 pyproject.toml 与 connector/cli.py 的目录，` +
          `或把本仓库的 connector/ 放在插件包同级。已尝试：${candidates.join(', ')}。`,
      )
    }
    const uv = await this.resolveUv()
    if (uv === null) {
      throw new UvUnavailableError(
        '未找到 uv 可执行文件。请安装 uv（https://docs.astral.sh/uv/），或设置 AGENT_CONNECTOR_UV 指向 uv 的绝对路径。',
      )
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async start(config: ConnectorSpawnConfig): Promise<void> {
    // An explicit start resets the crash counter; the retry path does not.
    this.#attempt = 0
    this.#desired = true
    this.#lastConfig = config
    // Concurrent starts — two `setup()` paths, or a hot reload racing a
    // `resume()` — must share exactly one launch. Without this guard both
    // callers pass `#spawnChild`'s `running` check before either child is
    // assigned, and two `uv` trees are forked against the same OS lease.
    this.#starting ??= this.#spawnChild(config).finally(() => {
      this.#starting = null
    })
    await this.#starting
  }

  async #spawnChild(config: ConnectorSpawnConfig): Promise<void> {
    if (this.#stopping !== null) await this.#stopping
    if (this.running) return
    if (this.#child !== null) await this.#stopChild()
    this.#cancelRetry?.()
    this.#cancelRetry = null

    const sourceDir = await firstSource(this.sourceCandidates())
    if (sourceDir === null) {
      throw new ConnectorSourceError(
        `未找到 Connector 源码。请设置 ${CONNECTOR_SOURCE_ENV}，或安装自带 ${BUNDLED_CONNECTOR_SUBDIR} 的正式插件包（开发期可用同级 connector/）。`,
      )
    }
    const uv = await this.resolveUv()
    if (uv === null) {
      throw new UvUnavailableError('未找到 uv 可执行文件；请安装 uv 或设置 AGENT_CONNECTOR_UV。')
    }

    await mkdir(config.dataDir, { recursive: true, mode: 0o700 })
    const configPath = join(config.dataDir, 'connector.json')
    await writeJsonAtomic(configPath, {
      serverUrl: config.apiBaseUrl.replace(/\/+$/, ''),
      connectorId: config.connectorId,
      connectorToken: config.connectorToken,
      statePath: join(config.dataDir, `${config.connectorId}.sqlite3`),
      heartbeatSeconds: config.heartbeatSeconds ?? 20,
      reconnectSeconds: config.reconnectSeconds ?? 3,
      syncExistingOnConnect: true,
      syncIntervalSeconds: config.syncIntervalSeconds ?? 30,
    })

    this.#failure = null
    this.#buffer = ''
    this.#setState({ running: false, authFailed: false })

    const child = this.#launch(
      uv,
      ['run', '--directory', sourceDir, 'anywhere-cli', 'rpc', '--config', configPath],
      {
        cwd: sourceDir,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: connectorEnv(this.#env, config.dataDir),
      },
    )
    this.#child = child
    // Record the tree *we* launched so a later `setup()`, a hot reload or a
    // fresh process adopts it instead of forking a second one — and so a stop
    // can name exactly our own child (connector-ownership.ts).
    const childPid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null
    if (childPid !== null) {
      await setOwnChild(config.dataDir, {
        pid: childPid,
        connectorId: config.connectorId,
        childStatePath: join(config.dataDir, `${config.connectorId}.sqlite3`),
        spawnedAt: Date.now(),
      }).catch(() => undefined)
      try {
        this.#onChild?.({ pid: childPid, config })
      } catch {
        // A listener error must never break the supervisor.
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (this.#child === child) this.#receive(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // The Connector's raw stderr can carry config paths and, in principle, a
      // token echoed by a Python traceback, so it never enters the host log
      // verbatim. It *is* persisted (token redacted) beside the Connector's own
      // state, because "why did it fail" has to be answerable by the user.
      this.#logger.debug('connector stderr', { bytes: chunk.length })
      void this.#recordStderr(config.dataDir, chunk, config.connectorToken)
    })
    child.stdin.on('error', () => {
      if (this.#child === child) this.#fail(new Error('Connector 输入连接已关闭。'))
    })
    child.on('error', () => {
      if (this.#child === child) this.#fail(new Error('Connector 进程启动失败，请检查 uv 与源码运行环境。'))
    })
    child.on('close', (code) => {
      this.#closed.add(child)
      if (childPid !== null) void clearOwnChild(config.dataDir, childPid).catch(() => undefined)
      if (this.#child === child) {
        this.#child = null
        this.#fail(new Error(`Connector 已退出（${code ?? 'signal'}）。`))
        this.#scheduleReconnect()
      }
    })

    try {
      await this.#call('connector.getState', this.#firstRequestTimeoutMs)
      await this.#call('connector.start')
    } catch (error) {
      // A failed *start* is not a crash to recover from. Without clearing
      // `#desired` first, the `close` emitted by the stop below schedules a
      // reconnect that forks another doomed uv tree every `reconnectDelayMs`
      // (the real-machine accumulation: refused starts left orphans behind).
      this.#desired = false
      // `as` side-steps control-flow narrowing (the field is re-assigned from
      // the child's `close` handler, which the compiler cannot see).
      const pendingRetry = this.#cancelRetry as (() => void) | null
      this.#cancelRetry = null
      pendingRetry?.()
      await this.#stopChild()
      throw error
    }
  }

  /** Healthy only when the Connector reports `running` and not auth-failed. */
  async assertHealthy(): Promise<void> {
    if (this.#state.authFailed) throw new ConnectorCredentialError('本机设备连接已失效，请在插件中重新登录。')
    if (this.#failure !== null) throw this.#failure
    const state = (await this.#call('connector.getState')) as { running?: unknown; authFailed?: unknown }
    this.#applyState(state)
    if (this.#state.authFailed) throw new ConnectorCredentialError('本机设备连接已失效，请在插件中重新登录。')
    if (!this.#state.running) throw new Error('Connector 尚未运行，请重试。')
  }

  stop(): Promise<void> {
    if (this.#stopping !== null) return this.#stopping
    this.#desired = false
    this.#attempt = 0
    this.#cancelRetry?.()
    this.#cancelRetry = null
    this.#stopping = this.#stopChild().finally(() => {
      this.#failure = null
      this.#stopping = null
    })
    return this.#stopping
  }

  async #stopChild(): Promise<void> {
    const child = this.#child
    if (child === null) return
    try {
      await this.#call('connector.stop', 3_000)
    } catch {
      // The child may not have finished starting.
    }
    const ended = new Promise<void>((resolve) => {
      if (this.#closed.has(child) || child.exitCode !== null || child.signalCode !== null) resolve()
      else child.once('close', () => resolve())
    })
    // Closing stdio is the graceful stop; a broken pipe must not skip the kill.
    try {
      child.stdin.end()
    } catch {
      // The pipe may already be gone; the terminate below still applies.
    }
    await Promise.race([ended, delay(1_000)])
    if (!this.#closed.has(child)) this.#terminate(child, false)
    await Promise.race([ended, delay(3_000)])
    if (!this.#closed.has(child)) this.#terminate(child, true)
    // Bounded: a child that never reports `close` must not wedge `stop()` (and
    // thus a plugin teardown) forever. The force-kill above has already run.
    await Promise.race([ended, delay(5_000)])
    if (!this.#closed.has(child) && child.exitCode === null && child.signalCode === null) {
      this.#logger.warn('connector did not report exit after a forced stop')
    }
    if (this.#child === child) this.#child = null
    const childPid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : null
    if (childPid !== null && this.#lastConfig !== null) {
      await clearOwnChild(this.#lastConfig.dataDir, childPid).catch(() => undefined)
    }
  }

  /** Persist stderr (token redacted) so a failure leaves a user-readable trace. */
  async #recordStderr(dataDir: string, chunk: string, token: string): Promise<void> {
    try {
      const text = token.length > 0 ? chunk.split(token).join('[redacted]') : chunk
      await appendFile(join(dataDir, 'connector.log'), text, { mode: 0o600 })
    } catch {
      // Observability is best-effort; never let it break the supervisor.
    }
  }

  #terminate(child: ChildProcessWithoutNullStreams, force: boolean): void {
    if (typeof child.pid !== 'number' || child.pid <= 0) return
    if (process.platform === 'win32') {
      // `uv` runs the Connector as a *grandchild* Python process, so a direct
      // `child.kill` on Windows leaves the Python process orphaned. `taskkill
      // /T` walks the whole tree instead.
      try {
        const killer = spawn('taskkill', windowsTreeKillArgs(child.pid, force), {
          windowsHide: true,
          stdio: 'ignore',
        })
        // A missing/broken taskkill must not leave even the direct child alive.
        killer.on('error', () => directKill(child, force))
        killer.unref()
        return
      } catch {
        directKill(child, force)
      }
      return
    }
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
      return
    } catch {
      // Group kill is unavailable; fall through to the direct signal.
    }
    directKill(child, force)
  }

  // ── crash recovery ──────────────────────────────────────────────────────────

  #scheduleReconnect(): void {
    const config = this.#lastConfig
    if (!this.#desired || config === null || this.#stopping !== null) return
    this.#attempt += 1
    const retryable = this.#attempt <= this.#maxRestartAttempts
    this.#onRuntimeError?.({ code: 'runtime_error', retryable, attempt: this.#attempt })
    this.#logger.warn('connector exited; scheduling a reconnect', { attempt: this.#attempt, retryable })
    if (!retryable) return
    this.#cancelRetry = this.#scheduleRetry(() => {
      this.#cancelRetry = null
      // Re-read the persisted config (a rotated token must be picked up) and
      // restart; a failure re-schedules from the new child's `close` handler.
      this.#spawnChild(config).catch((error: unknown) => {
        this.#logger.warn('connector reconnect failed', {
          error: error instanceof Error ? error.name : typeof error,
        })
        this.#scheduleReconnect()
      })
    }, this.#reconnectDelayMs)
  }

  // ── stdio JSON-RPC ──────────────────────────────────────────────────────────

  #call(method: string, timeoutMs = this.#requestTimeoutMs): Promise<unknown> {
    const child = this.#child
    if (child === null || this.#failure !== null) {
      return Promise.reject(this.#failure ?? new Error('Connector 未启动。'))
    }
    const id = (this.#nextId += 1)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('Connector 响应超时，请检查 Python 依赖安装与网络连接。'))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`)
    })
  }

  #receive(chunk: string): void {
    this.#buffer += chunk
    if (this.#buffer.length > MAX_FRAME_BYTES) {
      this.#fail(new Error('Connector 返回了过大的消息。'))
      return
    }
    let newline: number
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      let frame: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
      try {
        frame = JSON.parse(line) as typeof frame
      } catch {
        this.#fail(new Error('Connector 返回了无效的协议消息。'))
        return
      }
      if (frame.method === 'connector/state' && frame.id === undefined) {
        this.#applyState(frame.params)
        continue
      }
      if (typeof frame.id !== 'number') continue
      const pending = this.#pending.get(frame.id)
      if (pending === undefined) continue
      this.#pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (frame.error) pending.reject(mapRpcError(frame.error))
      else pending.resolve(frame.result)
    }
  }

  #fail(error: Error): void {
    this.#failure = error
    this.#setState({ ...this.#state, running: false })
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  /** Only the two booleans feed the lifecycle state; the failure reason is logged. */
  #applyState(value: unknown): void {
    if (value === null || typeof value !== 'object') return
    const state = value as { running?: unknown; authFailed?: unknown; status?: unknown; lastError?: unknown }
    if (typeof state.running !== 'boolean' || typeof state.authFailed !== 'boolean') return
    // The Connector answers `getState`/emits `connector/state` with a `status`
    // and `lastError`; dropping them (the old behaviour) is exactly why a
    // failing Connector left the user with "offline" and no reason.
    const remoteError = typeof state.lastError === 'string' && state.lastError.length > 0 ? state.lastError : null
    if (remoteError !== this.#remoteError) {
      this.#remoteError = remoteError
      if (remoteError !== null) {
        this.#logger.warn('Connector 报告了失败原因', {
          status: typeof state.status === 'string' ? state.status : undefined,
          error: remoteError,
        })
      }
    }
    this.#setState({ running: state.running, authFailed: state.authFailed })
  }

  #setState(next: SupervisorState): void {
    if (next.running === this.#state.running && next.authFailed === this.#state.authFailed) return
    this.#state = next
    try {
      this.#onState?.({ ...next })
    } catch {
      // A listener error must never break the supervisor.
    }
  }
}

function mapRpcError(error: unknown): Error {
  const record = (error ?? {}) as { code?: unknown; data?: { reason?: unknown; owner?: unknown } }
  const reason = typeof record.data?.reason === 'string' ? record.data.reason : null
  if (record.code === -32009 && reason === 'connector_already_running') {
    const raw = record.data?.owner
    const ownerRecord = raw !== null && typeof raw === 'object' ? (raw as { kind?: unknown; pid?: unknown }) : {}
    const owner = {
      kind: typeof ownerRecord.kind === 'string' && ownerRecord.kind.length > 0 ? ownerRecord.kind : null,
      pid: typeof ownerRecord.pid === 'number' && Number.isInteger(ownerRecord.pid) && ownerRecord.pid > 0 ? ownerRecord.pid : null,
    }
    return new ConnectorOwnershipError('本机已有另一个 Connector 在运行，正在复用它的连接。', owner)
  }
  return new Error('Connector 操作失败，请检查本机运行环境后重试。')
}

/** Env handed to the child: never a credential on the command line, never an npm dep. */
export function connectorEnv(env: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  return {
    ...env,
    AA_CONNECTOR_OWNER_KIND: 'opencode-plugin',
    AGENT_CONNECTOR_DATA_DIR: dataDir,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    UV_HTTP_TIMEOUT: env['UV_HTTP_TIMEOUT'] ?? '60',
  }
}

/**
 * `taskkill` args that terminate an entire Windows process tree: `/T` walks from
 * the given pid to its children (uv → python), `/F` forces when the graceful
 * signal was ignored. Exported so the tree-kill wiring is unit-testable without
 * spawning a real Connector.
 */
export function windowsTreeKillArgs(pid: number, force: boolean): string[] {
  return force ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T']
}

/** Signal only the direct child; already-gone is not an error. */
function directKill(child: ChildProcessWithoutNullStreams, force: boolean): void {
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // Already gone.
  }
}

/**
 * Terminate a whole process tree by pid, cross-platform: a POSIX process group
 * kill when the leader owns one, `taskkill /T` on Windows, a direct signal as
 * the last resort. Used by the supervisor's own teardown and by the explicit
 * cleanup path (which never owns a `ChildProcess` handle).
 */
export function killProcessTree(pid: number, force = true): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', windowsTreeKillArgs(pid, force), { windowsHide: true, stdio: 'ignore' }).unref()
    } catch {
      // taskkill unavailable; nothing else to try on Windows.
    }
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
    return
  } catch {
    // No process group; fall through to the direct signal.
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // Already gone.
  }
}

async function isConnectorSource(dir: string): Promise<boolean> {
  return (await exists(join(dir, 'pyproject.toml'))) && (await exists(join(dir, 'connector', 'cli.py')))
}

async function firstSource(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isConnectorSource(candidate)) return candidate
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Locate `uv` on `PATH` plus the usual per-user install dirs. */
export async function resolveUvOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (isAbsolute(command)) {
    return (await isExecutable(command)) ? command : null
  }
  const home = env['USERPROFILE'] ?? env['HOME'] ?? ''
  const entries = [
    ...(env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter((entry) => entry.length > 0),
    ...(home.length > 0
      ? [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), join(home, 'AppData', 'Local', 'Programs', 'uv')]
      : []),
  ]
  const names = process.platform === 'win32' && !command.endsWith('.exe') ? [command, `${command}.exe`] : [command]
  for (const entry of new Set(entries)) {
    for (const name of names) {
      const candidate = join(entry, name)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return null
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Walk up from this module to the package root (handles `src/` and `lib/`). */
function defaultPackageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(fileURLToPath(import.meta.url))
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
