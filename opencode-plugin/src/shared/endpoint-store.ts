/**
 * Endpoint registry files: `endpoints/<servicePid>-<port>.json`.
 *
 * Publication is atomic (tmp → fsync → replace) and the liveness oracle is a
 * successful handshake, never the recorded pid, so stale files are only cleaned
 * up when a probe says the endpoint is gone.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ENDPOINT_FILENAME_PATTERN, ENDPOINT_VERSION, PROTOCOL_VERSION, RUNTIME } from './protocol.js'

export const DATA_DIR_ENV = 'AGENT_CONNECTOR_DATA_DIR'
export const DATA_DIR_NAME = '.agents-anywhere'
export const BRIDGE_DIR_NAME = 'opencode-bridge'
export const ENDPOINTS_DIR_NAME = 'endpoints'

export interface EndpointRecord {
  version: typeof ENDPOINT_VERSION
  runtime: typeof RUNTIME
  protocolVersion: string
  bridgeId: string
  host: '127.0.0.1'
  port: number
  token: string
  pid: number
  serviceVersion?: string
  locations: string[]
  startedAt: string
}

export function isEndpointFileName(name: string): boolean {
  return ENDPOINT_FILENAME_PATTERN.test(name)
}

export function endpointFileName(pid: number, port: number): string {
  return `${pid}-${port}.json`
}

/**
 * Resolve the shared bridge directory (`<base>/opencode-bridge`), honours
 * `AGENT_CONNECTOR_DATA_DIR`. Both the endpoint registry and the TUI-written
 * session index live here.
 */
export function bridgeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DATA_DIR_ENV]
  const base = override && override.trim().length > 0 ? override : join(homedir(), DATA_DIR_NAME)
  return join(base, BRIDGE_DIR_NAME)
}

/** Resolve the endpoints directory; honours `AGENT_CONNECTOR_DATA_DIR`. */
export function endpointDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeDirectory(env), ENDPOINTS_DIR_NAME)
}

/** Leaf names of the plugin data dir (mirrors `credentials.PLUGIN_DIR_NAME`). */
const PLUGIN_DIR_NAME = 'opencode-plugin'
const CONNECTOR_DIR_NAME = 'connector'

/**
 * The data directory this plugin hands to the Connector it spawns as
 * `AGENT_CONNECTOR_DATA_DIR` (`<base>/opencode-plugin/connector`), mirroring the
 * supervisor's spawn env. Derived from `bridgeDirectory` so the
 * `AGENT_CONNECTOR_DATA_DIR` override applies identically on both sides.
 */
export function connectorDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(bridgeDirectory(env)), PLUGIN_DIR_NAME, CONNECTOR_DIR_NAME)
}

/**
 * The endpoint registry the plugin's own spawned Connector actually scans:
 * `<connector data dir>/opencode-bridge/endpoints`. Resolved through the same
 * `AGENT_CONNECTOR_DATA_DIR` convention as every other endpoint directory.
 */
export function connectorEndpointDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return endpointDirectory({ ...env, [DATA_DIR_ENV]: connectorDataDirectory(env) })
}

/**
 * Every registry this plugin publishes the same record into: the shared
 * default (`<base>/opencode-bridge/endpoints`) and the registry of the
 * Connector this plugin spawns. Without the second entry a Connector launched
 * with `AGENT_CONNECTOR_DATA_DIR=<base>/opencode-plugin/connector` never sees
 * the bridge endpoint.
 */
export function endpointDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([endpointDirectory(env), connectorEndpointDirectory(env)])]
}

/**
 * Atomically publish `record`. The reader either sees the previous file or the
 * complete new one — never a partial write.
 */
export async function publishEndpoint(directory: string, record: EndpointRecord): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const target = join(directory, endpointFileName(record.pid, record.port))
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(record), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, target)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  await fsyncDirectory(directory)
  return target
}

export async function removeEndpoint(path: string): Promise<void> {
  await fs.rm(path, { force: true })
}

/** List endpoint file paths in a registry directory (missing dir → empty). */
export async function scanEndpoints(directory: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return entries.filter(isEndpointFileName).sort().map((name) => join(directory, name))
}

/** Parse an endpoint file; structurally invalid files return `null`. */
export async function readEndpoint(path: string): Promise<EndpointRecord | null> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
  return parseEndpointRecord(raw)
}

export function parseEndpointRecord(raw: string): EndpointRecord | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record['version'] !== ENDPOINT_VERSION || record['runtime'] !== RUNTIME) return null
  if (record['host'] !== '127.0.0.1') return null
  if (typeof record['protocolVersion'] !== 'string' || record['protocolVersion'].length === 0) {
    return null
  }
  if (typeof record['token'] !== 'string' || record['token'].length === 0) return null
  if (typeof record['bridgeId'] !== 'string' || record['bridgeId'].length === 0) return null
  if (!isPositiveInt(record['port'])) return null
  if (!isPositiveInt(record['pid'])) return null
  const locations = Array.isArray(record['locations']) ? record['locations'] : []
  return {
    version: ENDPOINT_VERSION,
    runtime: RUNTIME,
    protocolVersion: record['protocolVersion'],
    bridgeId: record['bridgeId'],
    host: '127.0.0.1',
    port: record['port'] as number,
    token: record['token'],
    pid: record['pid'] as number,
    ...(typeof record['serviceVersion'] === 'string' ? { serviceVersion: record['serviceVersion'] } : {}),
    locations: locations.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
    startedAt: typeof record['startedAt'] === 'string' ? record['startedAt'] : new Date(0).toISOString(),
  }
}

/**
 * Remove residue: unreadable files, and any endpoint the liveness probe rejects
 * (pid reuse and OS restarts make pid-only checks unsafe). Returns removed paths.
 */
export async function cleanupStaleEndpoints(
  directory: string,
  isLive?: (record: EndpointRecord, path: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  const removed: string[] = []
  for (const path of await scanEndpoints(directory)) {
    const record = await readEndpoint(path)
    if (record === null) {
      await removeEndpoint(path)
      removed.push(path)
      continue
    }
    if (isLive && !(await isLive(record, path))) {
      await removeEndpoint(path)
      removed.push(path)
    }
  }
  return removed
}

export function makeEndpointRecord(input: {
  bridgeId: string
  port: number
  token: string
  pid: number
  locations: readonly string[]
  serviceVersion?: string
  startedAt?: string
}): EndpointRecord {
  return {
    version: ENDPOINT_VERSION,
    runtime: RUNTIME,
    protocolVersion: PROTOCOL_VERSION,
    bridgeId: input.bridgeId,
    host: '127.0.0.1',
    port: input.port,
    token: input.token,
    pid: input.pid,
    ...(input.serviceVersion !== undefined ? { serviceVersion: input.serviceVersion } : {}),
    locations: [...input.locations],
    startedAt: input.startedAt ?? new Date().toISOString(),
  }
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

async function fsyncDirectory(directory: string): Promise<void> {
  // Windows cannot fsync a directory handle; the rename above is still
  // metadata-durable there, so this is best-effort by design.
  try {
    const handle = await fs.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // ignore
  }
}
