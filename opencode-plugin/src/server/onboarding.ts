/**
 * Onboarding orchestration (design §5.1): reuse-first, then loopback OAuth or
 * the headless device-code fallback, then device registration/reuse, then spawn
 * the Connector. This is the module `server/index.ts` wires into `setup()`.
 *
 * Order matters and is enforced here:
 *   1. effective credentials on disk  → zero login (reuse)
 *   2. the shared `connector-runtime.json` record mentions our device → reuse it
 *   3. only then an interactive flow
 * Logout is the exact reverse and **irreversible**: revoke on the server first,
 * then delete the local binding/account, then stop the Connector. Deleting local
 * state first would orphan a live device credential on the server.
 *
 * A stored device credential is **verified before it is used** (§ resume):
 * `POST /connector/auth` is the only call that actually validates a device
 * token, and a 401 is healed automatically (rotate the same device, or register
 * it anew when the row is gone) under a cross-process lock, writing the
 * server-issued token atomically. A 401 reported *after* a Connector started is
 * never silent: it reaches the log, `login.json` and `status()`, with a next
 * step, and one bounded heal-and-restart is attempted.
 *
 * The interactive half is *triggered* by `server/index.ts` (`runAutoLogin`) the
 * moment `resume()` says `needs_login`; this module only performs it. Loopback
 * opens the system browser fail-soft and hands the prompt context (URL +
 * deadline) to the caller, which logs it and writes `login.json` — nothing about
 * a login is discoverable **only** in the log.
 *
 * No secret is ever logged.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createLogger, type Logger } from '../shared/logger.js'
import { FORCE_REUSE_CONNECTOR_ENV, SERVER_URL_ENV, type LoginMode } from '../shared/plugin-options.js'
import {
  accountIsUsable,
  bindingPath,
  clearAccount,
  clearBinding,
  clearPendingFlow,
  clearPendingRegistration,
  pluginDataDir,
  readAccount,
  readBinding,
  readConnectorRuntime,
  readJsonFile,
  readPendingFlow,
  readPendingRegistration,
  pendingFlowIsLive,
  readSettings,
  runtimeMentionsConnector,
  saveAccount,
  saveBinding,
  savePendingFlow,
  savePendingRegistration,
  type AccountCredential,
  type BindingCredential,
  type PluginSettings,
} from '../shared/credentials.js'
import { withFileLock } from '../shared/file-lock.js'
import { LOGIN_PROMPT_VERSION, writeLoginPrompt } from '../shared/login-prompt.js'
import {
  locateServerUrl,
  type ServerUrlFile,
  type ServerUrlResolution,
  type ServerUrlSource,
} from '../shared/server-url.js'
import { AccountClient, type AccountProfile } from './account-api.js'
import { openExternal, type BrowserOpenResult } from './browser-opener.js'
import {
  ConnectorOwnershipError,
  ConnectorSupervisor,
  BUNDLED_CONNECTOR_SUBDIR,
  killProcessTree,
  type ConnectorSpawnConfig,
  type SupervisorState,
} from './connector-supervisor.js'
import { judgeConnectorCapability, probeConnectorCapability, type ConnectorCapability } from './connector-capability.js'
import {
  clearOwnChild,
  probeForeignBlock,
  probeOwnConnector,
  setBlocked,
  type ForeignBlockProbe,
  type OwnConnectorProbe,
} from './connector-ownership.js'
import { probeExistingConnector, type ExistingConnectorProbe } from './connector-reuse.js'
import { runDeviceLogin, type DeviceCodeNotice } from './device-login.js'
import {
  LOOPBACK_UNAVAILABLE_CODE,
  LoopbackFlowError,
  LoopbackOAuthFlow,
  type LoopbackStart,
} from './oauth-loopback.js'
import { apiBaseUrl as normalizeServerUrl, webOrigin } from '../shared/oauth.js'

/** Re-exported so the env name stays importable from this module (its original home). */
export { SERVER_URL_ENV }

/**
 * Normalise the env-provided server origin; invalid input is `null`, never
 * guessed. The env var is now an **override for advanced/headless installs**:
 * the primary setting is `options.serverUrl` (see `shared/plugin-options.ts`),
 * which the plugin entry passes in as `OnboardingOptions.serverUrl`, and the
 * full layer order (including the machine's own Connector/Desktop records) is
 * `shared/server-url.ts`.
 */
export function serverUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeServerUrl(env[SERVER_URL_ENV] ?? '')
}

export interface OnboardingStatus {
  configured: boolean
  apiBaseUrl: string | null
  /** Which layer supplied `apiBaseUrl` when it did not come from a stored account. */
  apiBaseUrlSource?: ServerUrlSource
  loggedIn: boolean
  accountExpiresAt: number | null
  userId: string | null
  displayName: string | null
  connectorId: string | null
  connectorRunning: boolean
  /**
   * An actionable sentence when the device credential was rejected (401) and
   * the automatic repair has not (yet) succeeded. `null` in every healthy or
   * unverified state — it is the "not silently offline" channel for a status
   * surface.
   */
  credentialProblem: string | null
}

export type ConnectionStage =
  | { stage: 'connected'; apiBaseUrl: string; userId: string; connectorId: string; reusedDevice: boolean }
  | { stage: 'needs_login'; apiBaseUrl: string | null; reason: string }
  | { stage: 'disabled'; reason: string }

export type LoginOutcome =
  | { ok: true; stage: Extract<ConnectionStage, { stage: 'connected' }> }
  | { ok: false; code: string; message: string }

