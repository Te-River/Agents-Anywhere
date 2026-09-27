/**
 * On-disk credential + settings store (design §5.3, §1「凭据三层分离」).
 *
 * Layout under `~/.agents-anywhere/opencode-plugin/` (base honours
 * `AGENT_CONNECTOR_DATA_DIR`, the same override the endpoint registry uses):
 *
 *   settings.json                      only `apiBaseUrl` — never a secret
 *   account.json                       账号层: server / account id / access token
 *   bindings/<serverKey>/<accountId>.json  设备层: connector_id + connector token
 *   pending-flow.json                  进行中的回环 OAuth, 非凭据
 *
 * The layout mirrors the DSH/Connector convention (`~/.agents-anywhere`) so a
 * Desktop or DSH install can reuse the same identities.
 *
 * **Three credential layers never substitute for one another**: the account
 * token (account.json) is not the device token (bindings/…), and neither is the
 * 32-byte loopback endpoint token (`endpoint-store`, memory only). This module
 * owns the first two exclusively and never reads or writes the third.
 *
 * Every write is atomic (tmp → fsync → rename) and `0600` inside a `0700`
 * directory. Tokens/codes never reach a log: callers pass only paths and ids.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR_ENV, DATA_DIR_NAME } from './endpoint-store.js'

export const PLUGIN_DIR_NAME = 'opencode-plugin'
export const SETTINGS_FILE = 'settings.json'
export const ACCOUNT_FILE = 'account.json'
export const BINDINGS_DIR = 'bindings'
export const PENDING_FLOW_FILE = 'pending-flow.json'
export const CONNECTOR_RUNTIME_FILE = 'connector-runtime.json'

/** Credentials are stored with a version so a future migration is explicit. */
export const CREDENTIAL_VERSION = 1

/** An access token is treated as spent this long before its stated expiry. */
export const ACCOUNT_EXPIRY_SKEW_MS = 60_000

/** A pending loopback flow older than this is abandoned, never resumed. */
export const PENDING_FLOW_TTL_MS = 10 * 60_000

export interface PluginSettings {
  version: typeof CREDENTIAL_VERSION
  apiBaseUrl: string
}

/** 账号层. `accessToken` is a secret and must never be logged. */
export interface AccountCredential {
  version: typeof CREDENTIAL_VERSION
  apiBaseUrl: string
  userId: string
  displayName: string
  email: string | null
  accessToken: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/** 设备层. `connectorToken` is a secret and must never be logged. */
export interface BindingCredential {
  version: typeof CREDENTIAL_VERSION
  connectorId: string
  connectorToken: string
  name: string
  installationId: string
}

/** Non-secret record of an in-flight loopback OAuth (热重载后可安全重启). */
export interface PendingFlow {
  version: typeof CREDENTIAL_VERSION
  apiBaseUrl: string
  state: string
  verifier: string
  redirectUri: string
  createdAt: number
  deadline: number
}

/** The shared `~/.agents-anywhere/connector-runtime.json` lease record. */
export interface ConnectorRuntimeRecord {
  version?: number
  connectorIds: string[]
  runtime?: {
    pid?: number
    /** The Connector child, when the lease holder is a supervisor (uv/Desktop). */
    childPid?: number
    kind?: string
    instanceId?: string
    startedAt?: string
  }
  [key: string]: unknown
}

/** `<data-dir>/opencode-plugin`. */
export function pluginDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_DIR_ENV]
  const base = override && override.trim().length > 0 ? override : join(homedir(), DATA_DIR_NAME)
  return join(base, PLUGIN_DIR_NAME)
}

export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE)
}

export function accountPath(dataDir: string): string {
  return join(dataDir, ACCOUNT_FILE)
}

export function pendingFlowPath(dataDir: string): string {
  return join(dataDir, PENDING_FLOW_FILE)
}

/** The shared lease file lives one level *above* the plugin dir (Connector-owned). */
export function connectorRuntimePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_DIR_ENV]
  const base = override && override.trim().length > 0 ? override : join(homedir(), DATA_DIR_NAME)
  return join(base, CONNECTOR_RUNTIME_FILE)
}

/**
 * Stable directory key for one server origin. Hashing keeps a URL with odd
 * characters out of the path and makes the directory name fixed-length.
 */
