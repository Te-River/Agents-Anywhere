import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearOwnChild,
  ownershipPath,
  probeForeignBlock,
  probeOwnConnector,
  readOwnership,
  setBlocked,
  setOwnChild,
} from '../../src/server/connector-ownership.js'

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-owner-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// -- our own child (the reuse signal the shared lease cannot give) -------------

test('an absent ownership record is "not ours" and does not block', async () => {
  await withDir(async (dir) => {
    const own = await probeOwnConnector({ dataDir: dir, connectorId: 'cxt_1', pidAlive: () => true })
    assert.equal(own.own, false)
    assert.equal(own.pid, null)
    const foreign = await probeForeignBlock({ dataDir: dir, connectorId: 'cxt_1', pidAlive: () => true })
    assert.equal(foreign.blocked, false)
  })
})

test('a live child we launched for our device is adoptable across a reload', async () => {
  await withDir(async (dir) => {
    await setOwnChild(dir, { pid: 4242, connectorId: 'cxt_1', childStatePath: join(dir, 'cxt_1.sqlite3'), spawnedAt: 1 })
    const own = await probeOwnConnector({ dataDir: dir, connectorId: 'cxt_1', pidAlive: (pid) => pid === 4242 })
    assert.equal(own.own, true)
    assert.equal(own.pid, 4242)
    assert.match(own.reason, /仍在运行/)
  })
})

test('a child record for a different device or a dead pid is not ours', async () => {
  await withDir(async (dir) => {
    await setOwnChild(dir, { pid: 4242, connectorId: 'cxt_1', childStatePath: '', spawnedAt: 1 })
    const other = await probeOwnConnector({ dataDir: dir, connectorId: 'cxt_2', pidAlive: () => true })
    assert.equal(other.own, false)
    assert.match(other.reason, /别的设备/)
    const dead = await probeOwnConnector({ dataDir: dir, connectorId: 'cxt_1', pidAlive: () => false })
    assert.equal(dead.own, false)
    assert.match(dead.reason, /已退出/)
  })
})

test('clearOwnChild only drops the matching pid, so a newer child is not erased', async () => {
  await withDir(async (dir) => {
    await setOwnChild(dir, { pid: 111, connectorId: 'cxt_1', childStatePath: '', spawnedAt: 1 })
    await clearOwnChild(dir, 999)
    assert.equal((await readOwnership(dir)).child?.pid, 111)
    await clearOwnChild(dir, 111)
    assert.equal((await readOwnership(dir)).child, null)
  })
})

// -- the foreign-block marker (a known-doomed spawn must not repeat) -----------

test('a live foreign holder blocks, and a dead one is treated as stale', async () => {
  await withDir(async (dir) => {
    await setBlocked(dir, { kind: 'desktop-workbench', pid: 24080, connectorId: 'cxt_1', at: 1 })
    const blocked = await probeForeignBlock({ dataDir: dir, connectorId: 'cxt_1', pidAlive: (pid) => pid === 24080 })
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.kind, 'desktop-workbench')
    assert.equal(blocked.pid, 24080)
    const stale = await probeForeignBlock({ dataDir: dir, connectorId: 'cxt_1', pidAlive: () => false })
    assert.equal(stale.blocked, false)
    assert.match(stale.reason, /已退出/)
  })
})

test('a block record without a pid never blocks a retry', async () => {
  await withDir(async (dir) => {
    await setBlocked(dir, { kind: null, pid: null, connectorId: 'cxt_1', at: 1 })
    const probe = await probeForeignBlock({ dataDir: dir, connectorId: 'cxt_1', pidAlive: () => true })
    assert.equal(probe.blocked, false)
    assert.match(probe.reason, /缺少 pid/)
  })
})

test('the ownership record lives beside the Connector data and degrades to none on garbage', async () => {
  await withDir(async (dir) => {
    assert.equal(ownershipPath(dir), join(dir, 'owner.json'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(ownershipPath(dir), 'not json', 'utf8')
    const own = await probeOwnConnector({ dataDir: dir, connectorId: 'cxt_1', pidAlive: () => true })
    assert.equal(own.own, false)
  })
})
