/**
 * Our own Connector ownership record — the half of the reuse probe the plugin
 * did not have.
 *
 * `connector-reuse.ts` reads the *shared* `~/.agents-anywhere/connector-runtime.json`
 * lease, which names whichever host claimed the machine-wide Connector (AA
 * Desktop, the DSH bridge, another OpenCode). A Connector **this plugin** spawned
 * is invisible in that record whenever the lease belongs to a different device —
 * the real-machine case that produced the duplicate `uv` trees: that record read
 * `connectorIds: ['conn_q4KVr_R8ywQn4w']`, `kind: 'desktop-workbench'`,
 * `serverUrl: 'https://web.agents-anywhere.com'`, while our device is
 * `conn_958d7523…` on `http://127.0.0.1:8000`. Every `resume()` therefore decided
 * `occupied` and spawned yet another Connector for the same device id.
 *
 * This module owns the record only we write — `<plugin data dir>/connector/
 * owner.json` — so a later `setup()` (hot reload, a second location, a fresh
 * process) can *adopt* the child that is already running instead of spawning a
 * second one, and an explicit stop can name exactly the pid we started.
 *
 * Two independent fields, both optional:
 *   `child`   — the pid of the Connector tree we launched.
 *   `blocked` — we tried to spawn and the machine-wide lease is held by another
 *               host, so every further spawn attempt is known-doomed until that
 *               pid goes away (`connector/core/control.py:112` refuses `start`
 *               with `connector_already_running` in exactly this state).
 *
 * Nothing in this file signals a process; killing stays in
 * `connector-supervisor.ts`.
 */

import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../shared/credentials.js'
import { defaultPidAlive } from './connector-reuse.js'

export const OWNERSHIP_FILE = 'owner.json'

/** The Connector tree this plugin launched, recorded at spawn time. */
export interface ConnectorChildRecord {
  pid: number
  connectorId: string
  /** The Connector's own sqlite state path, so a reader can tell the two apart. */
  childStatePath: string
  spawnedAt: number
}

/** A spawn we know cannot succeed until the named pid exits. */
export interface ForeignBlockRecord {
  kind: string | null
  pid: number | null
  connectorId: string
  at: number
}

export interface ConnectorOwnershipState {
  child: ConnectorChildRecord | null
  blocked: ForeignBlockRecord | null
}

export interface OwnConnectorProbe {
  /** A live Connector that *we* started exists for this device. */
  own: boolean
  pid: number | null
  reason: string
}

export interface ForeignBlockProbe {
  blocked: boolean
  kind: string | null
  pid: number | null
  reason: string
}

