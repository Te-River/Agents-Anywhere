import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '../../src/shared/file-lock.js'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-lock-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('withFileLock serialises overlapping critical sections and releases the file', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'binding.json.lock')
    const order: string[] = []
    const first = withFileLock(
      lock,
      async () => {
        order.push('a:enter')
        await new Promise((resolve) => setTimeout(resolve, 60))
        order.push('a:exit')
      },
      { pollMs: 5 },
    )
    // Let the first holder actually create the lock before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 15))
    const second = withFileLock(
      lock,
      async () => {
        order.push('b:enter')
        order.push('b:exit')
      },
      { pollMs: 5 },
    )
    await Promise.all([first, second])
    assert.deepEqual(order, ['a:enter', 'a:exit', 'b:enter', 'b:exit'])
    // Released on the way out: a fresh acquisition succeeds immediately.
    await withFileLock(lock, async () => undefined)
    await assert.rejects(readFile(lock, 'utf8'), /ENOENT/)
  })
})

test('a lock left behind by a crash is reclaimed after staleMs', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'binding.json.lock')
    await writeFile(lock, '999999 0\n', 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    let ran = false
    await withFileLock(lock, async () => {
      ran = true
    }, { staleMs: 1_000, pollMs: 5 })
    assert.equal(ran, true, 'the stale lock must not block work forever')
  })
})

test('a live lock makes the waiter proceed after waitMs and reports the timeout', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'binding.json.lock')
    await writeFile(lock, '4242 ' + Date.now() + '\n', 'utf8')
    const timeouts: number[] = []
    let ran = false
    await withFileLock(
      lock,
      async () => {
        ran = true
      },
      { waitMs: 30, pollMs: 5, onTimeout: (waited) => timeouts.push(waited) },
    )
    assert.equal(ran, true, 'a lock is coordination, never a reason to stop connecting')
    assert.equal(timeouts.length, 1)
    assert.ok((timeouts[0] ?? 0) >= 30)
    // The lock we never owned is left exactly as the real holder had it.
    assert.match(await readFile(lock, 'utf8'), /^4242 /)
  })
})

test('the lock is released when the critical section throws', async () => {
  await withTempDir(async (dir) => {
    const lock = join(dir, 'binding.json.lock')
    await assert.rejects(
      withFileLock(lock, async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    let ran = false
    await withFileLock(lock, async () => {
      ran = true
    }, { waitMs: 50, pollMs: 5 })
    assert.equal(ran, true)
  })
})
