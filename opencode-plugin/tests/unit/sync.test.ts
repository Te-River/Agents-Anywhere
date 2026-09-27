import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { createLogger } from '../../src/shared/logger.js'
import { platformSessionId } from '../../src/shared/protocol.js'
import type { OpenCodeEvent } from '../../src/server/opencode-ctx.js'
import { createTestCtx } from '../helpers/event-bus.js'
import { expectRpcError, FakeBridgeClient } from '../helpers/bridge-client.js'

const SILENT = createLogger('test', () => undefined)
const DIR_A = 'D:/proj/a'
const DIR_B = 'D:/proj/b'
const DIR_A_ID = 'connector-test'
const NATIVE = 'ses_native'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function withHub(
  options: { syncPageItems?: number },
  run: (hub: BridgeHub, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-sync-'))
  const hub = new BridgeHub({
    endpointsDirectory: dir,
    logger: SILENT,
    ...(options.syncPageItems !== undefined ? { syncPageItems: options.syncPageItems } : {}),
  })
  await hub.start()
  try {
    await run(hub, dir)
  } finally {
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

function event(
  type: string,
  sessionID: string,
  directory: string,
  data: Record<string, unknown> = {},
  durableSeq?: number,
): OpenCodeEvent {
  return {
    id: `${type}:${sessionID}:${Math.random().toString(36).slice(2, 8)}`,
    created: '2026-01-01T00:00:00.000Z',
    type,
    location: { directory },
    data: { sessionID, ...data },
    ...(durableSeq !== undefined
      ? { durable: { aggregateID: sessionID, seq: durableSeq, version: 1 } }
      : {}),
  }
}

/**
 * Drive one `runtime.sync.subscribe` request and return only the calibration
 * `sync.batch` frames it produced — the exact page protocol `SyncRelay.operation`
 * consumes. Live `phase:"notifications"` frames are dropped: a prior
 * subscription may still be delivering them concurrently.
 */
async function calibrate(
  client: FakeBridgeClient,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const start = client.notifications.length
  await client.request('runtime.sync.subscribe', params)
  await delay(80)
  return client.notifications
    .slice(start)
    .filter((entry) => entry.method === 'sync.batch')
    .map((entry) => entry.params as Record<string, unknown>)
    .filter((batch) => batch['phase'] === 'begin' || batch['phase'] === 'items' || batch['phase'] === 'commit')
}

test('sessionId derivation matches the Connector stable_runtime_session_id vector', async () => {
  // `sess_opencode_<sha256("connector-test:opencode:ses_native")[:24]>`, computed
  // independently with Python hashlib (connector/runtimes/session_identity.py).
  assert.equal(platformSessionId('connector-test', 'ses_native'), 'sess_opencode_809e793044baf8493ba2cfef')

  await withHub({}, async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))
    hub.ingest(event('session.created', NATIVE, DIR_A, { title: 'Demo' }, 1))
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token, { location: DIR_A }))
      const listed = (await client.request('session.list', {})) as {
        sessions: Array<{ sessionId: string; externalSessionId: string }>
      }
      assert.equal(listed.sessions[0]?.sessionId, 'sess_opencode_809e793044baf8493ba2cfef')
      assert.equal(listed.sessions[0]?.externalSessionId, NATIVE)
    } finally {
      client.close()
    }
  })
})

test('a connection only sees sessions from its own location (rev3 ruling 1)', async () => {
  await withHub({}, async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))
    await hub.install(createTestCtx({ directory: DIR_B }))
    hub.ingest(event('session.created', 'ses_a', DIR_A, { title: 'A' }, 1))
    hub.ingest(event('session.created', 'ses_b', DIR_B, { title: 'B' }, 1))

    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token, { location: DIR_A }))
      const listed = (await client.request('session.list', {})) as {
        sessions: Array<{ externalSessionId: string }>
      }
      assert.deepEqual(
        listed.sessions.map((session) => session.externalSessionId),
        ['ses_a'],
        'the other location must never cross into this connection',
      )

      const foreign = platformSessionId(DIR_A_ID, 'ses_b')
      for (const method of ['session.getSnapshot', 'session.getState', 'session.getNotices', 'runtime.sync.subscribe']) {
        const error = expectRpcError(await client.request(method, { sessionId: foreign }).catch((e) => e))
        assert.equal(error.data?.['code'], 'SESSION_NOT_FOUND', `${method} must hide the foreign session`)
      }
    } finally {
      client.close()
    }
  })
})