export interface OnboardingOptions {
  logger?: Logger
  env?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  supervisor?: ConnectorSupervisor
  now?: () => number
  /**
   * Opens the browser (injectable; tests never launch one). Failure is
   * fail-soft: a rejected opener is reported and the flow keeps waiting.
   */
  openUrl?: (url: string) => Promise<void> | void
  /** Device name registered with the server. */
  deviceName?: () => string
  /** Reuse probe (injectable; tests assert a reuse decision never spawns). */
  probeConnector?: (connectorId: string) => Promise<ExistingConnectorProbe>
  /**
   * Capability gate for the reuse decision (task B, injectable so tests never
   * touch the network). Defaults to asking the server which runtime types the
   * running Connector advertises; anything other than `reuse` means the plugin
   * starts **its own** Connector instead of reusing a foreign one.
   */
  probeConnectorCapability?: (input: {
    account: AccountCredential
    connectorId: string
  }) => Promise<ConnectorCapability>
  /**
   * Explicit opt-in: reuse whatever Connector is running, capability check
   * skipped (`options.forceReuseConnector` / `AGENT_AA_FORCE_REUSE_CONNECTOR`).
   */
  forceReuseConnector?: boolean
  /**
   * Highest-priority server origin, from the plugin configuration
   * (`options.serverUrl`). `null`/absent falls back to `AGENT_SERVER_URL`, the
   * machine's own Connector/Desktop records and finally `settings.json`
   * (exact order and log lines: `shared/server-url.ts`).
   */
  serverUrl?: string | null
  /** Connector source directory override (`options.connectorSource`). */
  connectorSource?: string | null
  /**
   * Machine-local address candidates (`shared/server-url.ts`). Defaults to the
   * shared `connector-runtime.json` + this OS's Desktop config dirs; injectable
   * so a test never reads the developer's real `%APPDATA%`.
   */
  serverUrlFiles?: readonly ServerUrlFile[]
  /** Injectable file reader for `serverUrlFiles` (`null` = missing/unreadable). */
  readText?: (path: string) => Promise<string | null>
  /** Overrides `process.platform` when deriving the Desktop config dirs. */
  platform?: NodeJS.Platform
  /**
   * Stops a Connector tree **this plugin** launched in an earlier process whose
   * `connector.json` still carries an older device token. Defaults to the
   * supervisor's `killProcessTree`; injectable so no test ever signals a real
   * pid.
   */
  stopOwnConnector?: (pid: number) => void
}

/** What the loopback prompt writer needs to make the URL actionable. */
export interface LoopbackPromptContext {
  /** Epoch ms after which the URL is dead. */
  deadline: number
  redirectUri: string
}

