/**
 * OpenCode **TUI** plugin entry point — a **status surface**, not a command surface.
 *
 * Measured against opencode-cli **2.0.18** (A10 PTY probe:
 * `.git/opencode-team/20260926-213919/opencode-tui-pty/01-implementer-tui-pty-verification.md`):
 *
 * - The **full** TUI (`opencode`, bare/`--standalone`) DOES evaluate this module and
 *   call `setup()` (`module-evaluated` + `setup-called` in `tui-probe.log`, §3).
 * - `opencode mini` does **NOT** load the TUI plugin at all (§3: probe log empty).
 * - The module shape the host validator accepts is ONLY `{ id: string, setup: fn }` (§A10).
 * - The real TUI context exposes 13 top-level keys (§4):
 *   `options, location, app, renderer, client, data, attention, theme,
 *    themeMode, markdown, keymap, storage, ui`.
 *
 * Surfaces we therefore use — every one probed, never assumed:
 *   - `ui.toast`         → user-visible status text (§4: `ui` = dialog, toast,
 *                          format, router, panel, tabs, model, slot).
 *   - `attention.notify` → optional desktop ping (§4: `attention` = notify, dispose).
 *   - `keymap.layer`     → the ONLY member that *could* carry a command layer
 *                          (§4: `keymap` = layer, dispatch, shortcuts, commands,
 *                          pending, active, mode). Its writability and exact
 *                          argument shape are **UNVERIFIED on a real terminal**;
 *                          the call is guarded and any failure degrades silently
 *                          to `'none'` (see `registerCommandLayer`).
 *   - `client.session.list` → the session-index side channel (unchanged; its own
 *                          file documents why it is the only parent/child source).
 *   - `login.json`       → polled on a timer (`startLoginStateWatcher`) so a login
 *                          started on the *server* side is visible here too: each
 *                          state change becomes one actionable toast (defect ②).
 *                          No host surface is required for this and none is
 *                          disturbed (the timer is unref'd and stopped on dispose).
 *
 * Surfaces we deliberately do NOT touch (measured absent, or JSX-only):
 *   - `keymap.registerLayer` and `command.register` — the previous calls were
 *     **silent no-ops**: `keymap` has no `registerLayer`, and there is **no
 *     `command` key at all** in the real context (§4). Both calls are removed.
 *   - `ui.DialogAlert` / `ui.DialogPrompt` / `ui.dialog.replace` — **not** in the
 *     real `ui` member set (§4), so no dialog path exists here any more.
 *   - `route` / `slots` / `lifecycle` / `kv` — absent from the real context (§4);
 *     `lifecycle.onDispose` is unnecessary because the host calls the dispose
 *     handle `setup()` returns (p0/01 §6: hot reload replays `setup()` and calls
 *     the old instance's cleanup).
 *   - `markdown.registerCodeBlockRenderer` / `ui.slot` / `ui.panel` — present but
 *     **JSX-only**: authoring them needs a JSX runtime this zero-dependency module
 *     does not ship. Reported by `describeSurfaces`, never registered.
 *
 * NOT DONE (cannot be faked without dependencies — listed, not hidden):
 *   - JSX panels/slots and the markdown code-block renderer.
 *   - A `/aa` slash command: on 2.0.18 there is **no command-registration surface**
 *     (§5: the `/` palette lists only built-ins; `/aa` never appears), so no such
 *     command exists for the user. Login's primary triggers live on the **server
 *     side** — the `/aa-login` command and the missing-credential auto-trigger —
 *     and this module only *tells* the user to run that command.
 *
 * `setup()` never throws: a context missing every surface still returns a working
 * dispose handle, and the host's plugin chain is never disturbed.
 */

import { pluginDataDir } from '../shared/credentials.js'
import { createLogger, type Logger } from '../shared/logger.js'
import { loginPromptPath, readLoginPrompt, type LoginPrompt } from '../shared/login-prompt.js'
import { SERVER_URL_SOURCE_LABEL } from '../shared/server-url.js'
import {
  collectIndexedSessions,
  SESSION_INDEX_WRITE_INTERVAL_MS,
  writeSessionIndex,
} from '../shared/session-index.js'
import { Onboarding, type LoginOutcome, type OnboardingStatus } from '../server/onboarding.js'
import type { DeviceCodeNotice } from '../server/device-login.js'

