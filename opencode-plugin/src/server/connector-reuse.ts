/**
 * Reuse-first Connector discovery (design §5.1 step 2; user decision: when a
 * usable Connector already runs on this machine, **reuse it and never spawn a
 * second one**).
 *
 * The Python Connector owns exactly ONE per-user record — the OS-lease mutex at
 * `<home>/.agents-anywhere/connector-runtime.json` — and every launch source
 * (CLI, AA Desktop, DSH bridge, this plugin) shares it (DSH README:164, contract
 * local-machine/2.0). Desktop and DSH do **not** write a different file, so a
 * single read of that record covers all three sources named in the brief.
 *
 * A live owner pid that already lists our device id is the reuse signal; a live
 * pid bound to another device is `occupied` (the machine-wide lease cannot be
 * taken twice); no live owner is `none`. The pid probe is deliberately a
 * heuristic — a Windows pid can be recycled — so the Connector's own TCP-port
 * lease stays the authoritative oracle: `occupied` still falls through to a
 * spawn attempt whose `connector_already_running` reply is treated as success.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CONNECTOR_RUNTIME_FILE,
  connectorRuntimePath,
  readConnectorRuntimeAt,
  type ConnectorRuntimeRecord,
} from '../shared/credentials.js'
import { DATA_DIR_NAME } from '../shared/endpoint-store.js'

export type ExistingConnectorDecision = 'reuse' | 'occupied' | 'none'

export interface ExistingConnectorProbe {
  decision: ExistingConnectorDecision
  /** Human-readable, credential-free justification for the log line. */
  reason: string
  kind: string | null
  pid: number | null
}

export interface ProbeExistingConnectorOptions {
  env?: NodeJS.ProcessEnv
  connectorId: string
  /** Override the record paths (tests inject one temp file and stay isolated). */
  runtimePaths?: readonly string[]
  /** Injectable liveness oracle; production uses `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean
}

/** Conservative liveness probe: an unknown result (`EPERM`) counts as alive. */
export function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/**
 * The Connector's own mutex path may not be relocated, so the canonical file is
 * always checked; the plugin's override-derived path is checked too, because a
 * self-hosted base directory relocates the whole `~/.agents-anywhere` tree.
 */
export function candidateRuntimePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const canonical = join(homedir(), DATA_DIR_NAME, CONNECTOR_RUNTIME_FILE)
  const derived = connectorRuntimePath(env)
  return derived === canonical ? [canonical] : [derived, canonical]
}

interface LiveOwner {
  kind: string | null
  pid: number
}

function liveOwner(
  record: ConnectorRuntimeRecord | null,
  alive: (pid: number) => boolean,
): LiveOwner | null {
  const owner = record?.runtime
  if (owner === undefined) return null
  const candidates: number[] = []
  if (typeof owner.childPid === 'number' && owner.childPid > 0) candidates.push(owner.childPid)
  if (typeof owner.pid === 'number' && owner.pid > 0) candidates.push(owner.pid)
  for (const pid of candidates) {
    if (alive(pid)) {
      return {
        kind: typeof owner.kind === 'string' && owner.kind.length > 0 ? owner.kind : null,
        pid,
      }
    }
  }
  return null
}

export async function probeExistingConnector(
  options: ProbeExistingConnectorOptions,
): Promise<ExistingConnectorProbe> {
  const alive = options.pidAlive ?? defaultPidAlive
  const paths = options.runtimePaths ?? candidateRuntimePaths(options.env)
  for (const path of paths) {
    const record = await readConnectorRuntimeAt(path)
    const live = liveOwner(record, alive)
    if (live === null || record === null) continue
    if (record.connectorIds.includes(options.connectorId)) {
      return {
        decision: 'reuse',
        reason: `本机记录已绑定本设备且进程存活（kind=${live.kind ?? 'unknown'}, pid=${live.pid}）`,
        kind: live.kind,
        pid: live.pid,
      }
    }
    return {
      decision: 'occupied',
      reason: `本机已有存活的 Connector（kind=${live.kind ?? 'unknown'}, pid=${live.pid}）但未绑定本设备`,
      kind: live.kind,
      pid: live.pid,
    }
  }
  return { decision: 'none', reason: '本机未发现存活的 Connector', kind: null, pid: null }
}
