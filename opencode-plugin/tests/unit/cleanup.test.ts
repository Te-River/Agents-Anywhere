import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupRequested, runCleanup } from '../../src/server/cleanup.js'
import { createLogger } from '../../src/shared/logger.js'

const SILENT = createLogger('test', () => undefined)

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('cleanupRequested only accepts the documented truthy spellings', () => {
  assert.equal(cleanupRequested({ AGENT_AA_CLEANUP: '1' } as NodeJS.ProcessEnv), true)
  assert.equal(cleanupRequested({ AGENT_AA_CLEANUP: 'TRUE' } as NodeJS.ProcessEnv), true)
  assert.equal(cleanupRequested({ AGENT_AA_CLEANUP: ' yes ' } as NodeJS.ProcessEnv), true)
  assert.equal(cleanupRequested({ AGENT_AA_CLEANUP: '0' } as NodeJS.ProcessEnv), false)
  assert.equal(cleanupRequested({} as NodeJS.ProcessEnv), false)
})

test('runCleanup removes local state, stops our Connector, and leaves the shared record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-cleanup-'))
  const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv
  const pluginDir = join(root, 'opencode-plugin')
  const bridgeDir = join(root, 'opencode-bridge')
  const sharedRecord = join(root, 'connector-runtime.json')
  try {
    await mkdir(join(pluginDir, 'bindings', 'srv'), { recursive: true })
    await mkdir(join(pluginDir, 'connector'), { recursive: true })
    await mkdir(join(bridgeDir, 'endpoints'), { recursive: true })
    await writeFile(join(pluginDir, 'settings.json'), JSON.stringify({ version: 1, apiBaseUrl: 'https://api.example.com' }), 'utf8')
    await writeFile(
      join(pluginDir, 'bindings', 'srv', 'user.json'),
      JSON.stringify({ version: 1, connectorId: 'cxt_1', connectorToken: 'super-secret-token' }),
      'utf8',
    )
    await writeFile(
      join(pluginDir, 'connector', 'connector.json'),
      JSON.stringify({ connectorId: 'cxt_1', connectorToken: 'super-secret-token' }),
      'utf8',
    )
    await writeFile(join(bridgeDir, 'endpoints', '1-2.json'), '{}', 'utf8')
    await writeFile(
      sharedRecord,
      JSON.stringify({
        version: 2,
        connectorIds: ['cxt_1'],
        runtime: { pid: process.pid, kind: 'opencode-plugin', instanceId: 'i', startedAt: '' },
      }),
      'utf8',
    )

    const stopped: number[] = []
    const result = await runCleanup({ env, logger: SILENT, stopProcess: (pid) => { stopped.push(pid) } })

    assert.deepEqual(stopped, [process.pid], 'only our own device Connector is stopped')
    assert.equal(result.stoppedConnectorPid, process.pid)
    assert.equal(result.removedPluginData, true)
    assert.equal(result.removedBridgeDir, true)
    assert.equal(await exists(pluginDir), false)
    assert.equal(await exists(bridgeDir), false)
    assert.equal(await exists(sharedRecord), true, 'the machine-wide record is never deleted from inside the plugin')
    assert.equal(JSON.stringify(result).includes('super-secret-token'), false)
    assert.ok(result.notes.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runCleanup never stops a Connector that is not bound to our device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-cleanup-'))
  const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv
  try {
    await mkdir(join(root, 'opencode-plugin', 'bindings', 'srv'), { recursive: true })
    await writeFile(
      join(root, 'opencode-plugin', 'bindings', 'srv', 'user.json'),
      JSON.stringify({ connectorId: 'cxt_ours' }),
      'utf8',
    )
    await writeFile(
      join(root, 'connector-runtime.json'),
      JSON.stringify({
        version: 2,
        connectorIds: ['cxt_theirs'],
        runtime: { pid: process.pid, kind: 'desktop', instanceId: 'i', startedAt: '' },
      }),
      'utf8',
    )

    const stopped: number[] = []
    const result = await runCleanup({ env, logger: SILENT, stopProcess: (pid) => { stopped.push(pid) } })
    assert.deepEqual(stopped, [])
    assert.equal(result.stoppedConnectorPid, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