/** Cleanup returned by `setup`, mirroring the host's `TuiDispose`. */
export type TuiDispose = () => void | Promise<void>

/**
 * The V2 TUI module shape the host accepts. `id` and `setup` are the only two
 * members the validator checks; extra members are ignored.
 */
export interface TuiPluginModule {
  id: string
  setup: (context: unknown) => TuiDispose | Promise<TuiDispose>
}

export const id = 'agents-anywhere-opencode'

const PLUGIN_LABEL = 'Agents Anywhere'

/** The server-side command that actually starts login (this module cannot register one). */
const LOGIN_COMMAND = '/aa-login'

// ── structural view of the host API (only what the A10 probe measured) ────────

export interface TuiToast {
  variant?: 'info' | 'success' | 'warning' | 'error'
  title?: string
  message: string
  duration?: number
}

interface TuiCommandDescriptor {
  title: string
  value: string
  description?: string
  category?: string
  slash?: { name: string; aliases?: string[] }
  onSelect?: () => void | Promise<void>
}

/** The argument we hand to `keymap.layer` — its true shape is unverified (§4). */
interface TuiKeymapLayer {
  id: string
  commands: TuiCommandDescriptor[]
}

interface TuiApi {
  app?: { version?: string; channel?: string }
  ui?: {
    toast?: (input: TuiToast) => void
    /** Present on the real context but JSX-rendered: reported, never used. */
    slot?: unknown
    panel?: unknown
  }
  attention?: { notify?: (input: { title?: string; message: string; sound?: unknown }) => unknown }
  /** The only member that could carry a command layer (§4); unverified writability. */
  keymap?: { layer?: (layer: TuiKeymapLayer) => unknown }
  /**
   * The host SDK client (`TuiPluginApi.client`). The session *list* is the only
   * parent/child channel the runtime exposes (spike 02 §3.1–§3.3). Typed
   * structurally because this module stays dependency-free; probed before use.
   */
  client?: {
    session?: {
      list?: (parameters?: { roots?: boolean }) => Promise<unknown> | unknown
    }
  }
  /** Present on some hosts only; JSX-only, reported by `describeSurfaces`. */
  markdown?: { registerCodeBlockRenderer?: (renderer: unknown) => unknown }
  route?: { register?: (routes: unknown[]) => unknown }
  slots?: { register?: (plugin: unknown) => unknown }
}

export type CommandRegistrationMode = 'keymap' | 'none'

/** What the live context actually offers us (A10 §4 checklist). */
export interface TuiSurfaceReport {
  /** Surfaces this module can call on the live host. */
  usable: string[]
  /** Surfaces that exist but need a JSX runtime this module does not ship. */
  jsxOnly: string[]
}

/** One active Onboarding per host API instance (hot reload creates a new api). */
const instances = new WeakMap<object, Onboarding>()

function onboardingFor(api: TuiApi): Onboarding {
  const existing = instances.get(api as object)
  if (existing !== undefined) return existing
  const created = new Onboarding({ logger: createLogger('tui') })
  instances.set(api as object, created)
  return created
}

/**
 * Probe which surfaces the live context exposes. `usable` are the members we may
 * call; `jsxOnly` are members that exist yet require a JSX renderer this
 * zero-dependency module cannot author. Exported so tests and the A10 self-check
 * log can see the *real* surface (A10 measured `ui` + `attention` usable, with no
 * command surface at all).
 */
export function describeSurfaces(api: TuiApi): TuiSurfaceReport {
  const usable: string[] = []
  if (typeof api.ui?.toast === 'function') usable.push('ui.toast')
  if (typeof api.attention?.notify === 'function') usable.push('attention.notify')
  if (typeof api.keymap?.layer === 'function') usable.push('keymap.layer')

  const jsxOnly: string[] = []
  if (typeof api.ui?.slot !== 'undefined') jsxOnly.push('ui.slot')
  if (typeof api.ui?.panel !== 'undefined') jsxOnly.push('ui.panel')
  if (typeof api.markdown?.registerCodeBlockRenderer === 'function') {
    jsxOnly.push('markdown.registerCodeBlockRenderer')
  }
  if (typeof api.route?.register === 'function') jsxOnly.push('route')
  if (typeof api.slots?.register === 'function') jsxOnly.push('slots')
  return { usable, jsxOnly }
}

