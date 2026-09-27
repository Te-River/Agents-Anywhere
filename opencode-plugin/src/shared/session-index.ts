/**
 * TUI → Hub session index channel.
 *
 * Measured (spike 02 §3.1–§3.4): the runtime's global event stream and
 * `ctx.session` expose **no** parent/child linkage — the runtime `session.created`
 * payload has no `info`, `ctx.session.get` returns no `parentID`, and the SDK's
 * `GET /session/{id}/children` is 404 on this build. The one surface whose
 * *published type* does carry the relation is the **TUI host SDK client**
 * (`api.client`, i.e. `OpencodeClient.session.list`, whose v2 `Session` type has
 * `parentID?: string` — `@opencode-ai/sdk/v2` `types.gen.d.ts`). So:
 *
 * - the **TUI plugin** enumerates sessions through that client and publishes what
 *   it actually received to a JSON file, written atomically;
 * - the **Hub** reads that file (fail-soft) to learn which sessions are children.
 *
 * The channel is best-effort by construction and never invents data:
 *
 * - the TUI may not be running (headless hosts) → the file is absent or stale and
 *   the Hub downgrades to `parentRelation: "unavailable"`;
 * - the runtime may or may not return `parentID` in `session.list` → the TUI
 *   writes only the fields it received; a session with no `parentID` is written
 *   without one;
 * - the file is only trusted while **fresh** (`SessionIndex.state === 'fresh'`),
 *   so a crashed TUI cannot leave the Hub advertising a relation it can no longer
 *   refresh.
 *
 * Nothing here reads OpenCode's SQLite store: `session_v2.parent_id` was
 * deliberately not chosen (user decision).
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { bridgeDirectory } from './endpoint-store.js'
import type { Logger } from './logger.js'

export const SESSION_INDEX_FILENAME = 'session-index.json'

/** How often the TUI re-publishes the index while it is running. */
export const SESSION_INDEX_WRITE_INTERVAL_MS = 60_000

/** Freshness ceiling: an index older than this is unusable. */
export const SESSION_INDEX_MAX_AGE_MS = 300_000

/** Future-timestamp tolerance: a stamp further ahead than this is rejected. */
export const SESSION_INDEX_MAX_SKEW_MS = 120_000

/** How often the Hub will *attempt* a reload of the file (throttle). */
export const SESSION_INDEX_RELOAD_INTERVAL_MS = 30_000

/** One session as the TUI client reported it. */
export interface IndexedSession {
  id: string
  parentID?: string
  title?: string
  agent?: string
  /** `Session.directory` from the TUI client; kept for future location scoping. */
  location?: string
}

export interface SessionIndexSnapshot {
  updatedAt: string
  sessions: IndexedSession[]
}

export type SessionIndexState = 'fresh' | 'missing' | 'invalid' | 'expired'

/** `<bridge dir>/session-index.json` (honours `AGENT_CONNECTOR_DATA_DIR`). */
export function sessionIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(bridgeDirectory(env), SESSION_INDEX_FILENAME)
}

/**
 * Coerce one raw session entry into an `IndexedSession`. A missing/empty `id`
 * makes the entry unusable (`null`) rather than allowing an unattributable row;
 * every optional field is copied **only** when it is a non-empty string, so a
 * field the runtime did not send is never fabricated.
 */
export function toIndexedSession(value: unknown): IndexedSession | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = record['id']
  if (typeof id !== 'string' || id.length === 0) return null
  const session: IndexedSession = { id }
  const parentID = record['parentID']
  if (typeof parentID === 'string' && parentID.length > 0) session.parentID = parentID
  const title = record['title']
  if (typeof title === 'string' && title.length > 0) session.title = title
  const agent = record['agent']
  if (typeof agent === 'string' && agent.length > 0) session.agent = agent
  const location = record['directory'] ?? record['location']
  if (typeof location === 'string' && location.length > 0) session.location = location
  return session
}

/**
 * Extract the session list from a TUI client result. The SDK's `session.list`
 * resolves to `{ data, error }`; a bare array is also accepted (older/other
 * call shapes). `null` means "shape not recognised" — the caller must then keep
 * the previous index instead of overwriting it with an empty one.
 */
export function collectIndexedSessions(payload: unknown): IndexedSession[] | null {
  const data = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : null
  if (data === null) return null
  const sessions: IndexedSession[] = []
  for (const entry of data) {
    const session = toIndexedSession(entry)
    if (session !== null) sessions.push(session)
  }
  return sessions
}

/** Parse an index file; a structurally invalid document returns `null`. */
export function parseSessionIndex(raw: string): SessionIndexSnapshot | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const updatedAt = record['updatedAt']
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) return null
  const rawSessions = record['sessions']
  if (!Array.isArray(rawSessions)) return null
  const sessions: IndexedSession[] = []
  for (const entry of rawSessions) {
    const session = toIndexedSession(entry)
    if (session !== null) sessions.push(session)
  }
  return { updatedAt, sessions }
}

/**
 * Write the index atomically (tmp → fsync → rename): a reader sees either the
 * previous complete file or the new complete file, never a partial write.
 */
export async function writeSessionIndexFile(
  targetPath: string,
  sessions: readonly IndexedSession[],
  now: Date = new Date(),
): Promise<SessionIndexSnapshot> {
  const snapshot: SessionIndexSnapshot = { updatedAt: now.toISOString(), sessions: [...sessions] }
  const directory = dirname(targetPath)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const tmp = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(snapshot), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tmp, targetPath)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  return snapshot
}

