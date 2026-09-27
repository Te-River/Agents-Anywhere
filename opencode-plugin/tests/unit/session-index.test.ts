import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectIndexedSessions,
  parseSessionIndex,
  SessionIndex,
  SESSION_INDEX_FILENAME,
  sessionIndexPath,
  writeSessionIndexFile,
} from '../../src/shared/session-index.js'
import { startSessionIndexWriter, publishSessionIndexOnce } from '../../src/tui/index.js'
import { createLogger } from '../../src/shared/logger.js'

const SILENT = createLogger('test', () => undefined)

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aa-oc-index-'))
}

/** Poll until `check` is true or the deadline passes (timer-based write test). */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

/** Does `path` exist? Backs the negative "directory was not re-created" probe. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('session index round-trips sessions and exposes child → parent', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    await writeSessionIndexFile(
      file,
      [
        { id: 'ses_root', title: 'Root', agent: 'build', location: 'D:/proj/a' },
        { id: 'ses_child', parentID: 'ses_root' },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    )
    const index = new SessionIndex({
      path: file,
      now: () => Date.parse('2026-01-01T00:00:30.000Z'),
      logger: SILENT,
    })
    await index.refresh()
    assert.equal(index.state, 'fresh')
    assert.equal(index.available, true)
    assert.equal(index.updatedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(index.sessions.length, 2)
    assert.equal(index.isChild('ses_child'), true)
    assert.equal(index.isChild('ses_root'), false)
    assert.equal(index.parentOf('ses_child'), 'ses_root')
    assert.equal(index.parentOf('ses_root'), null)
    assert.deepEqual([...index.childIds], ['ses_child'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the index is written atomically: valid JSON, no .tmp residue, last write wins', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    await writeSessionIndexFile(file, [{ id: 'ses_a' }])
    await writeSessionIndexFile(file, [{ id: 'ses_b', parentID: 'ses_a' }])
    const entries = await readdir(dir)
    assert.deepEqual(
      entries.filter((name) => name.endsWith('.tmp')),
      [],
      'the tmp file must be renamed away, never left behind',
    )
    assert.deepEqual(parseSessionIndex(await readFile(file, 'utf8'))?.sessions, [
      { id: 'ses_b', parentID: 'ses_a' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing index is unavailable, never an error', async () => {
  const dir = await tempDir()
  try {
    const index = new SessionIndex({ path: join(dir, 'nope.json'), logger: SILENT })
    await assert.doesNotReject(() => index.refresh())
    assert.equal(index.state, 'missing')
    assert.equal(index.available, false)
    assert.equal(index.updatedAt, null)
    assert.equal(index.isChild('ses_child'), false)
    assert.equal(index.childIds.size, 0)
    assert.equal(index.parentOf('ses_child'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt index degrades to invalid instead of throwing', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    await writeFile(file, '{ this is not json', 'utf8')
    const index = new SessionIndex({ path: file, logger: SILENT })
    await assert.doesNotReject(() => index.refresh())
    assert.equal(index.state, 'invalid')
    assert.equal(index.available, false)
    assert.equal(index.isChild('ses_child'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an index outside the freshness window is unusable (expired or future-dated)', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    const now = Date.parse('2026-01-01T01:00:00.000Z')
    // Too old: the TUI stopped refreshing.
    await writeSessionIndexFile(file, [{ id: 'ses_child', parentID: 'ses_root' }], new Date(now - 600_000))
    const stale = new SessionIndex({ path: file, now: () => now, maxAgeMs: 60_000, logger: SILENT })
    await stale.refresh()
    assert.equal(stale.state, 'expired')
    assert.equal(stale.available, false)
    assert.equal(stale.isChild('ses_child'), false, 'a stale index must not drive exclusion')

    // Stamped from the future, beyond the skew allowance: not trustworthy.
    await writeSessionIndexFile(file, [{ id: 'ses_child', parentID: 'ses_root' }], new Date(now + 600_000))
    const future = new SessionIndex({
      path: file,
      now: () => now,
      maxAgeMs: 60_000,
      maxSkewMs: 60_000,
      logger: SILENT,
    })
    await future.refresh()
    assert.equal(future.state, 'invalid')
    assert.equal(future.available, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectIndexedSessions accepts both the SDK { data } shape and a bare array, never invents parentID', () => {
  const sessions = collectIndexedSessions({
    data: [
      { id: 'ses_root', title: 'Root', directory: 'D:/proj/a' },
      { id: 'ses_child', parentID: 'ses_root', agent: 'explore' },
      { id: '' },
      'not-an-object',
    ],
  })
  assert.deepEqual(sessions, [
    { id: 'ses_root', title: 'Root', location: 'D:/proj/a' },
    { id: 'ses_child', parentID: 'ses_root', agent: 'explore' },
  ])
  assert.deepEqual(collectIndexedSessions([{ id: 'ses_a' }]), [{ id: 'ses_a' }])
  // An unrecognised shape is NOT an empty list — the caller must keep the old index.
  assert.equal(collectIndexedSessions({ unexpected: true }), null)
  assert.equal(collectIndexedSessions(null), null)
})

test('the TUI writer publishes exactly what session.list returned', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    const calls: unknown[] = []
    const api = {
      client: {
        session: {
          list: async (params?: unknown) => {
            calls.push(params)
            return {
              data: [
                { id: 'ses_root', title: 'Root' },
                { id: 'ses_child', parentID: 'ses_root', agent: 'explore' },
              ],
            }
          },
        },
      },
    }
    await publishSessionIndexOnce(api as never, { path: file })
    assert.deepEqual(calls, [{ roots: false }], 'all sessions are requested (roots:false)')
    const parsed = parseSessionIndex(await readFile(file, 'utf8'))
    assert.deepEqual(parsed?.sessions, [
      { id: 'ses_root', title: 'Root' },
      { id: 'ses_child', parentID: 'ses_root', agent: 'explore' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the TUI writer is fail-soft: a throwing or opaque session.list changes nothing', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    await writeSessionIndexFile(file, [{ id: 'ses_keep' }])

    const throwing = { client: { session: { list: async () => { throw new Error('host boom') } } } }
    assert.equal(await publishSessionIndexOnce(throwing as never, { path: file }), false)
    assert.equal(await publishSessionIndexOnce({} as never, { path: file }), false)

    const opaque = { client: { session: { list: async () => ({ unexpected: true }) } } }
    assert.equal(await publishSessionIndexOnce(opaque as never, { path: file }), false)

    assert.deepEqual(
      parseSessionIndex(await readFile(file, 'utf8'))?.sessions,
      [{ id: 'ses_keep' }],
      'a failed or unrecognised enumeration never clobbers a good index',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startSessionIndexWriter publishes on start and stops on dispose', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, SESSION_INDEX_FILENAME)
    let listCalls = 0
    const api = {
      client: {
        session: {
          list: async () => {
            listCalls += 1
            return { data: [{ id: 'ses_child', parentID: 'ses_root' }] }
          },
        },
      },
    }
    const stop = startSessionIndexWriter(api as never, { path: file, intervalMs: 5 })
    assert.equal(
      await waitUntil(async () => {
        try {
          return (await readFile(file, 'utf8')).includes('ses_child')
        } catch {
          return false
        }
      }),
      true,
      'the first tick must publish without waiting for the interval',
    )
    // Await the stop handle: it is synchronous today, but dispose must also
    // drain a publish already in flight, and awaiting holds either way.
    await stop()
    const after = parseSessionIndex(await readFile(file, 'utf8'))
    assert.deepEqual(after?.sessions, [{ id: 'ses_child', parentID: 'ses_root' }])
    // Dispose must stop the writer: no new enumeration may start after it
    // returns. Probing a negative needs a bounded wait (a few intervals); it
    // proves the absence of new work — it is not a delay that hides a race.
    const callsAtStop = listCalls
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(listCalls, callsAtStop, 'dispose must stop the writer: no publish after stop')
  } finally {
    // A publish that started before `stop()` can still be mid-write here: the
    // writer stops *starting* work, it does not drain what is already running
    // (the drain belongs to the writer itself, src/tui). On Windows `rmdir`
    // returns ENOTEMPTY the moment a writer's `*.tmp` lands between enumeration
    // and removal, so retry the removal — Node's documented remedy for
    // EBUSY/ENOTEMPTY/EPERM — instead of racing it. A genuine leftover still
    // rejects once the retries are exhausted, so no failure is swallowed.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('await stop() drains an in-flight publish so a later cleanup is not undone', async () => {
  const dir = await tempDir()
  const bridge = join(dir, 'bridge')
  const file = join(bridge, SESSION_INDEX_FILENAME)
  try {
    let listCalls = 0
    // A gate held closed until the test releases it, so the initial publish is
    // reliably *in flight* at the moment `stop()` is called — the exact race the
    // drain must close, with no timing guesswork.
    let releaseList!: () => void
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    const api = {
      client: {
        session: {
          list: async () => {
            listCalls += 1
            await listGate
            return { data: [{ id: 'ses_child', parentID: 'ses_root' }] }
          },
        },
      },
    }
    const stop = startSessionIndexWriter(api as never, { path: file, intervalMs: 60_000 })
    assert.equal(await waitUntil(async () => listCalls >= 1), true, 'the initial publish must start')

    const stopping = stop()
    let settled = false
    void stopping.then(() => {
      settled = true
    })
    // Negative probe: while the publish is gated, a non-draining stop() would
    // already have resolved. The wait only gives that (buggy) resolution time to
    // appear — it does not paper over a race we hope to win.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false, 'stop() must not resolve while a publish is in flight')

    releaseList()
    await stopping
    // The drained publish ran to completion before stop() resolved.
    assert.equal((await readFile(file, 'utf8')).includes('ses_child'), true)

    // Cleanup. Because stop() drained, nothing is left to write: the removed
    // directory must stay gone (a late write would `mkdir -p` it back). The
    // bounded wait is a negative assertion — it lets any late write reveal
    // itself; it is not the thing that makes the test pass.
    await rm(bridge, { recursive: true, force: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(await exists(bridge), false, 'no write may re-create the removed directory')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('sessionIndexPath honours AGENT_CONNECTOR_DATA_DIR', () => {
  const previous = process.env['AGENT_CONNECTOR_DATA_DIR']
  try {
    process.env['AGENT_CONNECTOR_DATA_DIR'] = 'D:/custom-data'
    assert.equal(sessionIndexPath(), join('D:/custom-data', 'opencode-bridge', SESSION_INDEX_FILENAME))
  } finally {
    if (previous === undefined) delete process.env['AGENT_CONNECTOR_DATA_DIR']
    else process.env['AGENT_CONNECTOR_DATA_DIR'] = previous
  }
})