/**
 * Publish the session index once from the host client.
 *
 * `session.list({ roots: false })` asks for **all** sessions (a root-only list
 * would hide exactly the children we need). Only what the client actually
 * returned is written: a `parentID` the runtime did not send is never invented,
 * and an unrecognised payload shape leaves the previous index untouched rather
 * than clobbering it with an empty list. Returns whether a snapshot was written;
 * never throws.
 */
export async function publishSessionIndexOnce(
  api: TuiApi,
  options: { path?: string } = {},
): Promise<boolean> {
  const sessionApi = api.client?.session
  const list = sessionApi?.list
  if (sessionApi === undefined || typeof list !== 'function') return false
  let payload: unknown
  try {
    // `.call` keeps the client method's own `this` (it is a prototype method).
    payload = await list.call(sessionApi, { roots: false })
  } catch {
    // A failed enumeration is not an error: keep whatever the Hub already has.
    return false
  }
  const sessions = collectIndexedSessions(payload)
  if (sessions === null) return false
  return writeSessionIndex(sessions, options.path !== undefined ? { path: options.path } : {})
}

/**
 * Keep the session index fresh while the TUI is loaded: publish once at
 * `setup`, then on an interval. Returns the **async** stop handle the host
 * dispose awaits.
 *
 * Stopping is a two-step contract: `stop()` first blocks new ticks (`stopped` +
 * `clearInterval`), then **drains every publish already in flight**. Once
 * `await stop()` resolves no further write can land. Without the drain a
 * publish that started just before dispose could rename its file into place
 * *after* the caller removed the bridge directory — and because
 * `writeSessionIndexFile` does `mkdir … { recursive: true }`, that late write
 * **re-creates** the directory (a Windows `ENOTEMPTY rmdir`, or a silent
 * leftover).
 *
 * The host may not expose a client at all (headless / different context), in
 * which case this is a no-op. The timer is unref'd so the command surface never
 * holds the host process open on its own.
 */
export function startSessionIndexWriter(
  api: TuiApi,
  options: { path?: string; intervalMs?: number; logger?: Logger } = {},
): () => Promise<void> {
  if (typeof api.client?.session?.list !== 'function') return async () => undefined
  let stopped = false
  // `setInterval` can fire while a slow publish is still running, so a single
  // slot would lose one; this set is the exact in-flight accounting the drain
  // needs.
  const inFlight = new Set<Promise<void>>()
  const tick = (): void => {
    if (stopped) return
    const run = publishSessionIndexOnce(
      api,
      options.path !== undefined ? { path: options.path } : {},
    )
      .then(() => undefined)
      .catch(() => undefined)
    inFlight.add(run)
    void run.finally(() => {
      inFlight.delete(run)
    })
  }
  tick()
  const timer = setInterval(tick, options.intervalMs ?? SESSION_INDEX_WRITE_INTERVAL_MS)
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }
  options.logger?.debug('session index writer started', { intervalMs: options.intervalMs })
  return async () => {
    stopped = true
    clearInterval(timer)
    // No new tick can start after `stopped = true` (single-threaded, and `tick`
    // guards on it), so draining the current set to empty is enough. The loop
    // re-checks because a `finally` may not have removed an entry yet.
    while (inFlight.size > 0) {
      await Promise.all([...inFlight])
    }
  }
}

/**
 * Try to register the `/aa` command family on the **only** member that could
 * carry it — `keymap.layer` (A10 §4; `registerLayer` and the `command` domain do
 * not exist on 2.0.18, so those calls were removed). `keymap.layer`'s writability
 * and argument shape are unverified on a real terminal, so a missing member, a
 * wrong shape, or a throw all degrade **silently** to `'none'` — the caller logs
 * it, and the host is never disturbed.
 */
export function registerCommandLayer(
  api: TuiApi,
  commands: TuiCommandDescriptor[],
): CommandRegistrationMode {
  const layer = api.keymap?.layer
  if (typeof layer !== 'function') return 'none'
  try {
    layer({ id, commands })
    return 'keymap'
  } catch {
    return 'none'
  }
}

