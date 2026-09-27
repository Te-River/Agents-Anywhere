/**
 * Where this machine's server address comes from (defect ① — 「服务器地址没复用」).
 *
 * A machine that already runs the AA Desktop app *knows* its server: the shared
 * `~/.agents-anywhere/connector-runtime.json` lease records
 * `runtime.serverUrl`, and the Desktop app writes its own
 * `%APPDATA%\Agents Anywhere\desktop-server.json`. The login flow used to look
 * at the plugin config and `AGENT_SERVER_URL` only, so exactly that machine
 * reported `not_configured` and the login could never even start.
 *
 * Resolution order — first hit wins, and **every step is logged** so
 * "why THIS server?" is answerable from the log alone:
 *
 *   1. `options.serverUrl`                     opencode.json plugin config
 *   2. `AGENT_SERVER_URL`                      advanced / headless override
 *   3. `connector-runtime.json`                `runtime.serverUrl` (shared lease)
 *   4. `desktop-server.json`                   Desktop's own config → `serverUrl`
 *   5. `connector/desktop-binding.json`        Desktop device binding → `serverUrl`
 *
 * Field names are the ones the real files use (read on a live install, not
 * guessed); a candidate whose file is missing, unreadable, malformed or whose
 * field is absent/not a URL is skipped with a debug line — never fatal, never
 * guessed.
 *
 * **Non-sensitive fields only.** The only value ever taken out of a file is a
 * `serverUrl`-shaped string, read by dot-path. A token, a password or an
 * account id sitting in the same document is never returned and never logged:
 * a caller only sees `{ url, source, origin }`, where `origin` is a setting
 * name or a file path. Values that fail URL normalisation are dropped, so a
 * secret that happened to live under the `serverUrl` key cannot leak either.
 *
 * Leaf module (`node:fs` + `node:os`), no Onboarding import, so the TUI build
 * uses the same resolution as the service plugin.
 */

import { promises as fs } from 'node:fs'
import { homedir, platform as currentPlatform } from 'node:os'
import { join } from 'node:path'
import { connectorRuntimePath } from './credentials.js'
import { createLogger, type Logger } from './logger.js'
import { apiBaseUrl as normalizeServerUrl } from './oauth.js'
import { SERVER_URL_ENV } from './plugin-options.js'

/** Every layer that can answer "which server?" — `none` = nothing on this machine. */
export type ServerUrlSource =
  | 'options'
  | 'env'
  | 'connector-runtime'
  | 'desktop-server'
  | 'desktop-binding'
  | 'none'

/** The layer's name as it goes into a log line and into user-facing text. */
export const SERVER_URL_SOURCE_LABEL: Readonly<Record<ServerUrlSource, string>> = {
  options: '插件配置 options.serverUrl',
  env: `环境变量 ${SERVER_URL_ENV}`,
  'connector-runtime': '本机共享记录 connector-runtime.json 的 runtime.serverUrl',
  'desktop-server': '桌面端配置 desktop-server.json 的 serverUrl',
  'desktop-binding': '桌面端设备绑定 desktop-binding.json 的 serverUrl',
  none: '无',
}

/** One file that may hold a server address. `field` is a dot-path into its JSON. */
export interface ServerUrlFile {
  path: string
  source: Exclude<ServerUrlSource, 'options' | 'env' | 'none'>
  /** The **only** field this module may read, e.g. `runtime.serverUrl`. */
  field: string
}

export interface ServerUrlResolution {
  url: string | null
  source: ServerUrlSource
  /** Setting name or file path the value came from — never a value from the file. */
  origin: string
  /** True when the winning layer is a file on this machine (not options/env). */
  fromFile: boolean
}

export interface ServerUrlInput {
  /** `options.serverUrl`, normalised by the same rule as the env var. */
  optionUrl?: string | null
  env?: NodeJS.ProcessEnv
  /** Candidates in order; defaults to `defaultServerUrlFiles(env, platform)`. */
  files?: readonly ServerUrlFile[]
  platform?: NodeJS.Platform
  /** Injectable reader (`null` = missing/unreadable); tests never touch a real path. */
  readText?: (path: string) => Promise<string | null>
  /** Where the per-step lines go. Defaults to a `server-url` scoped logger. */
  logger?: Logger
}

/** Directory the AA Desktop app keeps its own config in, per OS convention. */
export const DESKTOP_APP_DIR_NAME = 'Agents Anywhere'

/**
 * The Desktop config directory. Windows uses `%APPDATA%` (where the measured
 * install writes `desktop-server.json`), macOS `Application Support`, Linux the
 * XDG config dir. An unknown platform yields no directory rather than a guess.
 */
