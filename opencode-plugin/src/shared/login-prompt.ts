/**
 * The user-facing half of a login: a copy-pasteable log line **and** a small
 * file the user can open directly (`…/opencode-plugin/login.json`).
 *
 * Before this, the authorization URL / short code existed only in the log, so
 * "log in" effectively meant "read the log". The file is written atomically
 * with the same discipline as the credential store (`writeJsonAtomic`: `0600`
 * inside a `0700` directory), holds no secret beyond the one-time code the user
 * must type, and doubles as the machine-readable state a later TUI surface can
 * render without re-deriving anything.
 *
 * When a flow finishes the file is **overwritten**, never left holding a code:
 * a terminal record carries `status: "connected" | "failed"` and drops the URL
 * and short code, so a stale code cannot be read back out of it.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from './credentials.js'
import type { LoginMode } from './plugin-options.js'

export const LOGIN_PROMPT_FILE = 'login.json'
export const LOGIN_PROMPT_VERSION = 1

export type LoginPromptStatus = 'pending' | 'connected' | 'failed'

/** The record behind both the prominent log line and the on-disk state. */
export interface LoginPrompt {
  version: typeof LOGIN_PROMPT_VERSION
  status: LoginPromptStatus
  kind: LoginMode
  /** Epoch ms the record was written. */
  createdAt: number
  /** Epoch ms the pending URL / short code stops being usable. */
  expiresAt: number
  /** The sentence the user should act on (mirrors the log line's body). */
  instruction: string
  /** Loopback only. */
  authorizationUrl?: string
  /** Device only. */
  verificationUri?: string
  /** Device only: the URL that already carries `user_code`. */
  verificationUriComplete?: string
  /** Device only. */
  userCode?: string
}

export function loginPromptPath(dataDir: string): string {
  return join(dataDir, LOGIN_PROMPT_FILE)
}

export async function writeLoginPrompt(dataDir: string, prompt: LoginPrompt): Promise<string> {
  const path = loginPromptPath(dataDir)
  await writeJsonAtomic(path, prompt)
  return path
}

/** `null` for a missing, malformed or unreadable record — never throws. */
export async function readLoginPrompt(dataDir: string): Promise<LoginPrompt | null> {
  let value: LoginPrompt | null
  try {
    value = await readJsonFile<LoginPrompt>(loginPromptPath(dataDir))
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  if (value.status !== 'pending' && value.status !== 'connected' && value.status !== 'failed') return null
  if (value.kind !== 'device' && value.kind !== 'loopback') return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null
  const prompt: LoginPrompt = {
    version: LOGIN_PROMPT_VERSION,
    status: value.status,
    kind: value.kind,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    instruction: typeof value.instruction === 'string' ? value.instruction : '',
  }
  if (typeof value.authorizationUrl === 'string') prompt.authorizationUrl = value.authorizationUrl
  if (typeof value.verificationUri === 'string') prompt.verificationUri = value.verificationUri
  if (typeof value.verificationUriComplete === 'string') {
    prompt.verificationUriComplete = value.verificationUriComplete
  }
  if (typeof value.userCode === 'string') prompt.userCode = value.userCode
  return prompt
}

export async function clearLoginPrompt(dataDir: string): Promise<void> {
  await fs.rm(loginPromptPath(dataDir), { force: true }).catch(() => undefined)
}

/** `HH:MM`-precision local time — hand-formatted so a test never depends on a locale. */
export function expiryText(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** The `logging_in` line for the browser flow — header, URL, where else to read it. */
export function formatLoopbackPrompt(prompt: LoginPrompt, path: string | null): string {
  return [
    '需要你点一次「授权」完成登录。请在浏览器打开以下地址（已尝试自动打开；未打开就复制这一行）：',
    `  ${prompt.authorizationUrl ?? '(授权地址缺失)'}`,
    sourceLine(path, prompt.expiresAt),
  ].join('\n')
}

/** The `logging_in` line for the headless flow — URL, short code, where else to read it. */
export function formatDevicePrompt(prompt: LoginPrompt, path: string | null): string {
  return [
    `无头/远程环境：请在任意设备的浏览器打开 ${prompt.verificationUri ?? '(验证地址缺失)'}，并输入短码 ${prompt.userCode ?? '(短码缺失)'}`,
    `（直接打开、免手动输入的链接：${prompt.verificationUriComplete ?? '(缺失)'}）`,
    sourceLine(path, prompt.expiresAt),
  ].join('\n')
}

/** The log line matching the record, so callers never re-branch on `kind`. */
export function formatLoginPrompt(prompt: LoginPrompt, path: string | null): string {
  return prompt.kind === 'loopback' ? formatLoopbackPrompt(prompt, path) : formatDevicePrompt(prompt, path)
}

function sourceLine(path: string | null, expiresAt: number): string {
  const validity = `有效期至 ${expiryText(expiresAt)}。`
  return path === null
    ? `（登录信息文件不可用，请直接复制上面的地址/短码。）${validity}`
    : `同一份信息也在文件里，可直接打开复制：${path}。${validity}`
}
