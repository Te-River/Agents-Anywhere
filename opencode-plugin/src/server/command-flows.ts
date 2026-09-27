/**
 * The three palette commands' **flows** (task A.1/A.3) — thin adapters over the
 * machinery that already exists, so the command surface and the automatic
 * trigger are one implementation, not two.
 *
 * `runSetupLogin` lives here (re-exported from `server/index.ts`) because both
 * callers need it: `setup()` fires it when `resume()` says `needs_login`, and
 * `/aa-login` runs it when the user asks. Same onboarding instance, same
 * loopback→device fallback, same `login.json` record.
 *
 * Every `execute` returns a human-readable string and **never throws**: a
 * command handler that throws is a silent no-op in a palette, which is exactly
 * the failure mode this whole file exists to avoid.
 */

import { createLogger, type Logger } from '../shared/logger.js'
import { loginPromptPath } from '../shared/login-prompt.js'
import type { LoginMode } from '../shared/plugin-options.js'
import { SERVER_URL_SOURCE_LABEL } from '../shared/server-url.js'
import { OPENCODE_SUPPORTED_RANGE, OPENCODE_VALIDATED_VERSIONS } from '../shared/version-gate.js'
import { runAutoLogin, type AutoLoginResult } from './auto-login.js'
import { connectedStateLine } from './login-state.js'
import type { CommandEntry } from './commands.js'
import type { OpenCodePluginContext } from './opencode-ctx.js'
import type { LoginOptions, LoginOutcome, OnboardingStatus } from './onboarding.js'

const logger = createLogger('plugin')

/** What `runSetupLogin` needs to run a login without holding the whole `Onboarding`. */
export interface SetupLoginTask {
  login: (options: LoginOptions) => Promise<LoginOutcome>
  dataDir: string
  env?: NodeJS.ProcessEnv
  logger?: Logger
  /** Forced flow from `options.loginMode` / `AGENT_AA_LOGIN`. */
  forcedMode?: 'device' | 'loopback' | null
}

/**
 * Login + outcome logging, never throwing. Callers fire it without awaiting (the
 * host must not be blocked by an interactive flow); tests await the returned
 * promise to assert the three state lines.
 */
