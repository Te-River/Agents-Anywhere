import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  candidateRuntimePaths,
  defaultPidAlive,
  probeExistingConnector,
} from '../../src/server/connector-reuse.js'

async function withRecord(
  record: unknown,
  run: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  const path = join(dir, 'connector-runtime.json')
  await writeFile(path, JSON.stringify(record), 'utf8')
  try {
    await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// -- record probing (no real process is ever touched) -------------------------

test('a live owner bound to our device is a reuse decision', async () => {
  await withRecord(
    { version: 2, connectorIds: ['cxt_1'], runtime: { pid: 4242, kind: 'opencode-plugin', instanceId: 'i', startedAt: '' } },
    async (path) => {
      const probe = await probeExistingConnector({
        connectorId: 'cxt_1',
        runtimePaths: [path],
        pidAlive: (pid) => pid === 4242,
      })
      assert.equal(probe.decision, 'reuse')
      assert.equal(probe.pid, 4242)
      assert.equal(probe.kind, 'opencode-plugin')
      assert.match(probe.reason, /本设备/)
    },
  )
})

test('a live owner bound to another device is occupied, never a reuse', async () => {
  await withRecord(
    { version: 2, connectorIds: ['cxt_other'], runtime: { pid: 777, kind: 'desktop', instanceId: 'i', startedAt: '' } },
    async (path) => {
      const probe = await probeExistingConnector({
        connectorId: 'cxt_1',
        runtimePaths: [path],
        pidAlive: () => true,
      })
      assert.equal(probe.decision, 'occupied')
      assert.equal(probe.pid, 777)
      assert.match(probe.reason, /未绑定本设备/)
    },
  )
})

test('a dead owner pid falls back to spawning (none)', async () => {
  await withRecord(
    { version: 2, connectorIds: ['cxt_1'], runtime: { pid: 999, kind: 'opencode-plugin', instanceId: 'i', startedAt: '' } },
    async (path) => {
      const probe = await probeExistingConnector({
        connectorId: 'cxt_1',
        runtimePaths: [path],
        pidAlive: () => false,
      })
      assert.equal(probe.decision, 'none')
      assert.equal(probe.pid, null)
    },
  )
})

test('an absent record or record without an owner is none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  try {
    const missing = await probeExistingConnector({
      connectorId: 'cxt_1',
      runtimePaths: [join(dir, 'nope.json')],
      pidAlive: () => true,
    })
    assert.equal(missing.decision, 'none')

    const bare = join(dir, 'bare.json')
    await writeFile(bare, JSON.stringify({ version: 2, connectorIds: ['cxt_1'] }), 'utf8')
    const noOwner = await probeExistingConnector({
      connectorId: 'cxt_1',
      runtimePaths: [bare],
      pidAlive: () => true,
    })
    assert.equal(noOwner.decision, 'none')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the Connector child pid is preferred over the supervisor pid', async () => {
  await withRecord(
    { version: 2, connectorIds: ['cxt_1'], runtime: { pid: 111, childPid: 222, kind: 'desktop', instanceId: 'i', startedAt: '' } },
    async (path) => {
      const seen: number[] = []
      const probe = await probeExistingConnector({
        connectorId: 'cxt_1',
        runtimePaths: [path],
        pidAlive: (pid) => {
          seen.push(pid)
          return pid === 222
        },
      })
      assert.equal(probe.decision, 'reuse')
      assert.equal(probe.pid, 222)
      assert.deepEqual(seen, [222])
    },
  )
})

// -- path resolution + liveness oracle ----------------------------------------

test('candidate paths cover both the override and the Connector mutex', () => {
  const withOverride = candidateRuntimePaths({ AGENT_CONNECTOR_DATA_DIR: 'D:/custom-base' } as NodeJS.ProcessEnv)
  assert.equal(withOverride.length, 2)
  assert.ok(withOverride.some((path) => path.replaceAll('\\', '/').endsWith('D:/custom-base/connector-runtime.json')))
  assert.equal(withOverride.at(-1)?.replaceAll('\\', '/'), `${homedir()}/.agents-anywhere/connector-runtime.json`.replaceAll('\\', '/'))

  const defaulted = candidateRuntimePaths({} as NodeJS.ProcessEnv)
  assert.equal(defaulted.length, 1)
})

test('defaultPidAlive rejects non-pids and recognises this process', () => {
  assert.equal(defaultPidAlive(0), false)
  assert.equal(defaultPidAlive(-1), false)
  assert.equal(defaultPidAlive(2.5), false)
  assert.equal(defaultPidAlive(process.pid), true)
})
