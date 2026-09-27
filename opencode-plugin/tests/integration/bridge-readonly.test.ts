import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { createLogger } from '../../src/shared/logger.js'
import { scanEndpoints } from '../../src/shared/endpoint-store.js'
import {
  contentHash,
  platformSessionId,
  RUNTIME_STATUSES,
  type TimelineItem,
} from '../../src/shared/protocol.js'
import type { OpenCodeEvent, OpenCodePluginContext } from '../../src/server/opencode-ctx.js'
import { expectRpcError, FakeBridgeClient } from '../helpers/bridge-client.js'

const SILENT = createLogger('test', () => undefined)
const NATIVE = 'ses_native'
const DIRECTORY = 'D:/proj/a'

function idleStream(): AsyncIterable<OpenCodeEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
}

/**
 * §6 capability derivation: the write rows (`session.send_message` /
 * `session.interrupt` / `session.interaction.approval`) are now derived from the
 * real `install()` host surface, so this read-only flow installs a ctx exactly
 * like the OpenCode host does.
 */
function readonlyCtx(directory: string): OpenCodePluginContext {
  const noop = (): Record<string, never> => ({})
  return {
    location: { directory },
    app: { version: '2.0.18' },
    event: { subscribe: () => idleStream() },
    session: { create: noop, prompt: noop, interrupt: noop, switchModel: noop, switchAgent: noop },
    permission: { hook: () => ({ dispose: () => undefined }), reply: noop },
  }
}

function event(type: string, data: Record<string, unknown>, durableSeq?: number): OpenCodeEvent {
  return {
    id: `${type}:${Math.random().toString(36).slice(2, 8)}`,
    created: '2026-01-01T00:00:00.000Z',
    type,
    location: { directory: DIRECTORY },
    data: { sessionID: NATIVE, ...data },
    ...(durableSeq !== undefined ? { durable: { aggregateID: NATIVE, seq: durableSeq, version: 1 } } : {}),
  }
}

/**
 * End-to-end read-only flow driven by a fake bridge client. It exercises the
 * exact field names the real Connector decodes
 * (`connector/runtimes/opencode/bridge/{client,models}.py`) without starting a
 * real OpenCode service.
 */
