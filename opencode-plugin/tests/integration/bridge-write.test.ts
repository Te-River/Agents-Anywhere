import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { createLogger } from '../../src/shared/logger.js'
import { platformSessionId } from '../../src/shared/protocol.js'
import type { OpenCodeEvent, OpenCodePluginContext, PermissionReplyRequest } from '../../src/server/opencode-ctx.js'
import { expectRpcError, FakeBridgeClient } from '../helpers/bridge-client.js'

const SILENT = createLogger('test', () => undefined)
const NATIVE = 'ses_native'
const DIRECTORY = 'D:/proj/a'
const NAMESPACE = 'connector-test'

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

function idleStream(): AsyncIterable<OpenCodeEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
}

interface WriteHarness {
  hub: BridgeHub
  calls: Array<{ name: string; options: Record<string, unknown> }>
  replies: PermissionReplyRequest[]
  client: FakeBridgeClient
  init: { features: { readOnly: boolean } }
}

async function withHub(run: (h: WriteHarness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-write-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, serviceVersion: '2.0.18', logger: SILENT })
  await hub.start()
  const calls: WriteHarness['calls'] = []
  const replies: PermissionReplyRequest[] = []
  const record = (name: string) => (options: Record<string, unknown>) => {
    calls.push({ name, options })
    return {}
  }
  const ctx: OpenCodePluginContext = {
    location: { directory: DIRECTORY },
    app: { version: '2.0.18' },
    event: { subscribe: () => idleStream() },
    session: {
      create: (options) => {
        calls.push({ name: 'create', options })
        // Mirror the host: a created session emits session.created.
        hub.ingest(event('session.created', { title: 'created' }, 1))
        return { id: NATIVE }
      },
      prompt: record('prompt'),
      interrupt: record('interrupt'),
      switchModel: record('switchModel'),
      switchAgent: record('switchAgent'),
    },
    permission: {
      hook: () => ({ dispose: () => undefined }),
      reply: async (request: PermissionReplyRequest) => {
        replies.push(request)
      },
    },
  }
  const release = await hub.install(ctx)
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    const init = (await client.initialize(
      FakeBridgeClient.initializeParams(hub.token, { clientInfo: { name: 'aa', version: 't', userId: 'user-1' } }),
    )) as WriteHarness['init']
    await run({ hub, calls, replies, client, init })
  } finally {
    client.close()
    await release()
    await rm(dir, { recursive: true, force: true })
  }
}

test('write surface: capabilities expose the P3 methods and keep steer off', async () => {
  await withHub(async ({ init, client }) => {
    assert.equal(init.features.readOnly, false)
    const caps = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{ capabilityId: string; supported: boolean; metadata: Record<string, unknown> }>
    }
    const byId = new Map(caps.capabilities.map((row) => [row.capabilityId, row]))
    for (const id of ['session.send_message', 'session.interrupt', 'session.interaction.approval']) {
      assert.equal(byId.get(id)?.supported, true, `${id} must be supported`)
      // §6 capability honesty: a derived row records that the host surface itself
      // is unverified (research doc 02), never a bare `supported: true`.
      assert.equal(byId.get(id)?.metadata['probe'], 'unverified', `${id} probe`)
    }
    assert.equal(byId.get('session.steer')?.supported, false)
  })
})

test('write surface: a host missing session.* must not advertise write support (probe unverified)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-cap-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, serviceVersion: '2.0.18', logger: SILENT })
  await hub.start()
  // Exactly what a host that exposes no `ctx.session` write surface looks like:
  // the permission hook/reply are there, `session` is absent entirely.
  const ctx: OpenCodePluginContext = {
    location: { directory: DIRECTORY },
    app: { version: '2.0.18' },
    event: { subscribe: () => idleStream() },
    permission: { hook: () => ({ dispose: () => undefined }), reply: async () => ({}) },
  }
  const release = await hub.install(ctx)
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(
      FakeBridgeClient.initializeParams(hub.token, { clientInfo: { name: 'aa', version: 't', userId: 'user-1' } }),
    )
    const caps = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{ capabilityId: string; supported: boolean; available: boolean; metadata: Record<string, unknown> }>
    }
    const byId = new Map(caps.capabilities.map((row) => [row.capabilityId, row]))
    for (const id of ['session.send_message', 'session.interrupt']) {
      assert.equal(byId.get(id)?.supported, false, `${id} must NOT be supported without the host surface`)
      assert.equal(byId.get(id)?.available, false, `${id} must NOT be available`)
      assert.equal(byId.get(id)?.metadata['probe'], 'unverified', `${id} probe`)
    }
    // The approval row only needs permission.reply + the evaluate hook, so it
    // stays supported even with no `session` surface — and still says unverified.
    assert.equal(byId.get('session.interaction.approval')?.supported, true)
    assert.equal(byId.get('session.interaction.approval')?.metadata['probe'], 'unverified')
    // A host without `permission.reply` must not advertise approval either.
    assert.equal(byId.get('session.steer')?.supported, false)
  } finally {
    client.close()
    await release()
    await rm(dir, { recursive: true, force: true })
  }
})

