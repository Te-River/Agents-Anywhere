import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { PermissionObserver } from '../../src/server/permission-bridge.js'
import { createLogger } from '../../src/shared/logger.js'
import { platformSessionId } from '../../src/shared/protocol.js'
import { REMOTE_ALLOW_ACTION } from '../../src/shared/permission-policy.js'
import type { OpenCodeEvent, OpenCodePluginContext, PermissionReplyRequest } from '../../src/server/opencode-ctx.js'
import { FakeBridgeClient } from '../helpers/bridge-client.js'

const SILENT = createLogger('test', () => undefined)
const NATIVE = 'ses_native'
const DIRECTORY = 'D:/proj/a'
const DEVICE_A = 'device-a'
const DEVICE_B = 'device-b'

// ── unit: PermissionObserver.bindPending (§6⑤ / R4) ──────────────────────────

function asked(id: string, sessionID = NATIVE): OpenCodeEvent {
  return { id: `asked:${id}`, type: 'permission.asked', location: { directory: DIRECTORY }, data: { id, action: 'webfetch', sessionID, resources: [] } }
}

function observerHarness(): { observer: PermissionObserver; replies: PermissionReplyRequest[] } {
  const replies: PermissionReplyRequest[] = []
  const observer = new PermissionObserver(SILENT)
  observer.install({ permission: { hook: () => ({ dispose: () => undefined }), reply: async (r: PermissionReplyRequest) => { replies.push(r) } } })
  return { observer, replies }
}

test('R4: a notice observed with no owner fails closed, then a later claim binds it once', async () => {
  const { observer, replies } = observerHarness()
  // Observed before any connection claimed the session → owner is null.
  observer.observe(asked('req_bind'), null)
  const before = await observer.answer({ noticeId: 'notice_req_bind', actionId: REMOTE_ALLOW_ACTION, userId: 'u', nativeSessionId: NATIVE, connectorId: DEVICE_A })
  assert.equal(before.ok === false && before.code, 'unbound_notice')

  assert.equal(observer.bindPending(NATIVE, DEVICE_A), 1, 'the open notice is bound')
  const after = await observer.answer({ noticeId: 'notice_req_bind', actionId: REMOTE_ALLOW_ACTION, userId: 'u', nativeSessionId: NATIVE, connectorId: DEVICE_A })
  assert.equal(after.ok, true)
  assert.equal(replies.length, 1)

  // First claim wins: a second binding attempt is a no-op for an owned notice.
  assert.equal(observer.bindPending(NATIVE, DEVICE_B), 0)
  const foreign = await observer.answer({ noticeId: 'notice_req_bind', actionId: REMOTE_ALLOW_ACTION, userId: 'u', nativeSessionId: NATIVE, connectorId: DEVICE_B })
  assert.equal(foreign.ok === false && foreign.code, 'device_mismatch')
})

test('R4: bindPending never reopens a natively answered notice and ignores other sessions', () => {
  const { observer } = observerHarness()
  observer.observe(asked('req_resolved', 'ses_a'), null)
  observer.observe({ id: 'replied', type: 'permission.replied', location: { directory: DIRECTORY }, data: { requestID: 'req_resolved', reply: 'once' } })
  assert.equal(observer.bindPending('ses_a', DEVICE_A), 0, 'a resolved interaction is never rebound')
  assert.equal(observer.bindPending('ses_unknown', DEVICE_A), 0)
  assert.equal(observer.bindPending('ses_a', ''), 0, 'an empty device id never binds')
})

// ── integration: the Hub's claim path performs the binding (R4) ──────────────

function idleStream(): AsyncIterable<OpenCodeEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
}

test('R4: answering over the wire only works after a connection claims the session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-r4-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, serviceVersion: '2.0.18', logger: SILENT })
  await hub.start()
  const replies: PermissionReplyRequest[] = []
  const ctx: OpenCodePluginContext = {
    location: { directory: DIRECTORY },
    app: { version: '2.0.18' },
    event: { subscribe: () => idleStream() },
    permission: {
      hook: () => ({ dispose: () => undefined }),
      reply: async (request: PermissionReplyRequest) => { replies.push(request) },
    },
  }
  const release = await hub.install(ctx)

  // The session and its permission request are both observed *before* any
  // connection exists — the exact cold-start window R4 closes.
  hub.ingest({ id: 'e1', type: 'session.created', location: { directory: DIRECTORY }, data: { sessionID: NATIVE, title: 't' }, durable: { aggregateID: NATIVE, seq: 1, version: 1 } })
  hub.ingest(asked('req_remote'))

  const sessionId = platformSessionId(DEVICE_A, NATIVE)
  const clientA = await FakeBridgeClient.connect(hub.port)
  const clientB = await FakeBridgeClient.connect(hub.port)
  try {
    await clientA.initialize(FakeBridgeClient.initializeParams(hub.token, { connectorId: DEVICE_A }))
    await clientB.initialize(FakeBridgeClient.initializeParams(hub.token, { connectorId: DEVICE_B }))

    const unbound = (await clientA.request('session.respondInteraction', {
      sessionId, noticeId: 'notice_req_remote', actionId: REMOTE_ALLOW_ACTION,
    })) as { ok: boolean; code?: string }
    assert.equal(unbound.ok, false)
    assert.equal(unbound.code, 'unbound_notice', 'before any claim the notice is unanswerable')

    // Claiming = opening the session stream (the Hub binds pending notices here).
    await clientA.request('runtime.sync.subscribe', { sessionId })

    const owned = (await clientA.request('session.respondInteraction', {
      sessionId, noticeId: 'notice_req_remote', actionId: REMOTE_ALLOW_ACTION,
    })) as { ok: boolean }
    assert.equal(owned.ok, true, 'the claiming device may now answer the previously orphaned notice')
    assert.deepEqual(replies, [{ path: { requestID: 'req_remote' }, body: { reply: 'once' } }])

    // A different device still cannot answer it.
    const sessionIdB = platformSessionId(DEVICE_B, NATIVE)
    const foreign = (await clientB.request('session.respondInteraction', {
      sessionId: sessionIdB, noticeId: 'notice_req_remote', actionId: REMOTE_ALLOW_ACTION,
    })) as { ok: boolean; code?: string }
    assert.equal(foreign.ok, false)
    assert.equal(foreign.code, 'device_mismatch')
  } finally {
    clientA.close()
    clientB.close()
    await release()
    await rm(dir, { recursive: true, force: true })
  }
})