test('read-only flow: initialize → ping → getCapabilities → session.list → getSnapshot → state → notices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-integration-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, serviceVersion: '2.0.18', logger: SILENT })
  await hub.start()
  const release = await hub.install(readonlyCtx(DIRECTORY))
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    // Seed the hub through the same ingest path the event subscription uses.
    hub.ingest(event('session.created', { title: 'Demo session' }, 1))
    hub.ingest(event('session.next.prompted', { text: 'run the tests' }, 2))
    hub.ingest(event('session.text.started', { assistantMessageID: 'msg_1', ordinal: 0 }, 3))
    hub.ingest(event('session.text.delta', { assistantMessageID: 'msg_1', delta: 'ok', ordinal: 0 }, 4))
    hub.ingest(event('session.tool.called', { id: 'call_1', assistantMessageID: 'msg_1', input: { cmd: 'ls' }, executed: true }, 5))
    hub.ingest(event('session.tool.success', { id: 'call_1', content: 'done', executed: true }, 6))
    hub.ingest(event('session.step.ended', { assistantMessageID: 'msg_1', cost: 0.02, tokens: { input: 5 } }, 7))

    // 1. initialize
    const initialized = (await client.initialize(FakeBridgeClient.initializeParams(hub.token))) as {
      identity: { runtime: string; protocolVersion: string; runtimeVersion: string }
      features: { syncMode: string; readOnly: boolean }
    }
    assert.equal(initialized.identity.runtime, 'opencode')
    assert.equal(initialized.identity.protocolVersion, '1.0')
    assert.equal(initialized.features.syncMode, 'events')

    // 2. ping
    const pong = (await client.request('ping')) as { ok: boolean }
    assert.equal(pong.ok, true)

    // 3. runtime.getCapabilities
    const capabilities = (await client.request('runtime.getCapabilities')) as {
      runtime: string
      capabilities: Array<{
        capabilityId: string
        supported: boolean
        available: boolean
        allowed: boolean
        metadata: Record<string, unknown>
      }>
      metadata: Record<string, unknown>
    }
    assert.equal(capabilities.runtime, 'opencode')
    const byId = new Map(capabilities.capabilities.map((row) => [row.capabilityId, row]))
    for (const id of [
      'session.list',
      'session.getSnapshot',
      'session.getState',
      'session.getNotices',
      'session.send_message',
      'session.interrupt',
      'session.interaction.approval',
    ]) {
      assert.equal(byId.get(id)?.supported, true, `${id} must be advertised`)
    }
    for (const id of ['session.steer', 'catalog.model']) {
      assert.equal(byId.get(id)?.supported, false, `${id} must stay unsupported (no native steer, no catalog in P3 scope)`)
    }
    // rev3 ruling 2: partial discovery rides the session.discovery row's
    // metadata, never a root sessionDiscovery field.
    const discovery = byId.get('session.discovery')
    assert.equal(discovery?.supported, true, 'session.discovery must be advertised')
    assert.equal(discovery?.metadata['discoveryState'], 'partial')
    assert.equal((capabilities as Record<string, unknown>)['sessionDiscovery'], undefined)
    assert.equal(capabilities.metadata['discoveryState'], 'partial')

    // 4. session.list
    const sessionId = platformSessionId('connector-test', NATIVE)
    const listed = (await client.request('session.list', { limit: 10 })) as {
      partial: boolean
      sessions: Array<{ sessionId: string; externalSessionId: string; runtime: string; title?: string; cwd?: string }>
    }
    assert.equal(listed.partial, true)
    assert.equal(listed.sessions.length, 1)
    const meta = listed.sessions[0]
    assert.equal(meta?.sessionId, sessionId)
    assert.equal(meta?.externalSessionId, NATIVE)
    assert.equal(meta?.runtime, 'opencode')
    assert.equal(meta?.title, 'Demo session')
    assert.equal(meta?.cwd, DIRECTORY)

    // 5. session.getSnapshot — connector-verifiable items
    const snapshot = (await client.request('session.getSnapshot', { sessionId })) as {
      sessionId: string
      externalSessionId: string
      items: TimelineItem[]
      watermark: number
      snapshotComplete: boolean
      metadata: { totalItems: number }
    }
    assert.equal(snapshot.sessionId, sessionId)
    assert.equal(snapshot.externalSessionId, NATIVE)
    assert.equal(snapshot.snapshotComplete, true)
    assert.equal(snapshot.watermark, 7)
    assert.equal(snapshot.metadata.totalItems, snapshot.items.length)
    assert.ok(snapshot.items.length >= 4)
    for (const item of snapshot.items) {
      assert.equal(item.sessionId, sessionId, 'items must be re-keyed to the requested platform session')
      assert.equal(item.contentHash, contentHash(item.type, item.status, item.role, item.content))
      assert.ok(item.orderSeq >= 1)
      assert.ok(item.revision >= 1)
    }
    assert.ok(snapshot.items.some((item) => item.role === 'user' && item.content['text'] === 'run the tests'))

    // 6. session.getState
    const state = (await client.request('session.getState', { sessionId })) as { status: string; sessionId: string }
    assert.equal(state.sessionId, sessionId)
    assert.ok((RUNTIME_STATUSES as readonly string[]).includes(state.status))

    // 7. session.getNotices
    const notices = (await client.request('session.getNotices', { sessionId })) as { notices: unknown[] }
    assert.deepEqual(notices.notices, [])
  } finally {
    client.close()
    await release()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unknown session is reported with SESSION_NOT_FOUND', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-integration-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, logger: SILENT })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    for (const method of ['session.getSnapshot', 'session.getState', 'session.getNotices']) {
      const error = expectRpcError(await client.request(method, { sessionId: 'sess_opencode_missing' }).catch((e) => e))
      assert.equal(error.data?.['code'], 'SESSION_NOT_FOUND', `${method} must report SESSION_NOT_FOUND`)
    }
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the endpoint file is published on start and removed on stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-integration-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, logger: SILENT })
  await hub.start()
  assert.equal((await scanEndpoints(dir)).length, 1)
  await hub.stop()
  assert.equal((await scanEndpoints(dir)).length, 0)
  assert.equal(hub.endpointPath, null)
  await rm(dir, { recursive: true, force: true })
})
