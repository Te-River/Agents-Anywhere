/**
 * Incremental session registry.
 *
 * One subscription over the process-wide event stream feeds this table. Session
 * discovery is therefore *partial* by construction: sessions that existed before
 * the plugin loaded stay invisible until they emit an event (cold-start blind
 * spot), and the subscription does not replay — a session created before the
 * subscribe point permanently loses its `session.created`, so a session we do
 * see still has an unknown creation and an incomplete prefix. `partial` is
 * reported to the Connector instead of being hidden.
 *
 * Discovery is therefore anchored on **any** event carrying the session id, not
 * on `session.created` specifically: the first successor event we see for an
 * unknown session establishes its record (reason `discovered`), because the
 * creation event may never arrive.
 */

import { platformSessionId } from '../shared/protocol.js'
import type { Logger } from '../shared/logger.js'
import type { OpenCodeEvent } from './opencode-ctx.js'
import { normalizeDirectory } from './paths.js'

export interface SessionRecord {
  nativeId: string
  directory: string
  title: string | null
  createdAt: string | null
  lastActivityAt: string | null
  deleted: boolean
}

export interface SessionIngest {
  accepted: boolean
  nativeId: string | null
  created: boolean
  deleted: boolean
  reason: string
}

/**
 * Namespaces the projector understands. The global stream also carries unrelated
 * domain events (`provider.updated`, `models-dev.refreshed`, …) which are dropped
 * here, before any projection work.
 */
const ACCEPTED_PREFIXES = ['session.', 'permission.', 'shell.'] as const

export class SessionRegistry {
  readonly #records = new Map<string, SessionRecord>()
  readonly #allowedDirectories: Set<string>
  readonly #logger: Logger
  #filteredByType = 0
  #filteredByLocation = 0

