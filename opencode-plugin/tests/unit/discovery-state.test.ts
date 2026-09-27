import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { SessionRegistry } from '../../src/server/session-registry.js'
import { createLogger } from '../../src/shared/logger.js'
import { BRIDGE_NOTIFICATION_METHODS, CAPABILITY_IDS } from '../../src/shared/protocol.js'
import { FakeBridgeClient } from '../helpers/bridge-client.js'
import { sessionEvent } from '../helpers/event-bus.js'

const SILENT = createLogger('test', () => undefined)
const DIRECTORY = 'D:/proj/a'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * F1 (rev3 ruling 2): the Hub can never *prove* it has seen every session — its
 * registry is fed only by the global event stream (cold-start blind spot), and
 * the platform exposes no full-reconciliation channel. `complete` is therefore
 * unreachable, and this suite pins that honest state: `partial` forever, and no
 * notification claiming otherwise.
 */
test('discovery stays partial no matter how busy the event stream is', () => {
  const registry = new SessionRegistry({ logger: SILENT })
  assert.equal(registry.partial, true)
  for (let i = 0; i < 25; i += 1) {
    registry.ingest(sessionEvent('session.next.prompted', `ses_${i}`, DIRECTORY, { text: 'x' }))
  }
  // A quiet period or a large backlog is not coverage: the pre-existing sessions
  // we never hear from are still invisible.
  assert.equal(registry.partial, true, 'a busy stream is not full coverage')
  assert.equal(registry.list().length, 25)
})

test('getCapabilities reports session.discovery as partial with a reason, never complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-discovery-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, logger: SILENT })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    const capabilities = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{ capabilityId: string; metadata: Record<string, unknown> }>
      metadata: Record<string, unknown>
    }
    const row = capabilities.capabilities.find(
      (item) => item.capabilityId === CAPABILITY_IDS.sessionDiscovery,
    )
    assert.equal(row?.metadata['discoveryState'], 'partial')
    assert.equal(typeof row?.metadata['reason'], 'string', 'partial must explain why it is partial')
    assert.ok((row?.metadata['reason'] as string).length > 0)
    // The capability set-level metadata mirrors it; `complete` is never claimed.
    assert.equal(capabilities.metadata['discoveryState'], 'partial')
    assert.notEqual(capabilities.metadata['discoveryState'], 'complete')
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the hub never emits a capability update it cannot back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-discovery-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, logger: SILENT })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    for (let i = 0; i < 20; i += 1) {
      hub.ingest(sessionEvent('session.next.prompted', `ses_${i}`, DIRECTORY, { text: 'x' }))
    }
    await delay(20)
    // No fake partial→complete flip: the dead `broadcast()` helper was removed
    // rather than wired to an unreachable trigger, and no capability-update
    // notification is ever sent.
    assert.equal(typeof (hub as unknown as Record<string, unknown>)['broadcast'], 'undefined')
    assert.deepEqual(
      client.notifications
        .map((notice) => notice.method)
        .filter((method) => method === BRIDGE_NOTIFICATION_METHODS.capabilityUpdated),
      [],
    )
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the capability-update notification name is single-sourced and canonical', () => {
  // Mirrors `server/runtime_host.py` and the dsh-bridge-next runtime: one name.
  assert.equal(BRIDGE_NOTIFICATION_METHODS.capabilityUpdated, 'runtime.capability.updated')
})