/** Build the `/aa` command descriptors (exported for shape tests). */
export function aaCommands(api: TuiApi): TuiCommandDescriptor[] {
  const run = (sub: string) => (): Promise<void> => dispatch(api, sub)
  return [
    {
      title: `${PLUGIN_LABEL}：状态`,
      value: 'agents-anywhere.status',
      description: '查看登录状态与本机设备连接',
      category: PLUGIN_LABEL,
      slash: { name: 'aa', aliases: ['agents-anywhere'] },
      onSelect: run('status'),
    },
    {
      title: `${PLUGIN_LABEL}：登录`,
      value: 'agents-anywhere.login',
      description: '打开浏览器完成账号授权并连接本机设备',
      category: PLUGIN_LABEL,
      slash: { name: 'login', aliases: ['connect'] },
      onSelect: run('login'),
    },
    {
      title: `${PLUGIN_LABEL}：无头登录`,
      value: 'agents-anywhere.login-headless',
      description: 'SSH/无头环境：显示短码，在任意设备上批准',
      category: PLUGIN_LABEL,
      slash: { name: 'login-headless' },
      onSelect: run('login-headless'),
    },
    {
      title: `${PLUGIN_LABEL}：退出登录`,
      value: 'agents-anywhere.logout',
      description: '先撤销服务端设备凭据，再清理本地并停止 Connector',
      category: PLUGIN_LABEL,
      slash: { name: 'logout' },
      onSelect: run('logout'),
    },
  ]
}

/**
 * The one behaviour that is real on 2.0.18: an **actionable status toast**.
 * Exported so tests can await it directly (it reads the credential store).
 * Never throws.
 */
export async function announceStatus(api: TuiApi): Promise<void> {
  let status: OnboardingStatus
  try {
    status = await onboardingFor(api).status()
  } catch {
    return
  }
  const message = status.loggedIn
    ? `${PLUGIN_LABEL} 已加载：已连接账号 ${status.userId ?? '未知'}，设备 ${status.connectorId ?? '未注册'}。`
    : `${PLUGIN_LABEL} 已加载：未登录，用服务端命令 ${LOGIN_COMMAND} 连接本机。`
  toast(api, { variant: status.loggedIn ? 'success' : 'info', title: PLUGIN_LABEL, message })
}

/** How often the TUI re-reads `login.json` while it is loaded. */
export const LOGIN_WATCH_INTERVAL_MS = 2_000

export interface LoginWatchOptions {
  /** Where `login.json` lives; defaults to the plugin data dir. */
  dataDir?: string
  intervalMs?: number
  logger?: Logger
  /** Test seam: replaces the real `login.json` read. Never called with a secret. */
  readPrompt?: (dataDir: string) => Promise<LoginPrompt | null>
}

/**
 * Identity of a login state *as the user experiences it*: a re-read that
 * returns the same record must not produce a second toast (defect ②).
 */
function loginPromptSignature(prompt: LoginPrompt | null): string {
  if (prompt === null) return 'none'
  return `${prompt.status}|${prompt.kind}|${prompt.userCode ?? ''}|${prompt.createdAt}`
}

/**
 * The toast for a *transition*, or `null` when nothing user-visible changed.
 * Exported so the mapping is unit-testable without a TUI or a timer.
 */
export function loginStateToast(
  current: LoginPrompt | null,
  previous: LoginPrompt | null,
  path?: string,
): TuiToast | null {
  if (loginPromptSignature(current) === loginPromptSignature(previous)) return null
  const where = path === undefined ? '' : `\n登录文件：${path}`
  if (current === null) {
    return {
      variant: 'info',
      title: PLUGIN_LABEL,
      message: `登录状态已清除。需要连接时运行服务端命令 ${LOGIN_COMMAND}。${where}`,
    }
  }
  switch (current.status) {
    case 'pending':
      return {
        variant: 'warning',
        title: PLUGIN_LABEL,
        message:
          current.kind === 'device'
            ? `已开始无头登录：在任意设备打开 ${current.verificationUri ?? '(验证地址缺失)'} 并输入短码 ${current.userCode ?? '(短码缺失)'}。${where}`
            : `已开始登录：在浏览器打开授权地址并点一次「授权」${
                current.authorizationUrl === undefined ? '' : `：${current.authorizationUrl}`
              }${where}`,
        duration: 60_000,
      }
    case 'connected':
      return { variant: 'success', title: PLUGIN_LABEL, message: `登录成功：账号与本机设备已连接。${where}` }
    case 'failed':
      return {
        variant: 'error',
        title: PLUGIN_LABEL,
        message: `登录未完成：${current.instruction}\n下一步：重试服务端命令 ${LOGIN_COMMAND}。${where}`,
      }
  }
}