/**
 * `writeSessionIndexFile` on the resolved path, swallow-on-failure. Returns
 * whether the file was published; the TUI must never abort on a failed publish.
 */
export async function writeSessionIndex(
  sessions: readonly IndexedSession[],
  options: { path?: string; now?: Date } = {},
): Promise<boolean> {
  try {
    await writeSessionIndexFile(options.path ?? sessionIndexPath(), sessions, options.now ?? new Date())
    return true
  } catch {
    return false
  }
}

/** Build session id → parent id from a snapshot (only entries that have a parent). */
export function indexParents(snapshot: SessionIndexSnapshot): Map<string, string> {
  const parents = new Map<string, string>()
  for (const session of snapshot.sessions) {
    if (session.parentID !== undefined && session.parentID !== session.id) {
      parents.set(session.id, session.parentID)
    }
  }
  return parents
}

export interface SessionIndexOptions {
  /** Defaults to `sessionIndexPath()`. */
  path?: string
  maxAgeMs?: number
  maxSkewMs?: number
  reloadIntervalMs?: number
  /** Injectable clock (tests). */
  now?: () => number
  logger?: Logger
}

/**
 * Fail-soft reader for the TUI-written index.
 *
 * `refresh()` never throws: a missing, unreadable, corrupt or unexpected file
 * simply leaves the index unavailable. `state` folds the last load outcome with
 * the freshness window, and every consumer (`isChild`, `parentOf`) is gated on
 * `available`, so an expired index behaves exactly like no index at all — the
 * Hub then reports `parentRelation: "unavailable"` instead of acting on stale
 * data.
 */
export class SessionIndex {
  readonly #path: string
  readonly #maxAgeMs: number
  readonly #maxSkewMs: number
  readonly #reloadIntervalMs: number
  readonly #now: () => number
  readonly #logger: Logger | undefined
  #snapshot: SessionIndexSnapshot | null = null
  #parents = new Map<string, string>()
  #loadState: 'missing' | 'invalid' = 'missing'
  #lastAttempt = 0
  #refreshing = false

  constructor(options: SessionIndexOptions = {}) {
    this.#path = options.path ?? sessionIndexPath()
    this.#maxAgeMs = options.maxAgeMs ?? SESSION_INDEX_MAX_AGE_MS
    this.#maxSkewMs = options.maxSkewMs ?? SESSION_INDEX_MAX_SKEW_MS
    this.#reloadIntervalMs = options.reloadIntervalMs ?? SESSION_INDEX_RELOAD_INTERVAL_MS
    this.#now = options.now ?? Date.now
    this.#logger = options.logger
  }

  get path(): string {
    return this.#path
  }

  /** Freshness verdict: `fresh` is the only state a consumer may act on. */
  get state(): SessionIndexState {
    if (this.#snapshot === null) return this.#loadState
    return this.#freshness(this.#snapshot.updatedAt)
  }

  get available(): boolean {
    return this.state === 'fresh'
  }

  get updatedAt(): string | null {
    return this.#snapshot?.updatedAt ?? null
  }

  /** Sessions the TUI last reported (not necessarily fresh). */
  get sessions(): readonly IndexedSession[] {
    return this.#snapshot?.sessions ?? []
  }

  /** Child session ids, empty unless the index is usable. */
  get childIds(): Set<string> {
    return this.available ? new Set(this.#parents.keys()) : new Set()
  }

  isChild(nativeId: string): boolean {
    return this.available && this.#parents.has(nativeId)
  }

  parentOf(nativeId: string): string | null {
    if (!this.available) return null
    return this.#parents.get(nativeId) ?? null
  }

  /**
   * Reload the file. Never rejects and never throws synchronously: every failure
   * mode becomes an unavailable state (`missing` / `invalid`), so the Hub's
   * capability row and session list stay honest.
   */
  async refresh(): Promise<void> {
    this.#lastAttempt = this.#now()
    this.#refreshing = true
    try {
      const raw = await fs.readFile(this.#path, 'utf8')
      const snapshot = parseSessionIndex(raw)
      if (snapshot === null) {
        this.#forget('invalid')
        this.#logger?.debug('session index is unreadable; parent relation stays unavailable', {
          path: this.#path,
        })
        return
      }
      this.#snapshot = snapshot
      this.#parents = indexParents(snapshot)
      this.#logger?.debug('session index loaded', {
        sessions: snapshot.sessions.length,
        children: this.#parents.size,
      })
    } catch (error) {
      // A missing file is the normal headless case, not an error.
      this.#forget(isMissing(error) ? 'missing' : 'invalid')
    } finally {
      this.#refreshing = false
    }
  }

  /**
   * Fire-and-forget reload for synchronous request paths, throttled so a burst
   * of requests cannot turn into a burst of reads. Safe to call unconditionally.
   */
  maybeRefresh(): void {
    if (this.#refreshing) return
    if (this.#now() - this.#lastAttempt < this.#reloadIntervalMs) return
    void this.refresh().catch(() => undefined)
  }

  #forget(loadState: 'missing' | 'invalid'): void {
    this.#snapshot = null
    this.#parents = new Map()
    this.#loadState = loadState
  }

  #freshness(updatedAt: string): SessionIndexState {
    const parsed = Date.parse(updatedAt)
    if (Number.isNaN(parsed)) return 'invalid'
    const age = this.#now() - parsed
    // Both bounds matter: too old means the TUI stopped refreshing, a stamp from
    // the future (beyond clock skew) means the document is not trustworthy.
    if (age < -this.#maxSkewMs) return 'invalid'
    if (age > this.#maxAgeMs) return 'expired'
    return 'fresh'
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
