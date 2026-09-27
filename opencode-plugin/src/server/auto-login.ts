/**
 * The automatic half of onboarding (design §5.1; task: 首启即登录).
 *
 * `setup()` no longer waits for an environment variable. When `resume()` says
 * `needs_login`, this module runs the login **by itself**, non-blocking, in the
 * shape the machine can actually finish:
 *
 * - graphical machine → **loopback OAuth**; the authorization URL is written to
 *   the log *and* to `login.json`, and the browser is opened so the user only
 *   clicks 授权;
 * - SSH / no display → **device code**, whose `verification_uri` + short code go
 *   to the same two places (the user is on another machine, so "open it for me"
 *   cannot be done from here).
 *
 * Loopback that cannot even *start* (callback port unusable) **falls back to the
 * device code** instead of dead-ending. The fallback happens only for a flow
 * that never began — never for a user who denied or timed out, who would
 * otherwise get a fresh short code thrown at someone who just said no.
 *
 * The caller (`server/index.ts`) owns the connection-state log lines; this
 * module owns the prompts and the `login.json` record, so a prompt exists in
 * exactly one place.
 */

import { createLogger, type Logger } from '../shared/logger.js'
import {
  LOGIN_PROMPT_VERSION,
  formatLoginPrompt,
  writeLoginPrompt,
  type LoginPrompt,
} from '../shared/login-prompt.js'
import { SERVER_URL_ENV, type LoginMode } from '../shared/plugin-options.js'
import type { DeviceCodeNotice } from './device-login.js'
import { LOOPBACK_UNAVAILABLE_CODE } from './oauth-loopback.js'
import type { LoginOptions, LoginOutcome } from './onboarding.js'

/** An SSH session has no browser on *this* machine, so its callback can never land. */
export function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'].some(
    (key) => (env[key] ?? '').trim().length > 0,
  )
}

/**
 * Which flow this machine can finish, absent an explicit choice. Windows and
 * macOS always have a browser; elsewhere a display server is the only signal we
 * actually have, and an SSH session overrides both.
 */
export function preferredLoginMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LoginMode {
  if (isRemoteSession(env)) return 'device'
  if (platform === 'win32' || platform === 'darwin') return 'loopback'
  const display = (env['DISPLAY'] ?? '').trim()
  const wayland = (env['WAYLAND_DISPLAY'] ?? '').trim()
  return display.length > 0 || wayland.length > 0 ? 'loopback' : 'device'
}

export interface AutoLoginOptions {
  /** `Onboarding.login` (injected so the policy is testable without a socket). */
  login: (options: LoginOptions) => Promise<LoginOutcome>
  /** Where `login.json` goes (`Onboarding.dataDir`). */
  dataDir: string
  logger?: Logger
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  now?: () => number
  signal?: AbortSignal
  /** Forced flow (`options.loginMode` / `AGENT_AA_LOGIN`); `null` = decide here. */
  forcedMode?: LoginMode | null
}

export interface AutoLoginResult {
  /** The flow the user actually ended up in. */
  mode: LoginMode
  /** True when loopback could not start and the device code took over. */
  fellBack: boolean
  attempts: LoginMode[]
  outcome: LoginOutcome
}

interface AttemptContext {
  login: (options: LoginOptions) => Promise<LoginOutcome>
  dataDir: string
  logger: Logger
  now: () => number
  signal: AbortSignal | undefined
}

export async function runAutoLogin(options: AutoLoginOptions): Promise<AutoLoginResult> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const logger = options.logger ?? createLogger('login')
  const forced = options.forcedMode ?? null
  const mode = forced ?? preferredLoginMode(env, platform)
  if (forced === null) {
    logger.info(
      mode === 'device'
        ? '未检测到本机图形环境（或处于 SSH 会话），使用无头设备码登录（短码与验证地址同时写入登录文件）'
        : '检测到本机图形环境，使用回环 OAuth 登录，并尝试自动打开系统浏览器',
    )
  }
  const context: AttemptContext = {
    login: options.login,
    dataDir: options.dataDir,
    logger,
    now: options.now ?? Date.now,
    signal: options.signal,
  }
  const first = await attempt(mode, context)
  if (mode === 'loopback' && forced === null && !first.ok && first.code === LOOPBACK_UNAVAILABLE_CODE) {
    logger.warn('回环登录无法启动（本机回调端口不可用），自动改用无头设备码登录')
    return { mode: 'device', fellBack: true, attempts: ['loopback', 'device'], outcome: await attempt('device', context) }
  }
  return { mode, fellBack: false, attempts: [mode], outcome: first }
}

