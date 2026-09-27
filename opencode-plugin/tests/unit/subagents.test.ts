import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { SessionRegistry } from '../../src/server/session-registry.js'
import { Projector } from '../../src/server/projector.js'
import { createLogger } from '../../src/shared/logger.js'
import { CAPABILITY_IDS } from '../../src/shared/protocol.js'
import { SESSION_INDEX_FILENAME, writeSessionIndexFile } from '../../src/shared/session-index.js'
import { FakeBridgeClient } from '../helpers/bridge-client.js'
import { sessionEvent } from '../helpers/event-bus.js'

const SILENT = createLogger('test', () => undefined)
const DIRECTORY = 'D:/proj/a'

/**
 * Subagent (child session) coverage, pinned to the isolation measurements in
 * spike 02: child session events DO reach the global stream carrying their own
 * `sessionID`, but NO parent/child relation is obtainable (no `parentID` in the
 * event payload or `ctx.session.get`; `/session/{id}/children` is 404). These
 * tests hold the honest line: discover children as sessions, never fabricate a
 * parent attribution.
 */

test('a session first seen via a successor event is discovered (late subscription misses session.created)', () => {
  const registry = new SessionRegistry({ logger: SILENT })
  // No `session.created` for this session ever arrives — only a later event.
  const outcome = registry.ingest(
    sessionEvent('session.text.delta', 'ses_child', DIRECTORY, {
      assistantMessageID: 'm1',
      delta: 'x',
      ordinal: 0,
    }),
  )
  assert.equal(outcome.accepted, true)
  assert.equal(outcome.created, true, 'a successor event must establish the record')
  assert.equal(outcome.reason, 'discovered')
  const record = registry.get('ses_child')
  assert.ok(record, 'the session must be in the registry')
  assert.equal(record.deleted, false)
  // We never observed the creation, so we do not fake a creation timestamp.
  assert.equal(record.createdAt, null)
  assert.notEqual(record.lastActivityAt, null)
})

test('session.created still records the creation time and reason', () => {
  const registry = new SessionRegistry({ logger: SILENT })
  const outcome = registry.ingest(sessionEvent('session.created', 'ses_root', DIRECTORY, { title: 'Root' }))
  assert.equal(outcome.created, true)
  assert.equal(outcome.reason, 'created')
  const record = registry.get('ses_root')
  assert.equal(record?.title, 'Root')
  assert.notEqual(record?.createdAt, null, 'a real session.created carries the creation time')
})

test('session.deleted removes a session never seen being created', () => {
  const registry = new SessionRegistry({ logger: SILENT })
  const outcome = registry.ingest(sessionEvent('session.deleted', 'ses_gone', DIRECTORY))
  assert.equal(outcome.deleted, true)
  assert.equal(registry.get('ses_gone')?.deleted, true)
  assert.equal(
    registry.list().some((record) => record.nativeId === 'ses_gone'),
    false,
  )
})

