import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub, HUB_GLOBAL_KEY, installPlugin } from '../../src/server/bridge-hub.js'
import {
  connectorEndpointDirectory,
  endpointDirectory,
  readEndpoint,
  scanEndpoints,
} from '../../src/shared/endpoint-store.js'
import { createTestCtx } from '../helpers/event-bus.js'

const HUB_SYMBOL = Symbol.for(HUB_GLOBAL_KEY)

function currentHub(): BridgeHub | undefined {
  const value = (globalThis as unknown as Record<symbol, unknown>)[HUB_SYMBOL]
  return value instanceof BridgeHub ? value : undefined
}

test('installPlugin is idempotent and reentrant: one hub, one listener, refcounted cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-lifecycle-'))
  const previous = process.env['AGENT_CONNECTOR_DATA_DIR']
  process.env['AGENT_CONNECTOR_DATA_DIR'] = dir
  try {
    const first = await installPlugin(createTestCtx({ directory: 'D:/proj/a' }))
    const hub = currentHub()
    assert.ok(hub, 'the first setup must create the hub')
    const port = hub.port

    // A second setup (second location, or a hot-reload replay) must adopt it.
    const second = await installPlugin(createTestCtx({ directory: 'D:/proj/b' }))
    assert.equal(currentHub(), hub, 'the second setup must adopt the existing hub')
    assert.equal(hub.port, port, 'no second listener may be created')

    const record = await readEndpoint(hub.endpointPath ?? '')
    assert.deepEqual(record?.locations, ['D:/proj/a', 'D:/proj/b'])
    assert.equal((await scanEndpoints(endpointDirectory(process.env))).length, 1)

    // Releasing one reference keeps the hub alive…
    await first()
    assert.equal(currentHub(), hub)
    assert.equal(hub.stopped, false)

    // …and releasing the last one tears everything down.
    await second()
    assert.equal(currentHub(), undefined, 'the global hub handle is released')
    assert.equal(hub.stopped, true)
    assert.deepEqual(await scanEndpoints(endpointDirectory(process.env)), [], 'the endpoint file is removed')
  } finally {
    if (previous === undefined) delete process.env['AGENT_CONNECTOR_DATA_DIR']
    else process.env['AGENT_CONNECTOR_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanup is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-lifecycle-'))
  const previous = process.env['AGENT_CONNECTOR_DATA_DIR']
  process.env['AGENT_CONNECTOR_DATA_DIR'] = dir
  try {
    const cleanup = await installPlugin(createTestCtx({ directory: 'D:/proj/a' }))
    await cleanup()
    await cleanup()
    assert.equal(currentHub(), undefined)
  } finally {
    if (previous === undefined) delete process.env['AGENT_CONNECTOR_DATA_DIR']
    else process.env['AGENT_CONNECTOR_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('a hub without a directory override publishes into the shared and Connector registries, then cleans both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-dual-'))
  const previous = process.env['AGENT_CONNECTOR_DATA_DIR']
  process.env['AGENT_CONNECTOR_DATA_DIR'] = dir
  try {
    const cleanup = await installPlugin(createTestCtx({ directory: 'D:/proj/a' }))
    const shared = endpointDirectory(process.env)
    const connector = connectorEndpointDirectory(process.env)
    assert.notEqual(shared, connector)

    const sharedPaths = await scanEndpoints(shared)
    const connectorPaths = await scanEndpoints(connector)
    assert.equal(sharedPaths.length, 1, 'the shared registry receives the endpoint')
    assert.equal(connectorPaths.length, 1, 'the spawned Connector registry receives the endpoint')
    assert.deepEqual(
      await readEndpoint(connectorPaths[0] ?? ''),
      await readEndpoint(sharedPaths[0] ?? ''),
      'both registries carry the identical record',
    )

    await cleanup()
    assert.deepEqual(await scanEndpoints(shared), [], 'the shared registry is cleaned')
    assert.deepEqual(await scanEndpoints(connector), [], 'the Connector registry is cleaned too')
  } finally {
    if (previous === undefined) delete process.env['AGENT_CONNECTOR_DATA_DIR']
    else process.env['AGENT_CONNECTOR_DATA_DIR'] = previous
    await rm(dir, { recursive: true, force: true })
  }
})
