/**
 * Plugin configuration (V2 `ctx.options`) — the settings surface that replaced
 * "export an environment variable before you start OpenCode".
 *
 * OpenCode V2 hands a plugin its own config object as `ctx.options`
 * (`{ "package": "…", "options": { … } }` in `opencode.json`), so the user can
 * configure this plugin exactly where every other plugin is configured. The
 * environment stays supported as an **override for advanced / headless use**
 * (a shell profile, a service unit, CI), never as a requirement.
 *
 * Precedence, per setting: `options.*` > matching env var > built-in default.
 * This module is a leaf — no file, socket or child process — so an unusable
 * value comes back as `null`/the default instead of being guessed, and the
 * caller (`server/index.ts`) decides what to log about it.
 */

import { apiBaseUrl as normalizeServerUrl } from './oauth.js'

/** Server address; the same name the Connector and the Docker images use. */
export const SERVER_URL_ENV = 'AGENT_SERVER_URL'

/**
 * Advanced/headless: force one flow instead of letting the plugin pick.
 * `device` (RFC 8628) or `loopback` (browser). Unset is the normal case.
 */
export const LOGIN_MODE_ENV = 'AGENT_AA_LOGIN'

/** Advanced/headless: turn the automatic login off (`0`/`false`/`off`) or on. */
export const AUTO_LOGIN_ENV = 'AGENT_AA_AUTO_LOGIN'

/**
 * Connector source dir override. The literal is repeated here on purpose: this
 * module is compiled into the TUI build too, and importing
 * `server/connector-supervisor.ts` would drag `node:child_process` along.
 * Keep in sync with `src/server/connector-supervisor.ts` (`CONNECTOR_SOURCE_ENV`).
 */
export const CONNECTOR_SOURCE_ENV = 'AGENT_CONNECTOR_SOURCE'

/**
 * Advanced escape hatch (task B): reuse whatever Connector is already running
 * even though its advertised runtime types do not include `opencode`. Default
 * (`false`) is the safe direction: an unrecognised Connector is not reused.
 * Keep in sync with `server/onboarding.ts` (which logs this name).
 */
export const FORCE_REUSE_CONNECTOR_ENV = 'AGENT_AA_FORCE_REUSE_CONNECTOR'

export type LoginMode = 'device' | 'loopback'

/** Which layer supplied a value — echoed in the log so "why is it off?" is answerable. */
export type SettingSource = 'options' | 'env' | 'default'

export interface ResolvedPluginOptions {
  /** Normalised server origin, or `null` when nothing on this machine says one. */
  serverUrl: string | null
  /** May `setup()` start a login on its own? Default `true`. */
  autoLogin: boolean
  /** Forced flow; `null` lets the plugin decide from the machine's environment. */
  loginMode: LoginMode | null
  /** Connector source directory override; `null` keeps the supervisor's own order. */
  connectorSource: string | null
  /**
   * Reuse a running Connector even when it does not advertise `opencode`.
   * Default `false`: the capability gate (task B) decides, and "unknown"
   * capability means "do not reuse".
   */
  forceReuseConnector: boolean
  source: {
    serverUrl: SettingSource
    autoLogin: SettingSource
    loginMode: SettingSource
    connectorSource: SettingSource
    forceReuseConnector: SettingSource
  }
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on'])
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off'])

/**
 * Tolerant boolean: a real boolean, `1`/`0`, or the words a JSON/env author
 * writes. Anything else is "no opinion" (`null`) rather than an error, so a
 * typo in one setting cannot take the whole plugin down.
 */
export function parseBooleanOption(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (TRUE_WORDS.has(text)) return true
  if (FALSE_WORDS.has(text)) return false
  return null
}

/** `device` / `loopback` only; anything else means "decide automatically". */
export function parseLoginMode(value: unknown): LoginMode | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  return text === 'device' || text === 'loopback' ? text : null
}

/**
 * The options object, narrowed without trusting its shape. A host that hands
 * back the whole `opencode.json` entry (`{ package, options }`) is unwrapped
 * too, so both spellings configure the same plugin.
 */
export function optionBag(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const nested = (raw as Record<string, unknown>)['options']
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  return raw as Record<string, unknown>
}

export function resolvePluginOptions(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPluginOptions {
  const bag = optionBag(raw)
  const server = pick(
    normalizeServerUrl(nonEmptyString(bag['serverUrl']) ?? ''),
    normalizeServerUrl(env[SERVER_URL_ENV] ?? ''),
    null,
  )
  const autoLogin = pick(
    parseBooleanOption(bag['autoLogin']),
    parseBooleanOption(env[AUTO_LOGIN_ENV]),
    true,
  )
  const loginMode = pick(
    parseLoginMode(bag['loginMode']),
    parseLoginMode(env[LOGIN_MODE_ENV]),
    null,
  )
  const connectorSource = pick(
    nonEmptyString(bag['connectorSource']),
    nonEmptyString(env[CONNECTOR_SOURCE_ENV]),
    null,
  )
  const forceReuse = pick(
    parseBooleanOption(bag['forceReuseConnector']),
    parseBooleanOption(env[FORCE_REUSE_CONNECTOR_ENV]),
    false,
  )
  return {
    serverUrl: server.value,
    autoLogin: autoLogin.value,
    loginMode: loginMode.value,
    connectorSource: connectorSource.value,
    forceReuseConnector: forceReuse.value,
    source: {
      serverUrl: server.source,
      autoLogin: autoLogin.source,
      loginMode: loginMode.source,
      connectorSource: connectorSource.source,
      forceReuseConnector: forceReuse.source,
    },
  }
}

/** Highest layer that has an opinion wins: options → env → default. */
function pick<T>(fromOptions: T | null, fromEnv: T | null, fallback: T): { value: T; source: SettingSource } {
  if (fromOptions !== null) return { value: fromOptions, source: 'options' }
  if (fromEnv !== null) return { value: fromEnv, source: 'env' }
  return { value: fallback, source: 'default' }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