export function serverKey(apiBaseUrl: string): string {
  const normalized = normalizeOrigin(apiBaseUrl)
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

export function accountKey(userId: string): string {
  const safe = userId.replace(/[^A-Za-z0-9._-]/g, '_')
  // Never let a value collapse into a path traversal or an empty name.
  if (safe.length === 0 || safe === '.' || safe === '..') {
    return `acct_${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`
  }
  return safe.slice(0, 128)
}

export function bindingPath(dataDir: string, apiBaseUrl: string, userId: string): string {
  return join(dataDir, BINDINGS_DIR, serverKey(apiBaseUrl), `${accountKey(userId)}.json`)
}

/** Bare origin (`scheme://host[:port]`) used as the identity of a server. */
export function normalizeOrigin(apiBaseUrl: string): string {
  try {
    const url = new URL(apiBaseUrl)
    return url.origin
  } catch {
    // An unparseable value is still keyed deterministically rather than throwing
    // from a read path; validation belongs to the caller that writes settings.
    return apiBaseUrl.trim().replace(/\/+$/, '')
  }
}

// ── atomic file primitives ────────────────────────────────────────────────────

/** Read + JSON-parse a file; a missing file is `null`, a corrupt file throws. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`corrupt JSON at ${path}`)
  }
}

/**
 * Write JSON atomically: a `0600` temp file in a `0700` directory, fsynced, then
 * renamed over the target. A reader sees either the old file or the complete new
 * one — never a partial write.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, path)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function removeFile(path: string): Promise<void> {
  await fs.rm(path, { force: true })
}

// ── settings (apiBaseUrl only) ────────────────────────────────────────────────

export async function readSettings(dataDir: string): Promise<PluginSettings | null> {
  const value = await readJsonFile<PluginSettings>(settingsPath(dataDir))
  if (value === null || typeof value !== 'object') return null
  if (typeof value.apiBaseUrl !== 'string' || value.apiBaseUrl.length === 0) return null
  return { version: CREDENTIAL_VERSION, apiBaseUrl: value.apiBaseUrl }
}

export async function saveSettings(dataDir: string, apiBaseUrl: string): Promise<PluginSettings> {
  const settings: PluginSettings = { version: CREDENTIAL_VERSION, apiBaseUrl }
  await writeJsonAtomic(settingsPath(dataDir), settings)
  return settings
}

// ── account (账号层) ──────────────────────────────────────────────────────────

export async function readAccount(dataDir: string): Promise<AccountCredential | null> {
  const value = await readJsonFile<AccountCredential>(accountPath(dataDir))
  if (value === null || typeof value !== 'object') return null
  if (typeof value.accessToken !== 'string' || value.accessToken.length === 0) return null
  if (typeof value.userId !== 'string' || value.userId.length === 0) return null
  if (typeof value.apiBaseUrl !== 'string' || value.apiBaseUrl.length === 0) return null
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null
  return {
    version: CREDENTIAL_VERSION,
    apiBaseUrl: value.apiBaseUrl,
    userId: value.userId,
    displayName: typeof value.displayName === 'string' ? value.displayName : value.userId,
    email: typeof value.email === 'string' ? value.email : null,
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
  }
}

export async function saveAccount(dataDir: string, account: AccountCredential): Promise<void> {
  await writeJsonAtomic(accountPath(dataDir), account)
}

export async function clearAccount(dataDir: string): Promise<void> {
  await removeFile(accountPath(dataDir))
}

/** Reuse-first gate: an unexpired token with a 60 s safety skew. */
export function accountIsUsable(
  account: AccountCredential | null,
  nowMs: number = Date.now(),
  skewMs: number = ACCOUNT_EXPIRY_SKEW_MS,
): account is AccountCredential {
  return account !== null && account.expiresAt - skewMs > nowMs
}

// ── binding (设备层) ──────────────────────────────────────────────────────────

export async function readBinding(
  dataDir: string,
  apiBaseUrl: string,
  userId: string,
): Promise<BindingCredential | null> {
  const value = await readJsonFile<BindingCredential>(bindingPath(dataDir, apiBaseUrl, userId))
  if (value === null || typeof value !== 'object') return null
  if (typeof value.connectorId !== 'string' || value.connectorId.length === 0) return null
  if (typeof value.connectorToken !== 'string' || value.connectorToken.length === 0) return null
  return {
    version: CREDENTIAL_VERSION,
    connectorId: value.connectorId,
    connectorToken: value.connectorToken,
    name: typeof value.name === 'string' ? value.name : 'OpenCode',
    installationId:
      typeof value.installationId === 'string' && value.installationId.length > 0
        ? value.installationId
        : value.connectorId,
  }
}

export async function saveBinding(
  dataDir: string,
  apiBaseUrl: string,
  userId: string,
  binding: BindingCredential,
): Promise<void> {
  await writeJsonAtomic(bindingPath(dataDir, apiBaseUrl, userId), binding)
}

export async function clearBinding(dataDir: string, apiBaseUrl: string, userId: string): Promise<void> {
  await removeFile(bindingPath(dataDir, apiBaseUrl, userId))
}

/**
 * Registration intent persisted **before** the HTTP request:
 *
 *   bindings/<serverKey>/<accountId>.pending.json   { installationId, name }
 *
 * The server derives the device id from `(user, installationId)` and answers a
 * *second* registration of the same key by rotating that device's token. If a
 * response is lost (timeout, reload, crash), retrying with the key we already
 * sent rotates the existing device instead of creating a second one — which is
 * only possible when the key outlives the request. It holds no secret and is
 * deleted the moment the binding (with the server-issued token) is saved.
 */
export interface PendingRegistration {
  version: typeof CREDENTIAL_VERSION
  installationId: string
  name: string
  createdAt: number
}

export const PENDING_REGISTRATION_SUFFIX = '.pending.json'

export function pendingRegistrationPath(dataDir: string, apiBaseUrl: string, userId: string): string {
  return `${bindingPath(dataDir, apiBaseUrl, userId)}${PENDING_REGISTRATION_SUFFIX}`
}

export async function readPendingRegistration(
  dataDir: string,
  apiBaseUrl: string,
  userId: string,
): Promise<PendingRegistration | null> {
  const value = await readJsonFile<PendingRegistration>(pendingRegistrationPath(dataDir, apiBaseUrl, userId))
  if (value === null || typeof value !== 'object') return null
  if (typeof value.installationId !== 'string' || value.installationId.length === 0) return null
  return {
    version: CREDENTIAL_VERSION,
    installationId: value.installationId,
    name: typeof value.name === 'string' && value.name.length > 0 ? value.name : 'OpenCode',
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0,
  }
}

export async function savePendingRegistration(
  dataDir: string,
  apiBaseUrl: string,
  userId: string,
  pending: PendingRegistration,
): Promise<void> {
  await writeJsonAtomic(pendingRegistrationPath(dataDir, apiBaseUrl, userId), pending)
}

export async function clearPendingRegistration(
  dataDir: string,
  apiBaseUrl: string,
  userId: string,
): Promise<void> {
  await removeFile(pendingRegistrationPath(dataDir, apiBaseUrl, userId))
}

// ── pending loopback flow (non-credential) ────────────────────────────────────

export async function readPendingFlow(dataDir: string): Promise<PendingFlow | null> {
  const value = await readJsonFile<PendingFlow>(pendingFlowPath(dataDir))
  if (value === null || typeof value !== 'object') return null
  if (typeof value.state !== 'string' || value.state.length === 0) return null
  if (typeof value.verifier !== 'string' || value.verifier.length === 0) return null
  if (typeof value.deadline !== 'number' || !Number.isFinite(value.deadline)) return null
  return {
    version: CREDENTIAL_VERSION,
    apiBaseUrl: typeof value.apiBaseUrl === 'string' ? value.apiBaseUrl : '',
    state: value.state,
    verifier: value.verifier,
    redirectUri: typeof value.redirectUri === 'string' ? value.redirectUri : '',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    deadline: value.deadline,
  }
}

/** A pending flow is only resumable while it is unexpired and still matched. */
export function pendingFlowIsLive(flow: PendingFlow | null, nowMs: number = Date.now()): flow is PendingFlow {
  return flow !== null && flow.deadline > nowMs
}

export async function savePendingFlow(dataDir: string, flow: PendingFlow): Promise<void> {
  await writeJsonAtomic(pendingFlowPath(dataDir), flow)
}

export async function clearPendingFlow(dataDir: string): Promise<void> {
  await removeFile(pendingFlowPath(dataDir))
}

// ── shared Connector lease record (reuse detection) ───────────────────────────

/**
 * Read the shared `connector-runtime.json`. Any malformed/absent file is `null`
 * (reuse is an optimisation, never a hard dependency).
 */
export async function readConnectorRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectorRuntimeRecord | null> {
  return readConnectorRuntimeAt(connectorRuntimePath(env))
}

/** Same parse, from an explicit path (the Connector's mutex ignores overrides). */
export async function readConnectorRuntimeAt(path: string): Promise<ConnectorRuntimeRecord | null> {
  let value: ConnectorRuntimeRecord | null
  try {
    value = await readJsonFile<ConnectorRuntimeRecord>(path)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const ids = Array.isArray(value.connectorIds)
    ? value.connectorIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
  return { ...value, connectorIds: ids }
}

/**
 * True when the shared lease record already knows this device id, i.e. another
 * Agents-Anywhere host has the same Connector identity on this machine. The
 * actual liveness oracle is the Connector's own OS lease (`connector_already_running`),
 * never a pid probe — a Windows pid can be reused.
 */
export function runtimeMentionsConnector(
  runtime: ConnectorRuntimeRecord | null,
  connectorId: string,
): boolean {
  return runtime !== null && connectorId.length > 0 && runtime.connectorIds.includes(connectorId)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