test('subscribe calibrates a full snapshot, pages it, and reports diagnostics', async () => {
  await withHub({ syncPageItems: 2 }, async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))
    hub.ingest(event('session.next.prompted', NATIVE, DIR_A, { text: 'run the tests' }, 1))
    hub.ingest(event('session.text.started', NATIVE, DIR_A, { assistantMessageID: 'msg_1', ordinal: 0 }, 2))
    hub.ingest(event('session.text.delta', NATIVE, DIR_A, { assistantMessageID: 'msg_1', delta: 'ok', ordinal: 0 }, 3))
    hub.ingest(event('session.tool.called', NATIVE, DIR_A, { id: 'call_1', assistantMessageID: 'msg_1', executed: true }, 4))
    // An unknown native event must be skipped *and* counted, never thrown.
    hub.ingest(event('session.mystery.thing', NATIVE, DIR_A, { whatever: 1 }, 5))

    const sessionId = platformSessionId(DIR_A_ID, NATIVE)
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token, { location: DIR_A }))
      const batches = await calibrate(client, { sessionId })

      const phases = batches.map((batch) => batch['phase'])
      assert.deepEqual(phases, ['begin', 'items', 'items', 'commit'], 'begin → items×N → commit, in order')

      const begin = batches[0]
      assert.equal(begin?.['resume'], 'snapshot')
      assert.equal(begin?.['diagnostics'] !== undefined && (begin['diagnostics'] as Record<string, unknown>)['skippedEventCount'], 1)
      const meta = begin?.['meta'] as Record<string, unknown>
      assert.equal(meta['externalSessionId'], NATIVE)
      assert.equal(meta['sessionId'], sessionId)
      assert.deepEqual(meta['cwd'], DIR_A)

      const items = batches
        .filter((batch) => batch['phase'] === 'items')
        .flatMap((batch) => batch['items'] as Array<Record<string, unknown>>)
      assert.equal(items.length, 3, 'the three projected items span two pages')
      for (const item of items) assert.equal(item['sessionId'], sessionId)
      for (const batch of batches.filter((entry) => entry['phase'] === 'items')) {
        assert.ok((batch['items'] as unknown[]).length <= 2)
      }

      const commit = batches[batches.length - 1]
      assert.equal(commit?.['complete'], true)
      assert.equal(commit?.['externalSessionId'], NATIVE)
      assert.equal(commit?.['throughSeq'], 5)
      assert.match(String(commit?.['historyHash']), /^[0-9a-f]{64}$/)
      assert.equal((commit?.['diagnostics'] as Record<string, unknown>)['skippedEventCount'], 1)

      // The Connector acks the checkpoint as a *request*; it must be answered.
      const ack = (await client.request('runtime.sync.ack', {
        sessionId,
        throughSeq: commit?.['throughSeq'],
      })) as { ok: boolean; throughSeq: number }
      assert.equal(ack.ok, true)
      assert.equal(ack.throughSeq, 5)
    } finally {
      client.close()
    }
  })
})

test('historyHash decides incremental resume vs full snapshot (rev3 ruling 3)', async () => {
  await withHub({}, async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))
    hub.ingest(event('session.next.prompted', NATIVE, DIR_A, { text: 'first' }, 1))
    hub.ingest(event('session.text.started', NATIVE, DIR_A, { assistantMessageID: 'm1', ordinal: 0 }, 2))
    hub.ingest(event('session.text.delta', NATIVE, DIR_A, { assistantMessageID: 'm1', delta: 'a', ordinal: 0 }, 3))

    const sessionId = platformSessionId(DIR_A_ID, NATIVE)
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token, { location: DIR_A }))
      const snapshot = await calibrate(client, { sessionId })
      const commit = snapshot[snapshot.length - 1]
      const throughSeq = commit?.['throughSeq'] as number
      const historyHash = commit?.['historyHash'] as string
      assert.equal(throughSeq, 3)

      // A new durable event lands after the checkpoint…
      hub.ingest(event('session.tool.called', NATIVE, DIR_A, { id: 'call_9', assistantMessageID: 'm1' }, 4))

      // …a matching prefix resumes incrementally and sends only the delta.
      const resumed = await calibrate(client, { sessionId, fromSeq: throughSeq, historyHash })
      assert.equal(resumed[0]?.['resume'], 'incremental')
      assert.equal(resumed[0]?.['fromSeq'], throughSeq)
      const resumedTail = resumed[resumed.length - 1]
      assert.equal(resumedTail?.['complete'], false)
      assert.equal(resumedTail?.['throughSeq'], 4)
      assert.notEqual(resumedTail?.['historyHash'], historyHash)

      // A mismatched hash, a missing hash, and an out-of-range seq each fall
      // back to a full snapshot — never a blind resume on fromSeq alone.
      for (const params of [
        { sessionId, fromSeq: throughSeq, historyHash: '0'.repeat(64) },
        { sessionId, fromSeq: throughSeq },
        { sessionId, fromSeq: 999, historyHash },
      ]) {
        const batches = await calibrate(client, params)
        assert.equal(batches[0]?.['resume'], 'snapshot', `must snapshot for ${JSON.stringify(params)}`)
        assert.equal(batches[batches.length - 1]?.['complete'], true)
      }
    } finally {
      client.close()
    }
  })
})

test('a subscribed session receives live phase:notifications updates', async () => {
  await withHub({}, async (hub) => {
    await hub.install(createTestCtx({ directory: DIR_A }))
    hub.ingest(event('session.next.prompted', NATIVE, DIR_A, { text: 'hello' }, 1))

    const sessionId = platformSessionId(DIR_A_ID, NATIVE)
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token, { location: DIR_A }))
      await calibrate(client, { sessionId })
      const start = client.notifications.length

      hub.ingest(event('session.text.started', NATIVE, DIR_A, { assistantMessageID: 'm2', ordinal: 0 }, 2))
      await delay(60)

      const pushed = client.notifications
        .slice(start)
        .filter((entry) => entry.method === 'sync.batch')
        .map((entry) => entry.params as Record<string, unknown>)
        .filter((batch) => batch['phase'] === 'notifications')
      assert.equal(pushed.length, 1, 'exactly one live notifications batch')
      const notifications = pushed[0]?.['notifications'] as Array<Record<string, unknown>>
      assert.ok(notifications.some((notice) => notice['method'] === 'timeline.itemUpsert'))
      assert.equal(pushed[0]?.['throughSeq'], 2)
    } finally {
      client.close()
    }
  })
})
