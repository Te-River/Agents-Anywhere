/**
 * The three connection states, each as one **actionable** line (task item 5):
 * `needs_login` · `logging_in` · `connected`.
 *
 * `logging_in` lives with the prompt itself (`shared/login-prompt.ts`, since the
 * URL/short code is what makes it actionable) and is emitted by
 * `server/auto-login.ts`. This module owns the other two plus the "auto login is
 * switched off" variant, so every state a user can be left in says what is
 * wrong **and what to do next** — never a bare debug line.
 *
 * The configuration is named in the line ("came from `options.autoLogin`"), so
 * "why is it not logging me in?" is answerable from the log alone.
 */

import {
  AUTO_LOGIN_ENV,
  SERVER_URL_ENV,
  type LoginMode,
  type SettingSource,
} from '../shared/plugin-options.js'
import type { ConnectionStage } from './onboarding.js'

export interface AutoLoginPolicy {
  autoLogin: boolean
  autoLoginSource: SettingSource
}

/** Where the switch was read from — printed verbatim so the user can go turn it on. */
export function sourceLabel(source: SettingSource): string {
  if (source === 'options') return '插件配置 options.autoLogin'
  if (source === 'env') return `环境变量 ${AUTO_LOGIN_ENV}`
  return '默认值'
}

export function needsLoginStateLine(
  stage: Extract<ConnectionStage, { stage: 'needs_login' }>,
  policy: AutoLoginPolicy,
): string {
  // The `null` branch is the one the user has to act on (defect ①): name every
  // way to set an address — plugin config, env, and the machine's own
  // Connector / Desktop records that are now read automatically.
  const server =
    stage.apiBaseUrl ??
    '未配置（怎么设置：在 opencode.json 的插件项设置 options.serverUrl，或设置环境变量 ' +
      `${SERVER_URL_ENV}；本机 Connector / AA Desktop 已有的服务器记录会被自动识别；` +
      '详见 opencode-plugin/README.md「账号接入（P4）」一节）'
  const next = policy.autoLogin
    ? '下一步：不需要你做任何事 —— 登录已自动发起；图形环境会打开浏览器点一次「授权」，无头/远程环境会给出验证地址与短码（同时写在登录文件里）。'
    : `下一步：自动登录当前关闭（来源：${sourceLabel(policy.autoLoginSource)}）；在 opencode.json 的插件项里设置 options.autoLogin = true（或删除 ${AUTO_LOGIN_ENV}）后重启 OpenCode。`
  return `未连接：需要登录（原因：${stage.reason}）。服务器：${server}。${next}`
}

export function autoLoginDisabledStateLine(policy: AutoLoginPolicy): string {
  return `自动登录已关闭（来源：${sourceLabel(policy.autoLoginSource)}），本次不会尝试登录。下一步：需要连接时把 options.autoLogin 设为 true 后重启 OpenCode；或临时删除 ${AUTO_LOGIN_ENV}。`
}

export function connectedStateLine(
  stage: Extract<ConnectionStage, { stage: 'connected' }>,
  detail: { loginMode: LoginMode | null; fellBack: boolean },
): string {
  const how = detail.fellBack
    ? '设备码登录（回环不可用后自动回退）'
    : detail.loginMode === 'device'
      ? '设备码登录'
      : detail.loginMode === 'loopback'
        ? '回环 OAuth 登录'
        : '复用已有凭据'
  const device = stage.reusedDevice ? '复用本机已有的 Connector' : '已启动新的 Connector'
  return `已连接：账号 ${stage.userId}，设备 ${stage.connectorId}（${how}；${device}）。无需其他操作。`
}

export function disabledStateLine(stage: Extract<ConnectionStage, { stage: 'disabled' }>): string {
  return `未连接：本地凭据状态不可用（${stage.reason}）。下一步：检查 AGENT_CONNECTOR_DATA_DIR 指向的目录是否可读写后重启 OpenCode。`
}