export interface LoginOptions {
  /** Skip the browser/loopback entirely (SSH/headless). */
  headless?: boolean
  /** Called with the short code the user must enter (headless path). */
  onCode?: (notice: DeviceCodeNotice) => void | Promise<void>
  /**
   * Called once the loopback listener is up, before the browser is opened. The
   * returned promise is awaited (fail-soft), so a writer of `login.json` is
   * guaranteed to have finished before the user is asked to click anything.
   */
  onAuthorizationUrl?: (url: string, context: LoopbackPromptContext) => void | Promise<void>
  signal?: AbortSignal
  /** Override the settings apiBaseUrl for this login. */
  apiBaseUrl?: string
  /** Test seam: replaces the device-code poll delay. */
  pollSleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** How many automatic credential repairs one process attempts before it only reports. */
const MAX_AUTH_HEAL_ATTEMPTS = 2

/**
 * The sentence a rejected device credential must leave behind (log, `login.json`
 * and `status()` all carry it verbatim): what happened, why it can happen, and
 * exactly what to do next — never a bare `offline`.
 */
export function credentialRejectedInstruction(): string {
  return (
    '设备凭据被服务器拒绝（HTTP 401）：本地保存的 Connector 凭据与服务端不一致' +
    '（重复注册导致的令牌轮换、其它主机恢复同一设备、或设备被撤销都会造成）。' +
    '下一步：插件会自动轮换设备凭据并重启 Connector；若仍失败，请运行 /aa-login 重新登录' +
    '（或运行 /aa-logout 后再 /aa-login）。'
  )
}

export class Onboarding {
  readonly #logger: Logger
  readonly #env: NodeJS.ProcessEnv
  readonly #fetcher: typeof fetch | undefined
  readonly #now: () => number
  readonly #openUrl: (url: string) => Promise<BrowserOpenResult>
  readonly #deviceName: () => string
  readonly #probeConnector: (connectorId: string) => Promise<ExistingConnectorProbe>
  readonly #probeConnectorCapability: (input: {
    account: AccountCredential
    connectorId: string
  }) => Promise<ConnectorCapability>
  readonly #forceReuseConnector: boolean
  /** `options.serverUrl` / `options.connectorSource`, the plugin-config layer. */
  readonly #optionServerUrl: string | null
  readonly #optionConnectorSource: string | null
  readonly #serverUrlFiles: readonly ServerUrlFile[] | undefined
  readonly #readText: ((path: string) => Promise<string | null>) | undefined
  readonly #platform: NodeJS.Platform | undefined
  readonly #stopOwnConnector: (pid: number) => void
  /** Memoised resolution — one read + one log per instance, not one per call. */
  #serverUrlTask: Promise<ServerUrlResolution> | undefined
  readonly supervisor: ConnectorSupervisor
  /** Last account/binding handed to the supervisor — the heal path's context. */
  #lastAccount: AccountCredential | null = null
  #lastBinding: BindingCredential | null = null
  /** The flow a future credential-failure record should name (no secret). */
  #lastLoginKind: LoginMode = 'loopback'
  /** Actionable text while the stored credential is rejected; `null` when healthy. */
  #credentialProblem: string | null = null
  #authHealAttempts = 0
  #authHealRunning = false

  constructor(options: OnboardingOptions = {}) {
    this.#logger = options.logger ?? createLogger('onboarding')
    this.#env = options.env ?? process.env
    this.#fetcher = options.fetcher
    this.#now = options.now ?? Date.now
    this.#openUrl = options.openUrl !== undefined ? wrapOpener(options.openUrl) : openExternal
    this.#deviceName = options.deviceName ?? defaultDeviceName
    this.#optionServerUrl = options.serverUrl ?? null
    this.#optionConnectorSource = options.connectorSource ?? null
    this.#serverUrlFiles = options.serverUrlFiles
    this.#readText = options.readText
    this.#platform = options.platform
    this.#stopOwnConnector = options.stopOwnConnector ?? ((pid) => killProcessTree(pid))
    this.#probeConnector =
      options.probeConnector ??
      ((connectorId) => probeExistingConnector({ env: this.#env, connectorId }))
    this.#probeConnectorCapability =
      options.probeConnectorCapability ??
      ((input) =>
        probeConnectorCapability({
          accessToken: input.account.accessToken,
          connectorId: input.connectorId,
          listRuntimeTypes: (token, connectorId) =>
            this.#client(input.account.apiBaseUrl).listConnectorRuntimeTypes(token, connectorId),
        }))
    this.#forceReuseConnector = options.forceReuseConnector === true
    this.supervisor =
      options.supervisor ??
      new ConnectorSupervisor({
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(this.#optionConnectorSource !== null ? { sourceDir: this.#optionConnectorSource } : {}),
        onState: (state) => this.#handleSupervisorState(state),
      })
    // An injected supervisor (tests, or a future host) still reaches the same
    // credential-health reporter — a 401 must never be silent in either case.
    const attachable = this.supervisor as { attachStateListener?: (listener: (state: SupervisorState) => void) => void }
    attachable.attachStateListener?.((state) => this.#handleSupervisorState(state))
  }

  get dataDir(): string {
    return pluginDataDir(this.#env)
  }

  /**
   * Server origin, highest layer first: plugin config (`options.serverUrl`) →
   * `AGENT_SERVER_URL` → the machine's own `connector-runtime.json` → the
   * Desktop app's config → `settings.json` (added by each caller, since a
   * stored account records its own origin). Every skipped layer and the winning
   * one are logged — see `shared/server-url.ts`.
   *
   * Memoised: the layers are process-level or restart-level, and `status()` is
   * polled by the TUI, so re-reading (and re-logging) them on every call would
   * be noise. A configuration change still needs an OpenCode restart, exactly
   * like `options.*` itself.
   */
  #resolveServerUrl(): Promise<ServerUrlResolution> {
    this.#serverUrlTask ??= locateServerUrl({
      optionUrl: this.#optionServerUrl,
      env: this.#env,
      logger: this.#logger,
      ...(this.#serverUrlFiles !== undefined ? { files: this.#serverUrlFiles } : {}),
      ...(this.#readText !== undefined ? { readText: this.#readText } : {}),
      ...(this.#platform !== undefined ? { platform: this.#platform } : {}),
    })
    return this.#serverUrlTask
  }

  // ── status ──────────────────────────────────────────────────────────────────

  async status(): Promise<OnboardingStatus> {
    const dataDir = this.dataDir
    const settings = await readSettings(dataDir)
    const account = await readAccount(dataDir)
    const binding =
      account !== null ? await readBinding(dataDir, account.apiBaseUrl, account.userId) : null
    const resolved = await this.#resolveServerUrl()
    const apiBaseUrl = account?.apiBaseUrl ?? resolved.url ?? settings?.apiBaseUrl ?? null
    const status: OnboardingStatus = {
      configured: settings !== null,
      apiBaseUrl,
      loggedIn: accountIsUsable(account, this.#now()),
      accountExpiresAt: account?.expiresAt ?? null,
      userId: account?.userId ?? null,
      displayName: account?.displayName ?? null,
      connectorId: binding?.connectorId ?? null,
      connectorRunning: this.supervisor.running,
      credentialProblem: this.#credentialProblem,
    }
    // Only a resolver layer has a "source"; a stored account carries its own origin.
    if (account === null && resolved.url !== null) status.apiBaseUrlSource = resolved.source
    return status
  }

  // ── reuse-first connect ─────────────────────────────────────────────────────

  /**
   * Attempt a *zero-login* connection. Returns `needs_login` (not an error) when
   * there is nothing usable on disk — the caller decides whether to prompt.
   */
  async resume(): Promise<ConnectionStage> {
    const dataDir = this.dataDir
    let settings: PluginSettings | null
    let account: AccountCredential | null
    try {
      settings = await readSettings(dataDir)
      account = await readAccount(dataDir)
    } catch (error) {
      return { stage: 'disabled', reason: `credential store unreadable: ${errorName(error)}` }
    }
    if (!accountIsUsable(account, this.#now())) {
      // §4.2 housekeeping: a loopback flow's listener dies with the old process,
      // so a stale `pending-flow.json` is swept here rather than resumed blindly.
      const pending = await readPendingFlow(dataDir).catch(() => null)
      if (pending !== null && !pendingFlowIsLive(pending, this.#now())) {
        await clearPendingFlow(dataDir).catch(() => undefined)
      }
      return {
        stage: 'needs_login',
        apiBaseUrl: (await this.#resolveServerUrl()).url ?? settings?.apiBaseUrl ?? null,
        reason: account === null ? 'no stored account' : 'the stored access token is expired',
      }
    }
    const binding = await readBinding(dataDir, account.apiBaseUrl, account.userId)
    if (binding === null) {
      return { stage: 'needs_login', apiBaseUrl: account.apiBaseUrl, reason: 'no device binding yet' }
    }
    // The stored credential is verified — and healed if the server rejected it —
    // before any Connector is allowed to use it. This is the fix for the
    // real-machine "local token ≠ server token → 401 → forever offline" loop:
    // previously this path never asked the server about the device token at all.
    let usable = binding
    try {
      usable = await this.#ensureBinding(this.#client(account.apiBaseUrl), account)
    } catch (error) {
      if (isStatus(error, 401)) {
        return {
          stage: 'needs_login',
          apiBaseUrl: account.apiBaseUrl,
          reason: '账号凭据已被服务端拒绝（需要重新登录）',
        }
      }
      // A network/server failure is not a bad credential: keep the stored one
      // (the Connector retries on its own) but say it could not be verified.
      this.#logger.warn(
        '连接前无法校验/修复设备凭据，先用本地凭据启动 Connector（若之后收到 401，日志与 login.json 会给出下一步）',
        { error: errorName(error) },
      )
    }
    try {
      const reused = await this.#startConnector(account, usable, true)
      return {
        stage: 'connected',
        apiBaseUrl: account.apiBaseUrl,
        userId: account.userId,
        connectorId: usable.connectorId,
        reusedDevice: reused,
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'connector_already_running') {
        // Another host already owns the machine-wide lease: the connection is
        // live, we simply do not own the child. Not an error.
        return {
          stage: 'connected',
          apiBaseUrl: account.apiBaseUrl,
          userId: account.userId,
          connectorId: usable.connectorId,
          reusedDevice: true,
        }
      }
      return {
        stage: 'needs_login',
        apiBaseUrl: account.apiBaseUrl,
        reason: `connector failed to start: ${errorName(error)}`,
      }
    }
  }

  // ── interactive login ───────────────────────────────────────────────────────

  async login(options: LoginOptions = {}): Promise<LoginOutcome> {
    const dataDir = this.dataDir
    this.#lastLoginKind = options.headless === true ? 'device' : 'loopback'
    const settings = await readSettings(dataDir)
    const apiBaseUrl =
      options.apiBaseUrl ?? (await this.#resolveServerUrl()).url ?? settings?.apiBaseUrl ?? null
    if (apiBaseUrl === null) {
      // Actionable on purpose: the user has nothing to copy here, so the message
      // has to name every way to set an address and where it is documented.
      return {
        ok: false,
        code: 'not_configured',
        message:
          '尚未配置服务器地址（插件配置、环境变量与本机的 Connector / Desktop 记录都没有可用的 serverUrl）。' +
          '怎么设置：在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，' +
          `或设置环境变量 ${SERVER_URL_ENV}，或先让 AA Desktop 完成一次连接；` +
          '详见 opencode-plugin/README.md「账号接入（P4）」一节。',
      }
    }
    const client = this.#client(apiBaseUrl)
    let tokens: { accessToken: string; expiresIn: number }
    try {
      tokens =
        options.headless === true
          ? await runDeviceLogin({
              client,
              onCode: options.onCode ?? (() => undefined),
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
              ...(options.pollSleep !== undefined ? { sleep: options.pollSleep } : {}),
            })
          : await this.#loopbackLogin(client, apiBaseUrl, options)
    } catch (error) {
      await clearPendingFlow(dataDir).catch(() => undefined)
      return { ok: false, code: errorCode(error), message: errorMessage(error) }
    }

    let profile: AccountProfile
    try {
      profile = await client.me(tokens.accessToken, options.signal)
    } catch (error) {
      return { ok: false, code: 'profile_failed', message: errorMessage(error) }
    }

    const account: AccountCredential = {
      version: 1,
      apiBaseUrl,
      userId: profile.userId,
      displayName: profile.displayName,
      email: profile.email,
      accessToken: tokens.accessToken,
      expiresAt: this.#now() + tokens.expiresIn * 1_000,
    }
    await saveAccount(dataDir, account)
    await clearPendingFlow(dataDir).catch(() => undefined)

    let binding: BindingCredential
    try {
      binding = await this.#ensureBinding(client, account)
    } catch (error) {
      return { ok: false, code: 'device_failed', message: errorMessage(error) }
    }
    try {
      const reused = await this.#startConnector(account, binding, false)
      return {
        ok: true,
        stage: {
          stage: 'connected',
          apiBaseUrl,
          userId: account.userId,
          connectorId: binding.connectorId,
          reusedDevice: reused,
        },
      }
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === 'connector_already_running') {
        return {
          ok: true,
          stage: { stage: 'connected', apiBaseUrl, userId: account.userId, connectorId: binding.connectorId, reusedDevice: true },
        }
      }
      return { ok: false, code: 'connector_failed', message: errorMessage(error) }
    }
  }

  /**
   * Logout, in the only safe order: **revoke on the server → clear local → stop
   * the Connector**. A revoke failure stops the sequence rather than deleting a
   * credential that is still live.
   */
  async logout(): Promise<void> {
    const dataDir = this.dataDir
    const account = await readAccount(dataDir)
    if (account !== null) {
      const binding = await readBinding(dataDir, account.apiBaseUrl, account.userId)
      if (binding !== null) {
        try {
          await this.#client(account.apiBaseUrl).revokeConnector(account.accessToken, binding.connectorId)
        } catch (error) {
          // 404 means the device is already gone, which is the desired end state.
          if (!(error instanceof Error && 'status' in error && (error as { status?: unknown }).status === 404)) {
            await this.supervisor.stop().catch(() => undefined)
            throw new Error(`撤销设备凭据失败，未清理本地凭据：${errorMessage(error)}`)
          }
        }
      }
    }
    await this.supervisor.stop().catch(() => undefined)
    if (account !== null) {
      await clearBinding(dataDir, account.apiBaseUrl, account.userId)
      await clearPendingRegistration(dataDir, account.apiBaseUrl, account.userId).catch(() => undefined)
    }
    await clearAccount(dataDir)
    await clearPendingFlow(dataDir).catch(() => undefined)
    this.#lastAccount = null
    this.#lastBinding = null
    this.#credentialProblem = null
    this.#authHealAttempts = 0
  }

  // ── internals ───────────────────────────────────────────────────────────────

  async #loopbackLogin(
    client: AccountClient,
    apiBaseUrl: string,
    options: LoginOptions,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const dataDir = this.dataDir
    let settle: { resolve: (value: { accessToken: string; expiresIn: number }) => void; reject: (error: Error) => void } | null = null
    const result = new Promise<{ accessToken: string; expiresIn: number }>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const flow = new LoopbackOAuthFlow({
      // Design §5.1: the Web/OAuth origin is derived from the server address —
      // loopback `8000` → Web `5174`, remote = same-origin. `apiBaseUrl` is
      // already normalised above, so the fallback is unreachable.
      webOrigin: webOrigin(apiBaseUrl) ?? apiBaseUrl,
      logger: this.#logger,
      onAuthorized: (code, { verifier, redirectUri }) => {
        void client
          .exchangeAuthorizationCode({ code, verifier, redirectUri, ...(options.signal !== undefined ? { signal: options.signal } : {}) })
          .then((token) => settle?.resolve(token))
          .catch((error: unknown) => settle?.reject(toError(error)))
      },
      onFailed: (error) => settle?.reject(error),
    })
    let started: LoopbackStart
    try {
      started = await flow.start()
    } catch (error) {
      // A listener that cannot bind is the one failure the caller may answer
      // with the device flow (see `auto-login.ts`); anything else keeps its own
      // error so a real bug is never disguised as "no browser".
      throw new LoopbackFlowError(
        LOOPBACK_UNAVAILABLE_CODE,
        `回环登录监听无法启动：${errorMessage(error)}`,
      )
    }
    // Persist the non-secret flow record so a hot reload can see it was in flight.
    await savePendingFlow(dataDir, {
      version: 1,
      apiBaseUrl,
      state: started.state,
      verifier: flow.verifier,
      redirectUri: started.redirectUri,
      createdAt: this.#now(),
      deadline: started.deadline,
    }).catch(() => undefined)
    // The user's to-do line (log + `login.json`) is written here, before the
    // browser is launched, so a browser that never opens still leaves the URL
    // somewhere the user can copy from. A failing writer must not fail the login.
    try {
      await options.onAuthorizationUrl?.(started.authorizationUrl, {
        deadline: started.deadline,
        redirectUri: started.redirectUri,
      })
    } catch (error) {
      this.#logger.warn('登录提示写入失败，请使用日志中的授权地址', { error: errorName(error) })
    }

    const onAbort = (): void => {
      flow.abort('login cancelled')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const opened = await this.#openUrl(started.authorizationUrl)
      if (opened === 'failed') {
        this.#logger.info('未能自动打开浏览器（fail-soft，不影响登录）：请手动复制上面的授权地址到浏览器打开。')
      }
      return await result
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      await flow.close().catch(() => undefined)
    }
  }

  /**
   * The device-credential gate: **verify → heal → (only if needed) register**.
   *
   * The whole exchange runs under a cross-process lock (see `file-lock.ts`) and
   * re-reads the binding *inside* it, so a hot reload, a second OpenCode
   * instance, or a concurrently finishing login can never interleave a
   * registration with a rotation and leave the disk holding a token the server
   * has already replaced. Registration itself persists its installation key
   * before the request (`pending.json`), so a lost response is retried against
   * the same device instead of creating a second one.
   */
  async #ensureBinding(
    client: AccountClient,
    account: AccountCredential,
  ): Promise<BindingCredential> {
    const dataDir = this.dataDir
    const lockPath = `${bindingPath(dataDir, account.apiBaseUrl, account.userId)}.lock`
    return await withFileLock(
      lockPath,
      async () => {
        const existing = await readBinding(dataDir, account.apiBaseUrl, account.userId)
        if (existing !== null) {
          const verdict = await this.#credentialVerdict(client, existing)
          if (verdict === 'valid') {
            this.#credentialProblem = null
            return existing
          }
          if (verdict === 'unknown') return existing
          this.#logger.warn('已存设备凭据被服务端拒绝（401），按服务端轮换同一设备', {
            connectorId: existing.connectorId,
          })
          const rotated = await this.#rotateBinding(client, account, existing)
          if (rotated !== null) return rotated
          // 404 from the rotate = the device row is gone. Fall through: the
          // registration below reuses the installation key (and therefore the
          // deterministic device id), so recovery still yields one device.
        }
        return await this.#registerBinding(client, account, existing)
      },
      {
        onTimeout: (waitedMs) =>
          this.#logger.warn('设备凭据锁等待超时，继续执行（多实例可能竞争，落盘仍是原子的）', {
            waitedMs,
          }),
      },
    )
  }

  /**
   * Ask the server whether the stored device token is still current.
   * `unknown` (unreachable server, timeout, or an older server without the
   * route) must never cause a rotation — only a definitive 401/403 does.
   */
  async #credentialVerdict(
    client: AccountClient,
    binding: BindingCredential,
  ): Promise<'valid' | 'invalid' | 'unknown'> {
    try {
      return (await client.verifyConnectorToken(binding.connectorId, binding.connectorToken))
        ? 'valid'
        : 'invalid'
    } catch (error) {
      this.#logger.warn('无法校验设备凭据，按“未验证”处理（不轮换）', {
        error: errorName(error),
        connectorId: binding.connectorId,
      })
      return 'unknown'
    }
  }

  /** Rotate the token of the **same** device; `null` when the device row is gone. */
  async #rotateBinding(
    client: AccountClient,
    account: AccountCredential,
    existing: BindingCredential,
  ): Promise<BindingCredential | null> {
    let rotated: { device: { id: string; name: string; userId: string }; connectorToken: string }
    try {
      rotated = await client.revokeConnector(account.accessToken, existing.connectorId)
    } catch (error) {
      if (isStatus(error, 404)) return null
      throw error
    }
    if (rotated.device.userId !== account.userId) throw new Error('设备归属与当前账号不一致。')
    const binding: BindingCredential = {
      ...existing,
      connectorToken: rotated.connectorToken,
      name: rotated.device.name,
    }
    await saveBinding(this.dataDir, account.apiBaseUrl, account.userId, binding)
    this.#logger.info('设备凭据已轮换，并按服务端返回值原子落盘', {
      connectorId: binding.connectorId,
    })
    this.#credentialProblem = null
    return binding
  }

  /**
   * Register a device for this account, idempotently:
   *   - the installation key is written to `…pending.json` **before** the POST,
   *     so even a lost response can be retried without creating a second device;
   *   - an existing binding (or a pending record) supplies the key and the name;
   *   - 409 (the installation was deleted server-side, tombstone still present)
   *     retries exactly once with a fresh key — deliberately, never silently
   *     reviving a deleted identity.
   */
  async #registerBinding(
    client: AccountClient,
    account: AccountCredential,
    existing: BindingCredential | null,
  ): Promise<BindingCredential> {
    const dataDir = this.dataDir
    const pending = await readPendingRegistration(dataDir, account.apiBaseUrl, account.userId).catch(() => null)
    const name = existing?.name ?? pending?.name ?? this.#deviceName()
    let installationId = existing?.installationId ?? pending?.installationId ?? randomUUID()
    await savePendingRegistration(dataDir, account.apiBaseUrl, account.userId, {
      version: 1,
      installationId,
      name,
      createdAt: this.#now(),
    })
    try {
      return await this.#registerOnce(client, account, name, installationId)
    } catch (error) {
      if (!isStatus(error, 409)) throw error
      // The server still holds a tombstone for this key: a fresh one is the only
      // way forward, and it is explicit rather than a silent second device.
      installationId = randomUUID()
      await savePendingRegistration(dataDir, account.apiBaseUrl, account.userId, {
        version: 1,
        installationId,
        name,
        createdAt: this.#now(),
      })
      return await this.#registerOnce(client, account, name, installationId)
    }
  }

  async #registerOnce(
    client: AccountClient,
    account: AccountCredential,
    name: string,
    installationId: string,
  ): Promise<BindingCredential> {
    const created = await client.registerConnector(account.accessToken, { name, installationId })
    if (created.device.userId !== account.userId) throw new Error('注册设备的账号不一致。')
    const binding: BindingCredential = {
      version: 1,
      connectorId: created.device.id,
      connectorToken: created.connectorToken,
      name: created.device.name,
      installationId,
    }
    // The server's response is the only authority for what is saved, and the
    // write is atomic; the pending key disappears only once the credential is.
    await saveBinding(this.dataDir, account.apiBaseUrl, account.userId, binding)
    await clearPendingRegistration(this.dataDir, account.apiBaseUrl, account.userId).catch(() => undefined)
    this.#logger.info('设备已注册，凭据按服务端返回值原子落盘', { connectorId: binding.connectorId })
    this.#credentialProblem = null
    return binding
  }

  /**
   * The 401 must never stay a silent `offline`: log the actionable sentence,
   * write it to `login.json`, expose it in `status()`, and attempt one bounded
   * automatic repair (rotate/register + restart the Connector with the new
   * token). After `MAX_AUTH_HEAL_ATTEMPTS` the plugin only reports.
   */
  #handleSupervisorState(state: SupervisorState): void {
    if (!state.authFailed) return
    const problem = credentialRejectedInstruction()
    this.#credentialProblem = problem
    this.#logger.warn(problem, { connectorId: this.#lastBinding?.connectorId ?? null })
    void this.#recordCredentialFailure(problem)
    if (this.#authHealRunning || this.#authHealAttempts >= MAX_AUTH_HEAL_ATTEMPTS) return
    this.#authHealRunning = true
    void this.#healAfterAuthFailure()
      .catch((error: unknown) => {
        this.#logger.warn('自动修复设备凭据失败，连接保持离线（见 login.json 的下一步）', {
          error: errorName(error),
        })
      })
      .finally(() => {
        this.#authHealRunning = false
      })
  }

  async #recordCredentialFailure(problem: string): Promise<void> {
    const now = this.#now()
    await writeLoginPrompt(this.dataDir, {
      version: LOGIN_PROMPT_VERSION,
      status: 'failed',
      kind: this.#lastLoginKind,
      createdAt: now,
      expiresAt: now,
      instruction: problem,
    }).catch(() => undefined)
  }

  async #healAfterAuthFailure(): Promise<void> {
    const account = this.#lastAccount
    if (account === null) return
    this.#authHealAttempts += 1
    const before = this.#lastBinding
    const healed = await this.#ensureBinding(this.#client(account.apiBaseUrl), account)
    const changed =
      before === null ||
      healed.connectorToken !== before.connectorToken ||
      healed.connectorId !== before.connectorId
    if (!changed) {
      this.#logger.warn('自动修复后凭据未变化，401 仍在；请运行 /aa-login 重新登录')
      return
    }
    this.#lastBinding = healed
    this.#credentialProblem = null
    await this.#recordCredentialRecovered()
    this.#logger.info('设备凭据已自动修复，正在用新凭据重启 Connector', {
      connectorId: healed.connectorId,
    })
    await this.supervisor.start({
      apiBaseUrl: account.apiBaseUrl,
      connectorId: healed.connectorId,
      connectorToken: healed.connectorToken,
      dataDir: join(this.dataDir, 'connector'),
    })
  }

  /** Replace the failure record once the automatic repair actually succeeded. */
  async #recordCredentialRecovered(): Promise<void> {
    const now = this.#now()
    await writeLoginPrompt(this.dataDir, {
      version: LOGIN_PROMPT_VERSION,
      status: 'connected',
      kind: this.#lastLoginKind,
      createdAt: now,
      expiresAt: now,
      instruction: '设备凭据已自动修复并已用新凭据重启 Connector，无需其他操作。',
    }).catch(() => undefined)
  }

  /**
   * The device token baked into `connector/connector.json` — i.e. what the
   * running/adopted Connector tree was launched with. `null` when the file is
   * missing, belongs to another device, or is unreadable: an uncertain
   * comparison must never stop a healthy child.
   */
  async #connectorConfigToken(connectorDir: string, connectorId: string): Promise<string | null> {
    const value = await readJsonFile<{ connectorId?: unknown; connectorToken?: unknown }>(
      join(connectorDir, 'connector.json'),
    ).catch(() => null)
    if (value === null || value.connectorId !== connectorId) return null
    return typeof value.connectorToken === 'string' && value.connectorToken.length > 0
      ? value.connectorToken
      : null
  }

  async #startConnector(
    account: AccountCredential,
    binding: BindingCredential,
    _resume: boolean,
  ): Promise<boolean> {
    // The heal path's context: a later 401 can only be repaired when we still
    // know which account the failed credential belonged to.
    this.#lastAccount = account
    this.#lastBinding = binding
    const connectorDir = join(this.dataDir, 'connector')
    // Spawn idempotency, layer 1: a Connector *we* started — this process, a
    // previous hot reload, or an earlier OpenCode run — is adopted, not
    // duplicated. The shared lease record cannot answer this (it names the
    // Desktop/DSH holder), which is the real-machine duplicate's root cause.
    const own = await probeOwnConnector({ dataDir: connectorDir, connectorId: binding.connectorId }).catch(
      (): OwnConnectorProbe => ({ own: false, pid: null, reason: '自己的 Connector 记录读取失败，按未运行处理' }),
    )
    if (own.own) {
      const configToken = await this.#connectorConfigToken(connectorDir, binding.connectorId)
      if (configToken === null || configToken === binding.connectorToken) {
        this.#logger.info('本插件启动的 Connector 已在运行，复用而不重复 spawn', { pid: own.pid, reason: own.reason })
        return true
      }
      // The adopted child was launched with a token the binding no longer has
      // (repaired in a later run, or rotated elsewhere while it kept running):
      // it is guaranteed to be answering 401. Stop *our own* recorded orphan and
      // fall through, so the Connector is started with the current credential.
      this.#logger.warn('本插件启动的 Connector 仍在使用旧设备凭据（会 401），先停止并改用当前凭据重启', {
        pid: own.pid,
      })
      if (own.pid !== null) this.#stopOwnConnector(own.pid)
      await clearOwnChild(connectorDir, own.pid ?? undefined).catch(() => undefined)
    }
    // Spawn idempotency, layer 2: a *live* foreign lease means our own spawn is
    // known-doomed (control.py refuses `start` with connector_already_running).
    // Skip it instead of forking another uv tree on every setup.
    const foreign = await probeForeignBlock({ dataDir: connectorDir, connectorId: binding.connectorId }).catch(
      (): ForeignBlockProbe => ({ blocked: false, kind: null, pid: null, reason: '占用记录读取失败，按可重试处理' }),
    )
    if (foreign.blocked) {
      this.#logger.warn('本机 Connector 租约仍被其它来源占用，跳过 spawn（重复 spawn 只会失败）', {
        kind: foreign.kind,
        pid: foreign.pid,
        reason: foreign.reason,
      })
      return true
    }
    const probe = await this.#probeConnector(binding.connectorId).catch(
      (): ExistingConnectorProbe => ({ decision: 'none', reason: '探测失败，按新建处理', kind: null, pid: null }),
    )
    let ownConnector = false
    if (probe.decision === 'reuse') {
      const gate = await this.#reuseGate(account, binding.connectorId)
      if (gate.reuse) {
        // User decision: reuse the Connector already running on this machine and
        // never spawn a second one. There is nothing to own, so no child is made.
        this.#logger.info('复用本机已有的 Connector，跳过 spawn', {
          reason: probe.reason,
          pid: probe.pid,
          kind: probe.kind,
          capability: gate.reason,
        })
        return true
      }
      // The running Connector does not know `opencode` (or we could not tell):
      // reusing it would connect us with no usable runtime, so we start our own.
      ownConnector = true
      this.#logger.warn(gate.reason)
    } else if (probe.decision === 'occupied') {
      // A live machine-wide lease held by another host/device. The spawn below
      // will be refused with `connector_already_running` and `#spawnAndRecord`
      // records the holder, so *this* attempt is allowed to discover the truth
      // while every later setup short-circuits on the `foreign.blocked` check.
      this.#logger.warn('本机 Connector 已被其它来源占用，尝试复用其连接而非新建', {
        reason: probe.reason,
        pid: probe.pid,
        kind: probe.kind,
      })
    } else {
      this.#logger.info('本机无可复用 Connector，新建一个', { reason: probe.reason })
    }
    const config: ConnectorSpawnConfig = {
      apiBaseUrl: account.apiBaseUrl,
      connectorId: binding.connectorId,
      connectorToken: binding.connectorToken,
      dataDir: join(this.dataDir, 'connector'),
    }
    return await this.#spawnAndRecord(config, binding.connectorId, ownConnector)
  }

  /**
   * `{reuse:false}` carries the **actionable reason we are not reusing**, so the
   * caller can log it verbatim (why + what to do about it).
   */
  async #reuseGate(
    account: AccountCredential,
    connectorId: string,
  ): Promise<{ reuse: boolean; reason: string }> {
    if (this.#forceReuseConnector) {
      this.#logger.info('强制复用已启用（forceReuseConnector），跳过能力判定', { connectorId })
      return { reuse: true, reason: '显式配置要求复用' }
    }
    const capability = await this.#probeConnectorCapability({ account, connectorId }).catch(
      (): ConnectorCapability =>
        judgeConnectorCapability({ runtimeTypes: null, error: '能力判定探测本身抛出异常' }),
    )
    if (capability.verdict === 'reuse') return { reuse: true, reason: capability.reason }
    return {
      reuse: false,
      reason:
        `不复用本机已有的 Connector：${capability.reason}。` +
        `下一步：改用本插件自带的 Connector（解析顺序：包内 ${BUNDLED_CONNECTOR_SUBDIR} → 同级 connector/）；` +
        '若确认那个 Connector 就是可用版本，可设置 options.forceReuseConnector = true（或 ' +
        `${FORCE_REUSE_CONNECTOR_ENV}=1）强制复用。`,
    }
  }

  async #spawnAndRecord(
    config: ConnectorSpawnConfig,
    connectorId: string,
    ownConnector = false,
  ): Promise<boolean> {
    // §5.1 step 2: if the shared Connector record already lists this device, a
    // Connector for it exists on this machine — we are reusing its identity, not
    // creating a second device. When the capability gate sent us here on purpose
    // (`ownConnector`), reporting a reuse would contradict the reason we spawned.
    const runtime = ownConnector ? null : await readConnectorRuntime(this.#env).catch(() => null)
    const reused = runtimeMentionsConnector(runtime, connectorId)
    await this.supervisor.prepare()
    try {
      await this.supervisor.start(config)
    } catch (error) {
      // The machine-wide lease is held by another host: remember the holder so
      // the next setup short-circuits (the early `foreign.blocked` check) rather
      // than repeating a spawn that can only fail.
      if (error instanceof ConnectorOwnershipError || (error as { code?: unknown }).code === 'connector_already_running') {
        const owner = error instanceof ConnectorOwnershipError ? error.owner : { kind: null, pid: null }
        await setBlocked(join(this.dataDir, 'connector'), {
          kind: owner.kind,
          pid: owner.pid,
          connectorId,
          at: Date.now(),
        }).catch(() => undefined)
      }
      throw error
    }
    return reused
  }

  #client(apiBaseUrl: string): AccountClient {
    return new AccountClient({
      apiBaseUrl,
      ...(this.#fetcher !== undefined ? { fetcher: this.#fetcher } : {}),
    })
  }
}

