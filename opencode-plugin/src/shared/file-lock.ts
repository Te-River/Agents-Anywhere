/**
 * Best-effort cross-process lock for one file-owned resource — the device
 * binding (`credentials.ts`) is the only user today.
 *
 * Why a *file* lock and not just an in-process mutex: the real machine runs
 * more than one OpenCode process against the same `~/.agents-anywhere` data
 * dir, and a rotation/registration performed by two processes at once is
 * exactly how a local token ends up disagreeing with the server (one process
 * rotates, the other overwrites the binding with the token it read before).
 * The lock file lives beside the binding so the critical section is short
 * (verify → rotate/register → atomic save), never the interactive login.
 *
 * Guarantees, deliberately weak on purpose:
 *   - mutual exclusion while the holder lives (O_EXCL create);
 *   - an abandoned lock (a crash) is reclaimed after `staleMs`;
 *   - a waiter that exhausts `waitMs` **proceeds anyway** and reports the
 *     timeout, because locking is coordination, not correctness: refusing to
 *     connect because a lock file is stuck would be a worse failure mode than
 *     racing. Callers must therefore still write atomically and re-read.
 *
 * No secret ever reaches the lock file: pid + timestamp only.
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export const LOCK_WAIT_MS = 10_000
export const LOCK_STALE_MS = 60_000
export const LOCK_POLL_MS = 40

export interface FileLockOptions {
  /** How long to wait for the holder before proceeding unlocked. */
  waitMs?: number
  /** An existing lock older than this is treated as abandoned. */
  staleMs?: number
  /** Poll interval while waiting. */
  pollMs?: number
  /** Injectable clock (tests never wait on a real one). */
  now?: () => number
  /** Called when the wait ran out and `work` proceeds unlocked. */
  onTimeout?: (waitedMs: number) => void
}

/**
 * Run `work` under `lockPath`. The lock is released even when `work` throws;
 * a timeout never throws — see the module comment.
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const started = now()
  let held = false
  while (!held) {
    held = await tryAcquire(lockPath, now, staleMs)
    if (held) break
    if (now() - started >= waitMs) {
      options.onTimeout?.(now() - started)
      break
    }
    await delay(pollMs)
  }
  try {
    return await work()
  } finally {
    if (held) await fs.rm(lockPath, { force: true }).catch(() => undefined)
  }
}

/** One acquisition attempt: create exclusively, else reclaim only if stale. */
async function tryAcquire(lockPath: string, now: () => number, staleMs: number): Promise<boolean> {
  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  if (await create(lockPath, now)) return true
  try {
    const info = await fs.stat(lockPath)
    if (now() - info.mtimeMs > staleMs) {
      await fs.rm(lockPath, { force: true }).catch(() => undefined)
      return await create(lockPath, now)
    }
  } catch {
    // The holder released it between our create and stat: retry the create.
    return await create(lockPath, now)
  }
  return false
}

async function create(lockPath: string, now: () => number): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false
    throw error
  }
  try {
    await handle.writeFile(`${process.pid} ${now()}\n`, 'utf8')
  } finally {
    await handle.close()
  }
  return true
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