/**
 * Poll `login.json` and toast each state change (开始登录 / 成功 / 失败). This is
 * the only channel the TUI has: on 2.0.18 there is no command-registration
 * surface, so a login started from the server side is otherwise invisible here.
 *
 * The first read only seeds the baseline — a record left over from an earlier
 * run must not be announced as if it had just happened. Everything is guarded:
 * a failed read, a throwing `ui.toast` or a hostile context is swallowed, the
 * timer is unref'd so it never holds the host process open, and dispose stops
 * it. Returns the stop handle the host's dispose calls.
 */
export function startLoginStateWatcher(api: TuiApi, options: LoginWatchOptions = {}): () => void {
  const logger = options.logger ?? createLogger('tui')
  const readPrompt = options.readPrompt ?? readLoginPrompt
  const dataDir = options.dataDir ?? pluginDataDir()
  let stopped = false
  let running = false
  let seeded = false
  let previous: LoginPrompt | null = null
  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      const current = await readPrompt(dataDir)
      if (stopped) return
      if (!seeded) {
        seeded = true
        previous = current
        return
      }
      const next = loginStateToast(current, previous, loginPromptPath(dataDir))
      previous = current
      if (next !== null) toast(api, next)
    } catch (error) {
      logger.debug('登录状态轮询失败（忽略，不影响宿主）', {
        error: error instanceof Error ? error.name : typeof error,
      })
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => {
    void tick()
  }, options.intervalMs ?? LOGIN_WATCH_INTERVAL_MS)
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Wire the module into a live TUI context and return its cleanup. Never throws:
 * a context missing every surface still returns a working dispose handle, and the
 * command registration outcome (`'keymap'` / `'none'`) is only logged.
 */
export function tuiPlugin(api: TuiApi): TuiDispose {
  const logger = createLogger('tui')
  try {
    const surfaces = describeSurfaces(api)
    const mode = registerCommandLayer(api, aaCommands(api))
    // Side channel, independent of command registration: publish the session
    // index the Hub reads for parent/child linkage. No-op when the context
    // exposes no SDK client.
    const stopSessionIndex = startSessionIndexWriter(api, { logger })
    logger.debug('tui plugin ready', {
      commandMode: mode,
      usable: surfaces.usable.join(',') || 'none',
      jsxOnly: surfaces.jsxOnly.join(',') || 'none',
      apiVersion: api.app?.version ?? 'unknown',
    })
    // The one real, user-visible surface: an actionable status toast.
    void announceStatus(api).catch(() => undefined)
    // …and the login-state watcher, so a login started from the server side
    // (`/aa-login` or the automatic trigger) becomes visible here too.
    const stopLoginWatch = startLoginStateWatcher(api, { logger })
    const dispose: TuiDispose = () => {
      // Stop the index writer and the watcher: a disposed TUI must not keep
      // publishing or polling. The watcher only reads local state (no write),
      // so a synchronous stop is enough; the index writer *writes*, so its
      // stop is returned so the host awaits the drain — after dispose resolves
      // no publish may land on disk.
      stopLoginWatch()
      const stoppingIndexWriter = stopSessionIndex()
      // The Connector is a machine-wide OS process with its own lease and must
      // NOT be killed by a TUI unload: it outlives this view, may belong to
      // another host, and is a separate process from the session index. (Stopping
      // it here was the "dispose 误杀" hazard; the server setup's cleanup already
      // deliberately leaves it running.)
      return stoppingIndexWriter
    }
    return dispose
  } catch (error) {
    // §4.1: never throw into the host's plugin chain.
    logger.warn('tui setup failed', {
      error: error instanceof Error ? error.name : typeof error,
    })
    return () => undefined
  }
}

/**
 * Host entry point. Same body as `tuiPlugin`; named `setup` because that is the
 * exact member the 2.0.18 TUI module validator requires.
 */
export function setup(context: unknown): TuiDispose {
  return tuiPlugin(context as TuiApi)
}

const tuiPluginModule: TuiPluginModule = { id, setup }

export default tuiPluginModule

// ── command dispatch (only reachable if `keymap.layer` ever registers them) ────