  constructor(options: { allowedDirectories?: Iterable<string>; logger: Logger }) {
    this.#logger = options.logger
    this.#allowedDirectories = new Set(
      [...(options.allowedDirectories ?? [])].map((directory) => normalizeDirectory(directory)),
    )
  }

  /**
   * Always `true`: the `complete` state is **unreachable by design**.
   *
   * The registry is filled exclusively by the global event stream (rev3 session
   * discovery scheme ①). Two measured facts (spike 02 §3.5) make `partial`
   * inescapable, and neither is a bug to "wait out":
   *
   * - **cold-start blind spot** — sessions that already existed when the plugin
   *   loaded and never emit another event stay invisible, and the platform
   *   exposes no enumeration/snapshot API to reconcile them;
   * - **no replay** — `event.subscribe()` delivers only post-subscribe events, so
   *   a session created before the subscribe point permanently loses its
   *   `session.created`. Even a session we *do* discover (via a later event) is
   *   missing its creation and the prefix of its history.
   *
   * With no full-coverage channel, no event sequence proves every session is
   * known — a `complete` report could only ever be a false claim. Reporting
   * `partial` forever is the honest state; rev3 records the missing
   * reconciliation channel as the open item A10.
   *
   * Do NOT "fix" this by flipping the flag once the stream goes quiet or after N
   * events: quietness is not coverage, and advertising `complete` would make the
   * Connector stop surfacing the blind spot to the platform.
   */
  get partial(): true {
    return true
  }

  get filtered(): { byType: number; byLocation: number } {
    return { byType: this.#filteredByType, byLocation: this.#filteredByLocation }
  }

  allowDirectory(directory: string): void {
    this.#allowedDirectories.add(normalizeDirectory(directory))
  }

  revokeDirectory(directory: string): void {
    this.#allowedDirectories.delete(normalizeDirectory(directory))
  }

  /** Double filter: `event.type` namespace AND `event.location.directory`. */
  ingest(event: OpenCodeEvent): SessionIngest {
    const type = typeof event.type === 'string' ? event.type : null
    if (type === null || !isAcceptedType(type)) {
      this.#filteredByType += 1
      return rejected('type')
    }
    const directory = event.location?.directory
    if (
      typeof directory === 'string' &&
      this.#allowedDirectories.size > 0 &&
      !this.#allowedDirectories.has(normalizeDirectory(directory))
    ) {
      // The stream is global across locations; a session for a project this
      // process does not serve must not leak into our timeline.
      this.#filteredByLocation += 1
      return rejected('location')
    }

    const nativeId = extractSessionId(event)
    if (nativeId === null) {
      // No session identity (e.g. a bare `session.created` without data).
      return { accepted: true, nativeId: null, created: false, deleted: false, reason: 'no-session-id' }
    }

    const existing = this.#records.get(nativeId)
    // Keep the raw directory for display; filtering uses its normalised form.
    const resolvedDirectory =
      typeof directory === 'string' && directory.length > 0
        ? directory
        : (existing?.directory ?? '')
    const activity = typeof event.created === 'string' ? event.created : null

    if (type === 'session.deleted') {
      if (!existing) {
        this.#records.set(nativeId, {
          nativeId,
          directory: resolvedDirectory,
          title: null,
          // We never saw the creation, so the delete event's timestamp is not it.
          createdAt: null,
          lastActivityAt: activity,
          deleted: true,
        })
        return { accepted: true, nativeId, created: true, deleted: true, reason: 'deleted' }
      }
      existing.deleted = true
      existing.lastActivityAt = activity ?? existing.lastActivityAt
      return { accepted: true, nativeId, created: false, deleted: true, reason: 'deleted' }
    }

    if (!existing) {
      // A `session.created` is not required to establish the record: a late
      // subscription permanently misses it, so any successor event carrying the
      // session id discovers the session (`discovered`). Only a real
      // `session.created` gives us a trustworthy creation time.
      const fromCreation = type === 'session.created'
      this.#records.set(nativeId, {
        nativeId,
        directory: resolvedDirectory,
        title: extractTitle(event),
        createdAt: fromCreation ? activity : null,
        lastActivityAt: activity,
        deleted: false,
      })
      this.#logger.debug('session discovered from event stream', { event: type })
      return {
        accepted: true,
        nativeId,
        created: true,
        deleted: false,
        reason: fromCreation ? 'created' : 'discovered',
      }
    }

    existing.lastActivityAt = activity ?? existing.lastActivityAt
    if (resolvedDirectory.length > 0 && existing.directory.length === 0) {
      existing.directory = resolvedDirectory
    }
    const title = extractTitle(event)
    if (title !== null) existing.title = title
    return { accepted: true, nativeId, created: false, deleted: false, reason: 'touched' }
  }

  list(limit?: number, directory?: string): SessionRecord[] {
    const filter = directory === undefined ? null : normalizeDirectory(directory)
    const records = [...this.#records.values()].filter(
      (record) => !record.deleted && (filter === null || recordMatchesLocation(record, filter)),
    )
    records.sort((left, right) => (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''))
    if (limit !== undefined && limit >= 0 && records.length > limit) return records.slice(0, limit)
    return records
  }

  get(nativeId: string): SessionRecord | undefined {
    return this.#records.get(nativeId)
  }

  /**
   * Reverse lookup: platform session id → native OpenCode session id, scoped to
   * the connection's location (rev3 ruling 1: another location's session is
   * *invisible*, not merely unlisted).
   */
  findByPlatformId(
    sessionId: string,
    namespace: string,
    directory?: string,
  ): SessionRecord | undefined {
    const filter = directory === undefined ? null : normalizeDirectory(directory)
    for (const record of this.#records.values()) {
      if (filter !== null && !recordMatchesLocation(record, filter)) continue
      if (platformSessionId(namespace, record.nativeId) === sessionId) return record
    }
    return undefined
  }

  get size(): number {
    return this.#records.size
  }
}

function isAcceptedType(type: string): boolean {
  return ACCEPTED_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/**
 * The session an event is attributed to. Measured (spike 02 §3.1/§3.2): every
 * session-scoped event we accepted carries `data.sessionID`, equal to
 * `durable.aggregateID`. We deliberately read only `data.sessionID` — using the
 * aggregate id as a fallback would risk inventing a session from an unrelated
 * aggregate, and no measured accepted event needs it. An event with no
 * `sessionID` is left unattributed rather than guessed.
 */
function extractSessionId(event: OpenCodeEvent): string | null {
  const data = event.data
  if (data === undefined || data === null) return null
  const value = data['sessionID']
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function extractTitle(event: OpenCodeEvent): string | null {
  const data = event.data
  if (data === undefined) return null
  return asString(data['title']) ?? asString(data['name'])
}

function rejected(reason: string): SessionIngest {
  return { accepted: false, nativeId: null, created: false, deleted: false, reason }
}

/**
 * Per-connection view filter (rev3 ruling 1). `normalized` MUST already be the
 * output of `normalizeDirectory`, so both sides of the comparison use the exact
 * same canonical form. A session with no observed directory never matches.
 */
export function recordMatchesLocation(record: SessionRecord, normalized: string): boolean {
  return record.directory.length > 0 && normalizeDirectory(record.directory) === normalized
}
