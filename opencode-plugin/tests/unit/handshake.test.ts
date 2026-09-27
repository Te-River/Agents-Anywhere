import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { createLogger } from '../../src/shared/logger.js'
import { MAX_FRAME_BYTES } from '../../src/shared/protocol.js'
import { readEndpoint, scanEndpoints } from '../../src/shared/endpoint-store.js'
import { expectRpcError, FakeBridgeClient } from '../helpers/bridge-client.js'

const SILENT = createLogger('test', () => undefined)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function withHub(run: (hub: BridgeHub, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-handshake-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, serviceVersion: '2.0.18', logger: SILENT })
  await hub.start()
  try {
    await run(hub, dir)
  } finally {
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

test('a valid initialize handshake succeeds and publishes the endpoint file', async () => {
  await withHub(async (hub, dir) => {
    const published = await readEndpoint(hub.endpointPath ?? '')
    assert.ok(published, 'endpoint file must be readable')
    assert.equal(published.host, '127.0.0.1')
    assert.equal(published.port, hub.port)
    assert.equal(published.runtime, 'opencode')
    assert.equal(published.protocolVersion, '1.0')
    assert.equal(published.serviceVersion, '2.0.18')
    assert.equal(published.token, hub.token)
    assert.match(published.bridgeId, /^[0-9a-f-]{36}$/)
    assert.ok(published.port > 0 && published.port <= 65535)
    assert.equal((await scanEndpoints(dir)).length, 1)

    const client = await FakeBridgeClient.connect(hub.port)
    try {
      const result = (await client.initialize(FakeBridgeClient.initializeParams(hub.token))) as {
        identity: { runtime: string; protocolVersion: string; runtimeVersion: string }
        features: { syncMode: string }
      }
      assert.equal(result.identity.runtime, 'opencode')
      assert.equal(result.identity.protocolVersion, '1.0')
      assert.equal(result.identity.runtimeVersion, '2.0.18')
      assert.equal(result.features.syncMode, 'events')
    } finally {
      client.close()
    }
  })
})

test('a wrong token is rejected with -32001 and the socket is closed', async () => {
  await withHub(async (hub) => {
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      const error = expectRpcError(await client.initialize(FakeBridgeClient.initializeParams('not-the-token')).catch((e) => e))
      assert.equal(error.code, -32001)
      assert.equal(error.data?.['code'], 'UNAUTHORIZED')
      await client.waitForClose()
      assert.equal(client.closed, true)
    } finally {
      client.close()
    }
  })
})

test('a wrong runtime or protocol major is rejected', async () => {
  await withHub(async (hub) => {
    const runtimeClient = await FakeBridgeClient.connect(hub.port)
    try {
      const error = expectRpcError(
        await runtimeClient
          .initialize(FakeBridgeClient.initializeParams(hub.token, { runtime: 'dsh' }))
          .catch((e) => e),
      )
      assert.equal(error.code, -32001)
      assert.equal(error.data?.['code'], 'RUNTIME_MISMATCH')
      await runtimeClient.waitForClose()
    } finally {
      runtimeClient.close()
    }

    const protocolClient = await FakeBridgeClient.connect(hub.port)
    try {
      const error = expectRpcError(
        await protocolClient
          .initialize(FakeBridgeClient.initializeParams(hub.token, { protocolVersion: '2.0' }))
          .catch((e) => e),
      )
      assert.equal(error.code, -32001)
      assert.equal(error.data?.['code'], 'PROTOCOL_INCOMPATIBLE')
      await protocolClient.waitForClose()
    } finally {
      protocolClient.close()
    }
  })
})

test('initialize must be the first frame', async () => {
  await withHub(async (hub) => {
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      const error = expectRpcError(await client.request('ping').catch((e) => e))
      assert.equal(error.code, -32001)
      assert.equal(error.data?.['code'], 'HANDSHAKE_REQUIRED')
      await client.waitForClose()
    } finally {
      client.close()
    }
  })
})