export async function runSetupLogin(task: SetupLoginTask): Promise<AutoLoginResult | null> {
  const loginLogger = task.logger ?? createLogger('login')
  try {
    const result = await runAutoLogin({
      login: task.login,
      logger: loginLogger,
      dataDir: task.dataDir,
      ...(task.env !== undefined ? { env: task.env } : {}),
      forcedMode: task.forcedMode ?? null,
    })
    if (result.outcome.ok) {
      // `connected` — the third of the three states, with what it cost the user.
      loginLogger.info(
        connectedStateLine(result.outcome.stage, {
          loginMode: result.mode,
          fellBack: result.fellBack,
        }),
      )
    } else {
      loginLogger.warn(
        `登录未完成（${result.outcome.code}）：${result.outcome.message}。` +
          '下一步：重启 OpenCode 会重新发起登录；无头环境可设置 AGENT_AA_LOGIN=device 强制设备码；' +
          '也可参考 opencode-plugin/README.md「账号接入」一节。',
      )
    }
    return result
  } catch (error) {
    loginLogger.warn('自动登录失败', {
      error: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
}

/** The command names, in one place so tests and logs cannot drift apart. */
export const AA_COMMANDS = {
  login: 'aa-login',
  status: 'aa-status',
  logout: 'aa-logout',
} as const

/** The `Onboarding` surface a command needs (structural, so a fake is trivial). */
export interface CommandOnboarding {
  readonly dataDir: string
  login(options: LoginOptions): Promise<LoginOutcome>
  logout(): Promise<void>
  status(): Promise<OnboardingStatus>
}

/** Host facts `aa-status` prints: version, in-range verdict, present surfaces. */
export interface HostSummary {
  version: string | null
  supported: boolean | null
  capabilities: string[]
}

export interface CommandFlowsOptions {
  /**
   * Lazy provider for the **shared singleton** (`installOnboarding`), never a
   * second `Onboarding`: the command surface must reuse the very instance the
   * automatic trigger works with, or the two could spawn against different state.
   */
  onboarding: () => CommandOnboarding
  env?: NodeJS.ProcessEnv
  logger?: Logger
  /** Forced flow (`options.loginMode` / `AGENT_AA_LOGIN`). */
  forcedMode?: LoginMode | null
  /** Host summary for `aa-status`; absent means "unknown host version". */
  host?: () => HostSummary
}

export interface CommandFlows {
  login: () => Promise<string>
  status: () => Promise<string>
  logout: () => Promise<string>
}

/**
 * The flows themselves. Each returns the text a palette entry can display as-is
 * and degrades to an actionable message instead of throwing.
 */
export function createCommandFlows(options: CommandFlowsOptions): CommandFlows {
  const flowLogger = options.logger ?? logger
  const env = options.env ?? process.env
  return {
    login: async (): Promise<string> => {
      const onboarding = options.onboarding()
      // The host *may* show this return value, so every branch is a complete
      // answer: status + next step + the path the user can open (defect ②).
      const promptFile = loginPromptPath(onboarding.dataDir)
      const result = await runSetupLogin({
        login: (loginOptions) => onboarding.login(loginOptions),
        dataDir: onboarding.dataDir,
        env,
        logger: flowLogger,
        forcedMode: options.forcedMode ?? null,
      })
      if (result === null) {
        return (
          '登录未完成：登录流程自身出错。' +
          `下一步：打开登录文件 ${promptFile} 看原因（或查看 OpenCode 日志），然后重试 /aa-login。`
        )
      }
      if (result.outcome.ok) {
        return (
          `登录成功。${connectedStateLine(result.outcome.stage, { loginMode: result.mode, fellBack: result.fellBack })}` +
          `\n关键路径：凭据在 ${onboarding.dataDir}（account.json / bindings/，无需手动编辑）；登录状态文件 ${promptFile}。`
        )
      }
      const next =
        result.outcome.code === 'not_configured'
          ? '下一步：先设置服务器地址 —— 在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，' +
            '或设置 AGENT_SERVER_URL；详见 opencode-plugin/README.md「账号接入（P4）」。'
          : '下一步：重试 /aa-login；无头/SSH 环境可用 AGENT_AA_LOGIN=device 强制设备码。'
      return (
        `登录未完成（${result.outcome.code}）：${result.outcome.message}` +
        `${next}\n登录文件（授权地址 / 短码 / 原因都写在这里，可直接打开复制）：${promptFile}`
      )
    },

    status: async (): Promise<string> => {
      const onboarding = options.onboarding()
      const status = await onboarding.status()
      const host = options.host?.()
      const lines = ['Agents Anywhere 状态']
      lines.push(
        status.apiBaseUrl === null
          ? '- 服务器：未配置（下一步：在 opencode.json 的插件项设置 options.serverUrl，或设置 AGENT_SERVER_URL；' +
              '本机 Connector / AA Desktop 已有的服务器记录会被自动识别）'
          : `- 服务器：${status.apiBaseUrl}` +
              (status.apiBaseUrlSource !== undefined
                ? `（来源：${SERVER_URL_SOURCE_LABEL[status.apiBaseUrlSource]}）`
                : ''),
      )
      lines.push(
        status.loggedIn
          ? `- 账号：${status.displayName ?? status.userId ?? '未知'}（${status.userId ?? '—'}）已登录，凭据到期 ${formatTime(status.accountExpiresAt)}`
          : '- 账号：未登录（下一步：运行 /aa-login 发起登录）',
      )
      lines.push(
        status.connectorId === null
          ? '- 设备：未绑定（下一步：运行 /aa-login 完成设备绑定与 Connector 启动）'
          : `- 设备：${status.connectorId}（Connector ${status.connectorRunning ? '运行中' : '未由本进程运行'}）`,
      )
      if (typeof status.credentialProblem === 'string' && status.credentialProblem.length > 0) {
        lines.push(`- 设备凭据：${status.credentialProblem}`)
      }
      lines.push(
        host === undefined
          ? `- 宿主：OpenCode 版本未知（本插件支持 ${OPENCODE_SUPPORTED_RANGE}）`
          : `- 宿主：OpenCode ${host.version ?? '版本未知'}（支持 ${OPENCODE_SUPPORTED_RANGE}；` +
              `已核验 ${OPENCODE_VALIDATED_VERSIONS.join('、')}）`,
      )
      lines.push(`- 能力：${(host?.capabilities ?? summarizeHostSurface(undefined)).join(' · ') || '宿主未暴露任何可探测能力'}`)
      lines.push(`- 登录文件：${loginPromptPath(onboarding.dataDir)}（授权地址 / 短码 / 失败原因）`)
      return lines.join('\n')
    },

    logout: async (): Promise<string> => {
      const onboarding = options.onboarding()
      await onboarding.logout()
      return (
        '已登出：已先在服务端撤销设备凭据，再清理本地账号/设备记录，并停止本插件启动的 Connector。' +
        `\n下一步：需要重新连接时运行 /aa-login；本地凭据目录 ${onboarding.dataDir}（account.json / bindings/ 已清理）。`
      )
    },
  }
}

/**
 * Which host surfaces are actually present — the capability summary `aa-status`
 * prints. Derived from the live context (never from a static list) so the line
 * cannot claim a surface this host does not have.
 */
export function summarizeHostSurface(ctx: OpenCodePluginContext | undefined): string[] {
  const out: string[] = []
  if (typeof ctx?.event?.subscribe === 'function') out.push('事件流')
  if (typeof ctx?.permission?.hook === 'function' || typeof ctx?.permission?.reply === 'function') {
    out.push('权限桥')
  }
  if (typeof ctx?.session?.prompt === 'function' || typeof ctx?.session?.update === 'function') {
    out.push('会话读写')
  }
  if (typeof ctx?.agent?.transform === 'function' || typeof ctx?.model?.transform === 'function') {
    out.push('agent/model 目录')
  }
  if (typeof ctx?.command?.transform === 'function') out.push('命令面板')
  return out
}

/** The three palette entries, each dispatching to its flow and never throwing. */
export function createCommandEntries(flows: CommandFlows): CommandEntry[] {
  return [
    {
      name: AA_COMMANDS.login,
      description:
        'Agents Anywhere：连接本机/服务器（优先复用可用的 Connector，否则发起登录；图形环境自动打开浏览器，回环不可用时自动回退设备码）',
      execute: guarded('登录', flows.login),
    },
    {
      name: AA_COMMANDS.status,
      description: 'Agents Anywhere：显示连接状态（服务器/账号/设备/宿主版本/能力摘要），并给出下一步操作',
      execute: guarded('状态查询', flows.status),
    },
    {
      name: AA_COMMANDS.logout,
      description: 'Agents Anywhere：登出（先在服务端撤销设备凭据，再清理本地凭据，并停止本插件的 Connector）',
      execute: guarded('登出', flows.logout),
    },
  ]
}

/** Wrap a flow so a throw still answers the palette with something actionable. */
function guarded(label: string, flow: () => Promise<string>): () => Promise<string> {
  return async (): Promise<string> => {
    try {
      return await flow()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.warn(`命令 /${label} 执行失败`, { error: error instanceof Error ? error.name : typeof error })
      return `${label}失败：${detail}。下一步：查看 OpenCode 日志后重试；若持续失败，重启 OpenCode 再执行一次命令。`
    }
  }
}

function formatTime(epochMs: number | null): string {
  return epochMs === null ? '未知' : new Date(epochMs).toISOString()
}