export function ownershipPath(dataDir: string): string {
  return join(dataDir, OWNERSHIP_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function readChild(value: unknown): ConnectorChildRecord | null {
  if (!isRecord(value)) return null
  const pid = positiveInt(value['pid'])
  const connectorId = value['connectorId']
  if (pid === null || typeof connectorId !== 'string' || connectorId.length === 0) return null
  return {
    pid,
    connectorId,
    childStatePath: typeof value['childStatePath'] === 'string' ? value['childStatePath'] : '',
    spawnedAt: typeof value['spawnedAt'] === 'number' ? value['spawnedAt'] : 0,
  }
}

function readBlocked(value: unknown): ForeignBlockRecord | null {
  if (!isRecord(value)) return null
  return {
    kind: typeof value['kind'] === 'string' && value['kind'].length > 0 ? value['kind'] : null,
    pid: positiveInt(value['pid']),
    connectorId: typeof value['connectorId'] === 'string' ? value['connectorId'] : '',
    at: typeof value['at'] === 'number' ? value['at'] : 0,
  }
}

/**
 * Read our record. Fail-soft by design: this file only ever *optimises* a
 * decision, so a missing/corrupt/half-written file degrades to "no record"
 * instead of breaking a connect attempt.
 */
export async function readOwnership(dataDir: string): Promise<ConnectorOwnershipState> {
  try {
    const raw = await readJsonFile<Record<string, unknown>>(ownershipPath(dataDir))
    if (raw === null) return { child: null, blocked: null }
    return { child: readChild(raw['child']), blocked: readBlocked(raw['blocked']) }
  } catch {
    return { child: null, blocked: null }
  }
}

async function mergeState(
  dataDir: string,
  apply: (state: ConnectorOwnershipState) => ConnectorOwnershipState,
): Promise<void> {
  const next = apply(await readOwnership(dataDir))
  await writeJsonAtomic(ownershipPath(dataDir), next)
}

/** Record the child we just launched (keeps any `blocked` marker). */
export async function setOwnChild(dataDir: string, child: ConnectorChildRecord): Promise<void> {
  await mergeState(dataDir, (state) => ({ ...state, child }))
}

/** Drop the child record; when `pid` is given, only that pid's record is dropped. */
export async function clearOwnChild(dataDir: string, pid?: number): Promise<void> {
  await mergeState(dataDir, (state) => {
    if (pid !== undefined && state.child !== null && state.child.pid !== pid) return state
    return { ...state, child: null }
  })
}

/** Remember that the machine-wide lease is held by another host. */
export async function setBlocked(dataDir: string, blocked: ForeignBlockRecord): Promise<void> {
  await mergeState(dataDir, (state) => ({ ...state, blocked }))
}

export async function clearBlocked(dataDir: string): Promise<void> {
  await mergeState(dataDir, (state) => (state.blocked === null ? state : { ...state, blocked: null }))
}

export interface ProbeOwnConnectorOptions {
  dataDir: string
  connectorId: string
  /** Injectable liveness oracle; production uses `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean
}

/**
 * Is a Connector *we* started already running for this device? This is the
 * reuse signal that survives a hot reload, a second `setup()` and a process
 * restart — the shared lease record cannot answer it (see the module header).
 */
export async function probeOwnConnector(options: ProbeOwnConnectorOptions): Promise<OwnConnectorProbe> {
  const alive = options.pidAlive ?? defaultPidAlive
  const { child } = await readOwnership(options.dataDir)
  if (child === null) {
    return { own: false, pid: null, reason: '未发现本插件自己启动的 Connector 记录' }
  }
  if (child.connectorId !== options.connectorId) {
    return {
      own: false,
      pid: child.pid,
      reason: `本插件的 Connector 记录属于别的设备（${child.connectorId}）`,
    }
  }
  if (!alive(child.pid)) {
    return { own: false, pid: child.pid, reason: `本插件启动的 Connector（pid=${child.pid}）已退出` }
  }
  return { own: true, pid: child.pid, reason: `本插件启动的 Connector 仍在运行（pid=${child.pid}）` }
}

/**
 * Is a spawn attempt known-doomed because another host holds the machine-wide
 * Connector lease? Only a *live* holder blocks: as soon as its pid is gone the
 * marker is stale and the caller may try again.
 */
export async function probeForeignBlock(options: ProbeOwnConnectorOptions): Promise<ForeignBlockProbe> {
  const alive = options.pidAlive ?? defaultPidAlive
  const { blocked } = await readOwnership(options.dataDir)
  const idle: ForeignBlockProbe = { blocked: false, kind: null, pid: null, reason: '没有其它 Connector 占用本机租约' }
  if (blocked === null) return idle
  const kind = blocked.kind
  if (blocked.pid === null) {
    // No pid to verify against: never let a stale marker block a retry forever.
    return { ...idle, kind, reason: '占用记录缺少 pid，无法确认，按可重试处理' }
  }
  if (!alive(blocked.pid)) {
    return { ...idle, kind, pid: blocked.pid, reason: `上次占用的 Connector（pid=${blocked.pid}）已退出，可以重试` }
  }
  return {
    blocked: true,
    kind,
    pid: blocked.pid,
    reason: `本机 Connector 租约仍被占用（kind=${kind ?? 'unknown'}, pid=${blocked.pid}）`,
  }
}