test('getCapabilities advertises session.subagents honestly: events supported, parent relation unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-subagents-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, logger: SILENT })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    const capabilities = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{
        capabilityId: string
        supported: boolean
        available: boolean
        allowed: boolean
        metadata: Record<string, unknown>
      }>
    }
    const row = capabilities.capabilities.find(
      (item) => item.capabilityId === CAPABILITY_IDS.sessionSubagents,
    )
    assert.ok(row, 'session.subagents must be advertised')
    // The boolean is scoped to event visibility — that layer is measured as covered.
    assert.equal(row.supported, true)
    assert.equal(row.available, true)
    assert.equal(row.allowed, true)
    assert.equal(row.metadata['eventVisibility'], 'supported')
    // ...and the metadata refuses to claim a parent/child binding, with a reason.
    assert.equal(row.metadata['parentRelation'], 'unavailable')
    assert.ok(String(row.metadata['parentRelationReason']).length > 0, 'unavailable must explain why')
    // Same blind spot as discovery: late subscription never replays session.created.
    assert.equal(row.metadata['discoveryState'], 'partial')
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a fresh TUI session index excludes children from session.list and flips parentRelation to supported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-subagents-index-'))
  const indexPath = join(dir, SESSION_INDEX_FILENAME)
  await writeSessionIndexFile(indexPath, [{ id: 'ses_parent' }, { id: 'ses_child', parentID: 'ses_parent' }])
  const hub = new BridgeHub({ endpointsDirectory: dir, sessionIndexPath: indexPath, logger: SILENT })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    hub.ingest(sessionEvent('session.next.prompted', 'ses_parent', DIRECTORY, { text: 'parent turn' }))
    hub.ingest(sessionEvent('session.next.prompted', 'ses_child', DIRECTORY, { text: 'child turn' }))

    const listed = (await client.request('session.list')) as {
      sessions: Array<{ externalSessionId: string }>
    }
    assert.deepEqual(
      listed.sessions.map((session) => session.externalSessionId),
      ['ses_parent'],
      'the child session must not appear in session.list',
    )

    const capabilities = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{ capabilityId: string; metadata: Record<string, unknown> }>
    }
    const row = capabilities.capabilities.find((item) => item.capabilityId === CAPABILITY_IDS.sessionSubagents)
    assert.equal(row?.metadata['parentRelation'], 'supported')
    assert.equal(row?.metadata['parentRelationSource'], 'tui-session-index')
    assert.equal(row?.metadata['sessionIndexState'], 'fresh')
    assert.equal(row?.metadata['eventVisibility'], 'supported')
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a usable index the Hub excludes nothing and reports parentRelation unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-subagents-noidx-'))
  const hub = new BridgeHub({
    endpointsDirectory: dir,
    sessionIndexPath: join(dir, 'absent.json'),
    logger: SILENT,
  })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    hub.ingest(sessionEvent('session.next.prompted', 'ses_parent', DIRECTORY, { text: 'parent turn' }))
    hub.ingest(sessionEvent('session.next.prompted', 'ses_child', DIRECTORY, { text: 'child turn' }))

    const listed = (await client.request('session.list')) as {
      sessions: Array<{ externalSessionId: string }>
    }
    assert.deepEqual(
      listed.sessions.map((session) => session.externalSessionId).sort(),
      ['ses_child', 'ses_parent'],
      'with no index nothing is filtered — a fail-soft downgrade, not an error',
    )

    const capabilities = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{ capabilityId: string; metadata: Record<string, unknown> }>
    }
    const row = capabilities.capabilities.find((item) => item.capabilityId === CAPABILITY_IDS.sessionSubagents)
    assert.equal(row?.metadata['parentRelation'], 'unavailable')
    assert.equal(row?.metadata['sessionIndexState'], 'missing')
    assert.ok(String(row?.metadata['parentRelationReason']).length > 0, 'unavailable must explain why')
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an expired index downgrades to unavailable and stops excluding, without erroring', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-subagents-stale-'))
  const indexPath = join(dir, SESSION_INDEX_FILENAME)
  // Written ten minutes ago; the hub's ceiling is one minute.
  await writeSessionIndexFile(
    indexPath,
    [{ id: 'ses_parent' }, { id: 'ses_child', parentID: 'ses_parent' }],
    new Date(Date.now() - 600_000),
  )
  const hub = new BridgeHub({
    endpointsDirectory: dir,
    sessionIndexPath: indexPath,
    sessionIndexMaxAgeMs: 60_000,
    logger: SILENT,
  })
  await hub.start()
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    hub.ingest(sessionEvent('session.next.prompted', 'ses_parent', DIRECTORY, { text: 'parent turn' }))
    hub.ingest(sessionEvent('session.next.prompted', 'ses_child', DIRECTORY, { text: 'child turn' }))

    const listed = (await client.request('session.list')) as {
      sessions: Array<{ externalSessionId: string }>
    }
    assert.equal(listed.sessions.length, 2, 'stale data must never hide a session')

    const capabilities = (await client.request('runtime.getCapabilities')) as {
      capabilities: Array<{ capabilityId: string; metadata: Record<string, unknown> }>
    }
    const row = capabilities.capabilities.find((item) => item.capabilityId === CAPABILITY_IDS.sessionSubagents)
    assert.equal(row?.metadata['parentRelation'], 'unavailable')
    assert.equal(row?.metadata['sessionIndexState'], 'expired')
  } finally {
    client.close()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a subagent session is registered as its own session, never merged into a parent', () => {
  const hub = new BridgeHub({ logger: SILENT })
  const parent = 'ses_parent'
  const child = 'ses_child'
  // Parent's turn never emits the child's sessionID, and vice versa.
  hub.ingest(sessionEvent('session.next.prompted', parent, DIRECTORY, { text: 'parent turn' }))
  hub.ingest(sessionEvent('session.next.prompted', child, DIRECTORY, { text: 'child turn' }))

  const ids = hub.sessions.list().map((record) => record.nativeId).sort()
  assert.deepEqual(ids, [child, parent], 'both sessions exist independently')
})

test('child session events project into their own timeline, never the parent\u2019s', () => {
  const projector = new Projector()
  const parent = 'ses_parent'
  const child = 'ses_child'
  let seq = 0
  const feed = (sessionId: string, type: string, data: Record<string, unknown> = {}): void => {
    seq += 1
    projector.apply(sessionId, {
      id: `${type}:${sessionId}:${seq}`,
      created: '2026-01-01T00:00:00.000Z',
      type,
      location: { directory: DIRECTORY },
      data: { sessionID: sessionId, ...data },
    })
  }

  feed(parent, 'session.next.prompted', { text: 'parent turn' })
  feed(parent, 'session.text.started', { assistantMessageID: 'pm', ordinal: 0 })
  feed(parent, 'session.text.delta', { assistantMessageID: 'pm', delta: 'hi', ordinal: 0 })
  feed(child, 'session.next.prompted', { text: 'child turn' })
  feed(child, 'session.text.started', { assistantMessageID: 'cm', ordinal: 0 })
  feed(child, 'session.text.delta', { assistantMessageID: 'cm', delta: 'yo', ordinal: 0 })

  const parentItems = projector.timeline(parent)
  const childItems = projector.timeline(child)
  assert.ok(parentItems.length > 0 && childItems.length > 0)
  // Every item is attributed to its own native session id.
  assert.ok(parentItems.every((item) => item.sessionId === parent))
  assert.ok(childItems.every((item) => item.sessionId === child))
  // No fabricated parent attribution: the child's content never leaks upward.
  assert.equal(
    parentItems.some((item) => item.content['text'] === 'yo'),
    false,
  )
  assert.equal(
    childItems.some((item) => item.content['text'] === 'hi'),
    false,
  )
})