test('write methods fail closed without a host; unknown methods are -32601', async () => {
  await withHub(async (hub) => {
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token))
      // No `install(ctx)` happened, so the host write surface is absent: each
      // served write method answers UNSUPPORTED_OPERATION, never silently.
      for (const method of ['session.createAndStart', 'session.startTurn', 'session.interrupt', 'session.updateSelections', 'session.steerTurn']) {
        const error = expectRpcError(await client.request(method, {}).catch((e) => e))
        assert.equal(error.code, -32601, `${method} must be rejected`)
        assert.equal(error.data?.['code'], 'UNSUPPORTED_OPERATION', `${method} must be served-but-unsupported`)
      }
      // `respondInteraction` validates its params first.
      const params = expectRpcError(await client.request('session.respondInteraction', {}).catch((e) => e))
      assert.equal(params.code, -32602)
      assert.equal(params.data?.['code'], 'INVALID_PARAMS')
      // A method that does not exist at all is METHOD_NOT_FOUND.
      const unknown = expectRpcError(await client.request('does.not.exist', {}).catch((e) => e))
      assert.equal(unknown.code, -32601)
      assert.equal(unknown.data?.['code'], 'METHOD_NOT_FOUND')
      // A known-but-unsupported method (catalog) is distinguishable from unknown.
      for (const method of ['catalog.listModels', 'catalog.listPermissions']) {
        const catalog = expectRpcError(await client.request(method, {}).catch((e) => e))
        assert.equal(catalog.code, -32601, method)
        assert.equal(catalog.data?.['code'], 'UNSUPPORTED_OPERATION', method)
      }
      // Still usable after a rejected request.
      const pong = (await client.request('ping')) as { ok: boolean }
      assert.equal(pong.ok, true)
    } finally {
      client.close()
    }
  })
})

test('initialize without an absolute location fails closed (rev3 ruling 1)', async () => {
  await withHub(async (hub) => {
    for (const location of [undefined, '', 'relative/dir']) {
      const client = await FakeBridgeClient.connect(hub.port)
      try {
        const params = FakeBridgeClient.initializeParams(hub.token)
        if (location === undefined) delete params['location']
        else params['location'] = location
        const error = expectRpcError(await client.initialize(params).catch((e) => e))
        assert.equal(error.code, -32602, `location=${String(location)} must be rejected`)
        assert.equal(error.data?.['code'], 'INVALID_PARAMS')
        await client.waitForClose()
        assert.equal(client.closed, true, 'the socket must be closed')
      } finally {
        client.close()
      }
    }
  })
})

test('a location-bound connection still lists sessions (regression)', async () => {
  await withHub(async (hub) => {
    hub.ingest({
      id: 'e1',
      created: '2026-01-01T00:00:00.000Z',
      type: 'session.created',
      location: { directory: 'D:/proj/a' },
      data: { sessionID: 'ses_regression', title: 'Regression' },
    })
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token, { location: 'D:/proj/a' }))
      const listed = (await client.request('session.list', { limit: 10 })) as {
        runtime: string
        partial: boolean
        sessions: Array<{ externalSessionId: string; title?: string }>
      }
      assert.equal(listed.runtime, 'opencode')
      assert.equal(listed.partial, true)
      assert.equal(listed.sessions.length, 1)
      assert.equal(listed.sessions[0]?.externalSessionId, 'ses_regression')
      assert.equal(listed.sessions[0]?.title, 'Regression')
      const pong = (await client.request('ping')) as { ok: boolean }
      assert.equal(pong.ok, true)
    } finally {
      client.close()
    }
  })
})

test('the bridge only ever sends notifications (it never initiates a request)', async () => {
  await withHub(async (hub) => {
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token))
      const before = client.inboundFrames.length

      // A peer notification is accepted and never answered.
      client.notify('runtime.sync.ack', { sessionId: 'sess_x', throughSeq: 1 })
      await delay(120)
      assert.equal(client.inboundFrames.length, before, 'notifications must not be answered')
      assert.equal(hub.metrics.incomingNotifications, 1)

      // An unsolicited *response* (as if the bridge had asked something) is ignored.
      client.sendRawFrame({ jsonrpc: '2.0', id: 'bridge-never-asks', result: { ok: true } })
      await delay(60)
      assert.equal(client.inboundFrames.length, before)
      assert.equal(client.closed, false)

      const pong = (await client.request('ping')) as { ok: boolean }
      assert.equal(pong.ok, true)
    } finally {
      client.close()
    }
  })
})

test('a frame larger than 8 MiB is rejected and the connection dropped', async () => {
  await withHub(async (hub) => {
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token))
      client.bytes(`${'x'.repeat(MAX_FRAME_BYTES + 1)}\n`)
      await client.waitForClose(5000)
      assert.equal(client.closed, true)
    } finally {
      client.close()
    }
  })
})

test('a malformed frame yields a parse error without killing the connection', async () => {
  await withHub(async (hub) => {
    const client = await FakeBridgeClient.connect(hub.port)
    try {
      await client.initialize(FakeBridgeClient.initializeParams(hub.token))
      client.bytes('{ not json\n')
      await delay(80)
      const pong = (await client.request('ping')) as { ok: boolean }
      assert.equal(pong.ok, true)
    } finally {
      client.close()
    }
  })
})
