import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { createLogger } from '../../src/shared/logger.js'
import { createTestCtx, createTestEventBus, sessionEvent } from '../helpers/event-bus.js'

const SILENT = createLogger('test', () => undefined)
const DIR_A = 'D:/proj/a'
const DIR_B = 'D:/proj/b'

async function withHub(run: (hub: BridgeHub, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-filter-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, logger: SILENT })
  try {
    await run(hub, dir)
  } finally {
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('events from another location never cross into this process timeline', async () => {
  await withHub(async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))

    assert.equal(hub.ingest(sessionEvent('session.next.prompted', 'ses_a', DIR_A, { text: 'in' })), true)
    assert.equal(
      hub.ingest(sessionEvent('session.next.prompted', 'ses_b', DIR_B, { text: 'out' })),
      false,
      'a cross-location event must be filtered out',
    )

    assert.equal(hub.sessions.list().length, 1)
    assert.equal(hub.sessions.list()[0]?.nativeId, 'ses_a')
    assert.equal(hub.metrics.filteredEvents, 1)
    assert.equal(hub.sessions.filtered.byLocation, 1)
    assert.equal(hub.metrics.acceptedEvents, 1)
  })
})

test('unrelated domain events are dropped by the type filter', async () => {
  await withHub(async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))
    for (const type of ['provider.updated', 'models-dev.refreshed', 'message.updated']) {
      assert.equal(hub.ingest({ type, location: { directory: DIR_A }, data: {} }), false, `${type} must be filtered`)
    }
    assert.equal(hub.sessions.size, 0)
    assert.equal(hub.sessions.filtered.byType, 3)
  })
})

test('the single subscription double-filters end to end', async () => {
  await withHub(async (hub) => {
    const bus = createTestEventBus()
    const cleanup = await hub.install(createTestCtx({ directory: DIR_A, bus }))
    assert.equal(bus.receivedSubscriptions, 1, 'exactly one full subscription')

    bus.push(sessionEvent('session.next.prompted', 'ses_a', DIR_A, { text: 'mine' }))
    bus.push(sessionEvent('session.next.prompted', 'ses_b', DIR_B, { text: 'theirs' }))
    bus.push({ type: 'provider.updated', location: { directory: DIR_A }, data: {} })
    await delay(30)

    assert.deepEqual(
      hub.sessions.list().map((record) => record.nativeId),
      ['ses_a'],
    )
    await cleanup()
  })
})

test('a second install on the same hub does not re-subscribe', async () => {
  await withHub(async (hub) => {
    const bus = createTestEventBus()
    const first = await hub.install(createTestCtx({ directory: DIR_A, bus }))
    const second = await hub.install(createTestCtx({ directory: DIR_B, bus }))
    assert.equal(bus.receivedSubscriptions, 1)
    assert.equal(hub.projector.counters().sessions, 0)
    await first()
    await second()
  })
})