test('write surface: createAndStart / startTurn / interrupt / updateSelections reach the host', async () => {
  await withHub(async ({ client, calls }) => {
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    const created = (await client.request('session.createAndStart', {
      sessionId: platformSessionId(NAMESPACE, 'ses_new'),
      cwd: DIRECTORY,
      content: 'hello',
      selections: {},
      clientMessageId: 'cm-1',
    })) as { ok: boolean; externalSessionId: string; sessionId: string }
    assert.equal(created.ok, true)
    assert.equal(created.externalSessionId, NATIVE)
    assert.equal(created.sessionId, sessionId)
    assert.deepEqual(calls[0], { name: 'create', options: { directory: DIRECTORY } })
    assert.equal(calls[1]?.name, 'prompt')
    assert.equal(calls[1]?.options['sessionID'], NATIVE)
    assert.equal(calls[1]?.options['content'], 'hello')
    assert.equal(calls[1]?.options['clientMessageId'], 'cm-1')

    const turn = (await client.request('session.startTurn', { sessionId, content: 'again' })) as { ok: boolean }
    assert.equal(turn.ok, true)
    assert.equal(calls[2]?.name, 'prompt')

    const interrupted = (await client.request('session.interrupt', { sessionId, reason: 'user' })) as { ok: boolean }
    assert.equal(interrupted.ok, true)
    assert.deepEqual(calls[3], { name: 'interrupt', options: { sessionID: NATIVE, reason: 'user' } })

    const selections = (await client.request('session.updateSelections', { sessionId, selections: { model: 'gpt-x', agent: 'build' } })) as { ok: boolean }
    assert.equal(selections.ok, true)
    assert.deepEqual(calls[4], { name: 'switchModel', options: { sessionID: NATIVE, model: 'gpt-x' } })
    assert.deepEqual(calls[5], { name: 'switchAgent', options: { sessionID: NATIVE, agent: 'build' } })
  })
})

test('write surface: unknown selection keys come back in `ignored`, not silently dropped', async () => {
  await withHub(async ({ hub, client, calls }) => {
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    const result = (await client.request('session.updateSelections', {
      sessionId,
      selections: { model: 'gpt-x', bogusKey: 'whatever' },
    })) as { ok: boolean; applied: string[]; ignored: string[] }
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['model'])
    assert.deepEqual(result.ignored, ['bogusKey'])
    assert.deepEqual(calls.map((call) => call.name), ['switchModel'])
  })
})

test('write surface: attachments are refused loudly (never forwarded, never dropped)', async () => {
  await withHub(async ({ hub, client, calls }) => {
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    for (const [method, params] of [
      ['session.createAndStart', { sessionId, content: 'hi', attachments: [{ id: 'a1' }] }],
      ['session.startTurn', { sessionId, content: 'hi', attachments: [{ id: 'a1' }] }],
    ] as const) {
      const error = expectRpcError(await client.request(method, params).catch((e) => e))
      assert.equal(error.code, -32601, `${method} must reject attachments`)
      assert.equal(error.data?.['code'], 'UNSUPPORTED_OPERATION', method)
    }
    assert.deepEqual(calls, [], 'no host call may happen for a refused attachment')
  })
})

test('write surface: a permission notice uses the AA shape (interactionType approval + blocking scope)', async () => {
  await withHub(async ({ hub, client }) => {
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    hub.ingest(event('permission.asked', { id: 'req_shape', action: 'webfetch', resources: ['https://x'] }, 2))
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    const notices = (await client.request('session.getNotices', { sessionId })) as {
      notices: Array<Record<string, unknown>>
    }
    const notice = notices.notices[0]
    assert.equal(notice?.['interactionType'], 'approval')
    assert.deepEqual(notice?.['blocking'], { scope: 'session', targetId: sessionId })
    const context = notice?.['context'] as Record<string, unknown>
    assert.equal(context['requestId'], 'req_shape')
    assert.equal(context['permission'], 'webfetch')
    assert.equal(context['requiresLocalConfirmation'], false)
    assert.deepEqual(
      (notice?.['actions'] as Array<Record<string, unknown>>).map((action) => action['actionId']),
      ['allow_once', 'deny'],
    )
  })
})

test('write surface: steerTurn answers with a clear capability error (never silent)', async () => {
  await withHub(async ({ client }) => {
    const error = expectRpcError(await client.request('session.steerTurn', { sessionId: platformSessionId(NAMESPACE, NATIVE), content: 'x' }).catch((e) => e))
    assert.equal(error.code, -32601)
    assert.equal(error.data?.['code'], 'UNSUPPORTED_OPERATION')
  })
})