async function attempt(mode: LoginMode, context: AttemptContext): Promise<LoginOutcome> {
  const signalOptions = context.signal !== undefined ? { signal: context.signal } : {}
  const outcome =
    mode === 'loopback'
      ? await context.login({
          headless: false,
          ...signalOptions,
          onAuthorizationUrl: (url, loopback) =>
            publishPrompt(context, loopbackPrompt(context.now(), url, loopback.deadline)),
        })
      : await context.login({
          headless: true,
          ...signalOptions,
          onCode: (notice) => publishPrompt(context, devicePrompt(context.now(), notice)),
        })
  await settlePrompt(context, mode, outcome)
  return outcome
}

/** Write the prompt file and log the line the user acts on — one or the other, never neither. */
async function publishPrompt(context: AttemptContext, prompt: LoginPrompt): Promise<void> {
  let path: string | null = null
  try {
    path = await writeLoginPrompt(context.dataDir, prompt)
  } catch (error) {
    context.logger.warn('登录信息文件写入失败，请直接使用下面的地址/短码', {
      error: error instanceof Error ? error.name : typeof error,
    })
  }
  // INFO on purpose: this is the user's to-do line, not a debug detail.
  context.logger.info(formatLoginPrompt(prompt, path))
}

/**
 * Replace the pending record with a terminal one that keeps no URL and no code,
 * so `login.json` never outlives the flow holding a usable secret.
 */
async function settlePrompt(context: AttemptContext, kind: LoginMode, outcome: LoginOutcome): Promise<void> {
  const now = context.now()
  const record: LoginPrompt = outcome.ok
    ? {
        version: LOGIN_PROMPT_VERSION,
        status: 'connected',
        kind,
        createdAt: now,
        expiresAt: now,
        instruction: '登录已完成，可以关闭本文件。',
      }
    : {
        version: LOGIN_PROMPT_VERSION,
        status: 'failed',
        kind,
        createdAt: now,
        expiresAt: now,
        instruction: failedInstruction(outcome),
      }
  await writeLoginPrompt(context.dataDir, record).catch(() => undefined)
}

/**
 * The failed record's sentence. `not_configured` gets its own text: that user's
 * problem is not "the flow failed", it is "this machine has no server address
 * yet", so the file has to say exactly where to put one (defect ①/②) — the log
 * line and the copyable file carry the same words.
 */
function failedInstruction(outcome: Extract<LoginOutcome, { ok: false }>): string {
  if (outcome.code === 'not_configured') {
    return (
      `登录未完成（not_configured）：${outcome.message}` +
      '怎么设置服务器地址：在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，' +
      `或设置环境变量 ${SERVER_URL_ENV}，或先让 AA Desktop 完成一次连接；` +
      '详见 opencode-plugin/README.md「账号接入（P4）」一节。'
    )
  }
  return `登录未完成（${outcome.code}）：${outcome.message}。重启 OpenCode 可重试，或参考 opencode-plugin/README.md「账号接入（P4）」一节。`
}

function loopbackPrompt(now: number, authorizationUrl: string, deadline: number): LoginPrompt {
  return {
    version: LOGIN_PROMPT_VERSION,
    status: 'pending',
    kind: 'loopback',
    createdAt: now,
    expiresAt: deadline,
    instruction: '在浏览器打开授权地址并点一次「授权」。',
    authorizationUrl,
  }
}

function devicePrompt(now: number, notice: DeviceCodeNotice): LoginPrompt {
  return {
    version: LOGIN_PROMPT_VERSION,
    status: 'pending',
    kind: 'device',
    createdAt: now,
    expiresAt: notice.expiresAt,
    instruction: `打开 ${notice.verificationUri} 并输入短码 ${notice.userCode}。`,
    verificationUri: notice.verificationUri,
    verificationUriComplete: notice.verificationUriComplete,
    userCode: notice.userCode,
  }
}