function defaultDeviceName(): string {
  const host = hostname()
  return host.length > 0 ? `OpenCode (${host})` : 'OpenCode'
}

/**
 * Wrap an injected opener so a rejecting implementation is fail-soft too: the
 * three login paths must behave identically whether the real launcher or a test
 * double is in place.
 */
function wrapOpener(opener: (url: string) => Promise<void> | void): (url: string) => Promise<BrowserOpenResult> {
  return async (url) => {
    try {
      await opener(url)
      return 'opened'
    } catch {
      return 'failed'
    }
  }
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof Error && 'status' in error && (error as { status?: unknown }).status === status
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'login_failed'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** The supervisor state shape, re-exported so callers need one import. */
export type { SupervisorState }

/** Process-wide onboarding handle, adopted across hot reloads like the Hub. */
export const ONBOARDING_GLOBAL_KEY = 'agents-anywhere.opencode.onboarding'

/**
 * Adopt the process-wide `Onboarding`. A hot reload (or a second location's
 * `setup()`) must reuse the existing supervisor: spawning a second Connector
 * would only burn a `uv` process against the machine-wide OS lease.
 */
export function installOnboarding(options: OnboardingOptions = {}): Onboarding {
  const key = Symbol.for(ONBOARDING_GLOBAL_KEY)
  const globals = globalThis as unknown as Record<symbol, unknown>
  const existing = globals[key]
  // NOT `instanceof Onboarding`: a hot reload (or a second bundle) re-evaluates
  // this module, giving the previous instance a *different* class identity, so
  // `instanceof` would be false and a second supervisor would spawn a second
  // Connector. A structural check survives the reload.
  if (isOnboardingLike(existing)) return existing
  const created = new Onboarding(options)
  globals[key] = created
  return created
}

/** Does `value` already carry the singleton surface, whatever its class identity? */
function isOnboardingLike(value: unknown): value is Onboarding {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { resume?: unknown; status?: unknown; supervisor?: unknown }
  return (
    typeof candidate.resume === 'function' &&
    typeof candidate.status === 'function' &&
    'supervisor' in candidate
  )
}