test('approval: allow_once lands through permission.reply, then already_answered', async () => {
  await withHub(async ({ hub, client, replies }) => {
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    // §6⑤: opening the session stream is how this connection claims the session,
    // so the notice is bound to its connectorId and remote answering is allowed.
    await client.request('runtime.sync.subscribe', { sessionId })
    hub.ingest(event('permission.asked', { id: 'req_1', action: 'webfetch', resources: ['https://x'] }, 2))

    const answer = (await client.request('session.respondInteraction', {
      sessionId,
      noticeId: 'notice_req_1',
      actionId: 'allow_once',
      inputData: {},
    })) as { ok: boolean }
    assert.equal(answer.ok, true)
    assert.deepEqual(replies, [{ path: { requestID: 'req_1' }, body: { reply: 'once' } }])

    const again = (await client.request('session.respondInteraction', {
      sessionId,
      noticeId: 'notice_req_1',
      actionId: 'deny',
      inputData: {},
    })) as { ok: boolean; code?: string }
    assert.equal(again.ok, false)
    assert.equal(again.code, 'already_answered')
    assert.equal(replies.length, 1)
  })
})

test('approval: unknown notice / remote always / high-risk are refused', async () => {
  await withHub(async ({ hub, client, replies }) => {
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    // §6⑤: claim the session first, so the refusals below are the ones under
    // test (action/code) rather than the unbound-notice fail-closed gate.
    await client.request('runtime.sync.subscribe', { sessionId })
    hub.ingest(event('permission.asked', { id: 'req_low', action: 'webfetch' }, 2))
    hub.ingest(event('permission.asked', { id: 'req_high', action: 'write' }, 3))

    const unknown = (await client.request('session.respondInteraction', { sessionId, noticeId: 'notice_missing', actionId: 'allow_once' })) as { ok: boolean; code?: string }
    assert.equal(unknown.code, 'unknown_notice')

    const always = (await client.request('session.respondInteraction', { sessionId, noticeId: 'notice_req_low', actionId: 'always' })) as { ok: boolean; code?: string }
    assert.equal(always.code, 'unsupported_action')

    const highRisk = (await client.request('session.respondInteraction', { sessionId, noticeId: 'notice_req_high', actionId: 'allow_once' })) as { ok: boolean; code?: string }
    assert.equal(highRisk.code, 'local_confirmation_required')

    assert.deepEqual(replies, [], 'none of the refused answers may touch permission.reply')
  })
})

test('approval: an unclaimed notice fails closed on the wire (unbound_notice)', async () => {
  await withHub(async ({ hub, client, replies }) => {
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    // No `runtime.sync.subscribe` → no connection ever claimed the session, so
    // the notice is observed with no owner: remote answering is refused, not
    // silently skipped (§6⑤ fail-closed).
    hub.ingest(event('permission.asked', { id: 'req_unbound', action: 'webfetch' }, 2))

    const outcome = (await client.request('session.respondInteraction', {
      sessionId,
      noticeId: 'notice_req_unbound',
      actionId: 'allow_once',
    })) as { ok: boolean; code?: string }
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'unbound_notice')

    // The notice is visible, so this is a binding refusal — not `unknown_notice`.
    const notices = (await client.request('session.getNotices', { sessionId })) as {
      notices: Array<{ noticeId: string; status: string }>
    }
    assert.equal(notices.notices.filter((n) => n.noticeId === 'notice_req_unbound').length, 1)
    assert.deepEqual(replies, [], 'an unbound notice may never reach permission.reply')
  })
})

test('approval: a replayed permission.asked emits no second open notice.upsert (§6②)', async () => {
  await withHub(async ({ hub, client }) => {
    const sessionId = platformSessionId(NAMESPACE, NATIVE)
    hub.ingest(event('session.created', { title: 'demo' }, 1))
    await client.request('runtime.sync.subscribe', { sessionId })
    hub.ingest(event('permission.asked', { id: 'req_replay', action: 'webfetch' }, 2))
    hub.ingest(event('permission.asked', { id: 'req_replay', action: 'webfetch' }, 3)) // replay before the answer

    const answer = (await client.request('session.respondInteraction', {
      sessionId,
      noticeId: 'notice_req_replay',
      actionId: 'allow_once',
    })) as { ok: boolean }
    assert.equal(answer.ok, true)

    // The host settles the ask (what the real host emits after permission.reply).
    hub.ingest(event('permission.replied', { requestID: 'req_replay', reply: 'once' }, 4))
    hub.ingest(event('permission.asked', { id: 'req_replay', action: 'webfetch' }, 5)) // replay after the answer

    // A round trip flushes the socket: every frame the Hub wrote above has been
    // received (same-socket FIFO), so the notification list below is complete.
    const notices = (await client.request('session.getNotices', { sessionId })) as {
      notices: Array<{ noticeId: string; status: string }>
    }

    // `notice.upsert` rides inside the `sync.batch` notification batch.
    const statuses = client.notifications
      .flatMap((frame) => {
        const params = frame.params as {
          notifications?: Array<{ method: string; params: Record<string, unknown> }>
        }
        return params.notifications ?? []
      })
      .filter((notification) => notification.method === 'notice.upsert')
      .filter((notification) => notification.params['noticeId'] === 'notice_req_replay')
      .map((notification) => notification.params['status'])
    assert.deepEqual(statuses, ['open', 'resolved'], 'a replay must never re-emit `open`')

    assert.deepEqual(
      notices.notices.filter((n) => n.noticeId === 'notice_req_replay').map((n) => n.status),
      ['resolved'],
    )
  })
})