export function desktopConfigDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = currentPlatform(),
): string[] {
  if (platform === 'win32') {
    const appData = nonEmpty(env['APPDATA'])
    return appData === null ? [] : [join(appData, DESKTOP_APP_DIR_NAME)]
  }
  if (platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', DESKTOP_APP_DIR_NAME)]
  }
  if (platform === 'linux') {
    const xdg = nonEmpty(env['XDG_CONFIG_HOME'])
    return [join(xdg ?? join(homedir(), '.config'), DESKTOP_APP_DIR_NAME)]
  }
  return []
}

/** The default candidate list: the shared lease first, then the Desktop app. */
export function defaultServerUrlFiles(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = currentPlatform(),
): ServerUrlFile[] {
  const files: ServerUrlFile[] = [
    { path: connectorRuntimePath(env), source: 'connector-runtime', field: 'runtime.serverUrl' },
  ]
  for (const dir of desktopConfigDirs(env, platform)) {
    files.push({ path: join(dir, 'desktop-server.json'), source: 'desktop-server', field: 'serverUrl' })
    files.push({
      path: join(dir, 'connector', 'desktop-binding.json'),
      source: 'desktop-binding',
      field: 'serverUrl',
    })
  }
  return files
}

/**
 * Resolve the server address, logging each layer it walks past and the one it
 * stopped on. Never throws: an unreadable file is a skipped layer.
 */
export async function locateServerUrl(input: ServerUrlInput = {}): Promise<ServerUrlResolution> {
  const env = input.env ?? process.env
  const logger = input.logger ?? createLogger('server-url')
  const read = input.readText ?? readTextFile

  const fromOption = normalizeServerUrl(input.optionUrl ?? '')
  if (fromOption !== null) return hit(logger, 'options', fromOption, 'options.serverUrl')
  logger.debug('服务器地址：插件配置 options.serverUrl 未提供可用地址，继续下一层', { source: 'options' })

  const fromEnv = normalizeServerUrl(env[SERVER_URL_ENV] ?? '')
  if (fromEnv !== null) return hit(logger, 'env', fromEnv, `环境变量 ${SERVER_URL_ENV}`)
  logger.debug(`服务器地址：环境变量 ${SERVER_URL_ENV} 未提供可用地址，继续下一层`, { source: 'env' })

  const files = input.files ?? defaultServerUrlFiles(env, input.platform ?? currentPlatform())
  for (const file of files) {
    const text = await read(file.path)
    const raw = text === null ? null : readServerUrlField(text, file.field)
    if (raw === null) {
      const why = text === null ? '文件不存在或不可读' : `缺少可用的 ${file.field} 字符串`
      logger.debug(`服务器地址：${SERVER_URL_SOURCE_LABEL[file.source]} 无可用地址（${why}），继续下一层`, {
        source: file.source,
        path: file.path,
      })
      continue
    }
    const url = normalizeServerUrl(raw)
    if (url === null) {
      logger.debug(`服务器地址：${file.path} 的 ${file.field} 不是可用地址，继续下一层`, {
        source: file.source,
        path: file.path,
      })
      continue
    }
    return hit(logger, file.source, url, `${file.path}（字段 ${file.field}）`)
  }

  logger.warn(
    '未找到服务器地址：插件配置、AGENT_SERVER_URL 与本机的 Connector / Desktop 记录都没有可用的 serverUrl。' +
      '怎么设置：在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，或设置环境变量 ' +
      `${SERVER_URL_ENV}；详见 opencode-plugin/README.md「账号接入（P4）」一节。`,
    { source: 'none' },
  )
  return { url: null, source: 'none', origin: 'none', fromFile: false }
}

/**
 * Read one string field by dot-path. Anything else — a number, an object, a
 * secret under another key, malformed JSON — is `null`, so only the single
 * non-sensitive field named by the caller can ever leave this module.
 */
export function readServerUrlField(text: string, field: string): string | null {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return null
  }
  let cursor: unknown = document
  for (const key of field.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === 'string' ? nonEmpty(cursor) : null
}

function hit(
  logger: Logger,
  source: Exclude<ServerUrlSource, 'none'>,
  url: string,
  origin: string,
): ServerUrlResolution {
  logger.info(`服务器地址采用${SERVER_URL_SOURCE_LABEL[source]}：${url}`, {
    source,
    origin,
    serverUrl: url,
  })
  return { url, source, origin, fromFile: source !== 'options' && source !== 'env' }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    // Missing, unreadable or a directory: this layer simply has no opinion.
    return null
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
