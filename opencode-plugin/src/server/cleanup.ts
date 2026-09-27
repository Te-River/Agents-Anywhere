/**
 * Explicit uninstall / cleanup path (audit M3).
 *
 * The plugin owns no CLI and the TUI entry's load form is unproven (A10), so the
 * one reliably reachable switch is an environment flag honoured at plugin
 * startup: `AGENT_AA_CLEANUP=1`. It stops a Connector this plugin owns (whole
 * process tree), then deletes this plugin's own data directory
 * (`<base>/opencode-plugin`): settings, the account token, the device bindings,
 * the in-flight OAuth record, and the Connector's `connector.json` — which
 * carries the device token in plaintext — plus its sqlite state. It also removes
 * the `opencode-bridge/` endpoint directory this plugin published.
 *
 * It deliberately does NOT delete the machine-wide `connector-runtime.json`
 * (shared with AA Desktop / the CLI, per the local-machine/2.0 contract) nor the
 * installed plugin package under `~/.cache/opencode/packages/…`. Deleting those
 * from inside a running plugin would either corrupt another product's state or
 * delete the running code; the README's residue list carries the manual steps.
 *
 * Nothing here ever logs a token: the result is booleans, paths and pids only.
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BINDINGS_DIR,
  pluginDataDir,
  readConnectorRuntime,
  readJsonFile,
} from '../shared/credentials.js'
import { endpointDirectory } from '../shared/endpoint-store.js'
import { createLogger, type Logger } from '../shared/logger.js'
import { defaultPidAlive } from './connector-reuse.js'
import { killProcessTree } from './connector-supervisor.js'

export const CLEANUP_ENV = 'AGENT_AA_CLEANUP'

export function cleanupRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CLEANUP_ENV]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export interface CleanupResult {
  pluginDataDir: string
  bridgeDir: string
  removedPluginData: boolean
  removedBridgeDir: boolean
  stoppedConnectorPid: number | null
  /** Manual follow-ups (shared record, package cache) — never a credential. */
  notes: string[]
}

export interface CleanupOptions {
  env?: NodeJS.ProcessEnv
  logger?: Logger
  /** Stops the process (injectable; default kills the whole tree). */
  stopProcess?: (pid: number) => void | Promise<void>
}

/** Device ids this plugin registered, read from its own binding files. */
async function ownedConnectorIds(pluginDir: string): Promise<string[]> {
  const dir = join(pluginDir, BINDINGS_DIR)
  let entries: string[]
  try {
    entries = await fs.readdir(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const value = await readJsonFile<Record<string, unknown>>(join(dir, entry)).catch(() => null)
    const id = value?.['connectorId']
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  const env = options.env ?? process.env
  const logger = options.logger ?? createLogger('cleanup')
  const pluginDir = pluginDataDir(env)
  const bridgeDir = dirname(endpointDirectory(env))

  // Stop only a Connector bound to one of our own devices; a Connector serving
  // another product on this machine is that product's to stop.
  let stoppedConnectorPid: number | null = null
  const owned = await ownedConnectorIds(pluginDir)
  if (owned.length > 0) {
    const record = await readConnectorRuntime(env)
    const owner = record?.runtime
    const pid =
      typeof owner?.childPid === 'number' && owner.childPid > 0
        ? owner.childPid
        : typeof owner?.pid === 'number' && owner.pid > 0
          ? owner.pid
          : null
    if (
      record !== null &&
      pid !== null &&
      defaultPidAlive(pid) &&
      record.connectorIds.some((id) => owned.includes(id))
    ) {
      const stop = options.stopProcess ?? ((target: number) => killProcessTree(target, true))
      await stop(pid)
      stoppedConnectorPid = pid
      logger.info('已停止本插件启动的 Connector', { pid })
    }
  }

  const removedPluginData = await removeTree(pluginDir)
  const removedBridgeDir = await removeTree(bridgeDir)

  return {
    pluginDataDir: pluginDir,
    bridgeDir,
    removedPluginData,
    removedBridgeDir,
    stoppedConnectorPid,
    notes: [
      '未删除机器级 connector-runtime.json（与 AA Desktop / CLI 共用），如需清理请手动删除 ~/.agents-anywhere/connector-runtime.json',
      '未删除已安装的插件包缓存（~/.cache/opencode/packages/<spec>/），请在 OpenCode 卸载插件后手动删除',
    ],
  }
}

/** Remove a directory tree; `false` when it did not exist. */
async function removeTree(path: string): Promise<boolean> {
  try {
    await fs.access(path)
  } catch {
    return false
  }
  await fs.rm(path, { recursive: true, force: true })
  return true
}