async function dispatch(api: TuiApi, sub: string): Promise<void> {
  const onboarding = onboardingFor(api)
  try {
    switch (sub) {
      case 'status':
        return await showStatus(api, onboarding)
      case 'login':
        return await startLogin(api, onboarding, { headless: false })
      case 'login-headless':
        return await startLogin(api, onboarding, { headless: true })
      case 'logout':
        return await logout(api, onboarding)
      default:
        toast(api, { variant: 'warning', title: PLUGIN_LABEL, message: `未知子命令：${sub}` })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    toast(api, { variant: 'error', title: PLUGIN_LABEL, message })
  }
}

async function showStatus(api: TuiApi, onboarding: Onboarding): Promise<void> {
  const status = await onboarding.status()
  const source =
    status.apiBaseUrlSource === undefined ? '' : `（来源：${SERVER_URL_SOURCE_LABEL[status.apiBaseUrlSource]}）`
  const lines = [
    `服务器：${status.apiBaseUrl ?? '未配置'}${source}`,
    `账号：${status.userId ?? '未登录'}${status.loggedIn ? '' : '（凭据已失效）'}`,
    `设备：${status.connectorId ?? '未注册'}`,
    `Connector：${status.connectorRunning ? '运行中' : '未运行'}`,
  ]
  if (!status.loggedIn) lines.push('', `在 TUI 里运行服务端命令 ${LOGIN_COMMAND} 连接本机。`)
  toast(api, {
    variant: status.loggedIn ? 'success' : 'info',
    title: PLUGIN_LABEL,
    message: lines.join('\n'),
  })
}

async function startLogin(
  api: TuiApi,
  onboarding: Onboarding,
  options: { headless: boolean },
): Promise<void> {
  const status: OnboardingStatus = await onboarding.status()
  if (!status.configured) {
    // No dialog surface exists on 2.0.18, so we cannot prompt for the URL here.
    // Point the user at the supported path instead of a dead end.
    toast(api, {
      variant: 'warning',
      title: PLUGIN_LABEL,
      message: `尚未配置服务器地址；请先配置插件，再运行服务端命令 ${LOGIN_COMMAND}。`,
    })
    return
  }
  toast(api, {
    variant: 'info',
    title: PLUGIN_LABEL,
    message: options.headless ? '正在申请设备码…' : '正在打开浏览器…',
  })
  const outcome = await onboarding.login({
    headless: options.headless,
    onCode: (notice) => announceDeviceCode(api, notice),
  })
  reportLogin(api, outcome)
}

function reportLogin(api: TuiApi, outcome: LoginOutcome): void {
  if (outcome.ok) {
    toast(api, {
      variant: 'success',
      title: PLUGIN_LABEL,
      message: `已连接 ${outcome.stage.apiBaseUrl}\n账号 ${outcome.stage.userId}\n设备 ${outcome.stage.connectorId}`,
    })
    return
  }
  const hint =
    outcome.code === 'not_configured'
      ? `\n先运行服务端命令 ${LOGIN_COMMAND}。`
      : outcome.code === 'access_denied'
        ? '\n你在批准页拒绝了本次请求，可以重试。'
        : outcome.code === 'expired_token'
          ? `\n设备码已过期，请重新执行 ${LOGIN_COMMAND}。`
          : ''
  toast(api, { variant: 'error', title: PLUGIN_LABEL, message: `${outcome.message}${hint}` })
}

async function logout(api: TuiApi, onboarding: Onboarding): Promise<void> {
  // Order is fixed and irreversible: the server revoke happens first, inside
  // `Onboarding.logout()`; a revoke failure leaves local credentials untouched.
  await onboarding.logout()
  toast(api, { variant: 'success', title: PLUGIN_LABEL, message: '已撤销设备凭据并清理本地登录状态。' })
}

/** Show the short code exactly where a headless user will look for it. */
function announceDeviceCode(api: TuiApi, notice: DeviceCodeNotice): void {
  const message = `打开 ${notice.verificationUri}\n输入代码：${notice.userCode}`
  toast(api, { variant: 'warning', title: PLUGIN_LABEL, message, duration: 60_000 })
  ping(api, { title: PLUGIN_LABEL, message })
}

// ── UI helpers (real surface only; every call guarded, failures never escape) ──

function toast(api: TuiApi, input: TuiToast): void {
  try {
    api.ui?.toast?.(input)
  } catch {
    // Never throw out of a command handler or setup.
  }
}

/** Optional desktop ping via `attention.notify` (A10 §4). */
function ping(api: TuiApi, input: { title?: string; message: string }): void {
  try {
    void api.attention?.notify?.({ ...input, sound: 'default' })
  } catch {
    // A failed attention ping must not abort the caller.
  }
}
