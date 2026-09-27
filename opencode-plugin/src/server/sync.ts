/**
 * Push-sync tracker for the Bridge Hub (design §2.3 subscribe/ack + `sync.batch`).
 *
 * One tracker per Hub owns, per native session:
 *
 * - the **durable-history hash chain** (`historyHash`): `sha256` folded over
 *   each new maximum `durable.seq`, so a reconnect can be calibrated to an
 *   exact prefix. Only a strictly increasing `durable.seq` advances the chain —
 *   the same monotonic rule the projection checkpoint uses.
 * - the **per-item durable seq**, so a calibrated resume pushes only the delta
 *   rather than replaying the whole timeline.
 * - the diff signatures behind `phase:"notifications"` live updates.
 *
 * `throughSeq` is the largest `durable.seq` the Hub has projected. The Connector
 * cannot observe native OpenCode events, so the Hub alone owns this value
 * (rev3 §2.6 and the §4.1 ownership split); the Connector persists it verbatim.
 */

import { canonicalJson, sha256Hex, type TimelineItem } from '../shared/protocol.js'
import type { OpenCodeEvent } from './opencode-ctx.js'
import type { ProjectionNotice, ProjectionState } from './projector.js'

/** Genesis digest of the empty durable history (`throughSeq === 0`). */
const GENESIS_HISTORY_HASH = sha256Hex('opencode/history/v1')

/**
 * Retained sequence→chain entries. A `fromSeq` older than the window is
 * treated as unknown → full snapshot, which is always safe.
 */
const MAX_RETAINED_SEQUENCES = 4096

export interface SyncHead {
  throughSeq: number
  historyHash: string
}

export interface SyncSelection extends SyncHead {
  /** `incremental` only when `fromSeq`+`historyHash` matched a known prefix. */
  mode: 'snapshot' | 'incremental'
  fromSeq: number | null
  /** `null` means "send every item" (full snapshot); otherwise a delta. */
  itemIds: string[] | null
}

export interface SessionMetaView {
  title: string | null
  directory: string
  lastActivityAt: string | null
}

/** Everything the tracker needs to diff one apply() against the last one. */
export interface SessionView {
  items: readonly TimelineItem[]
  state: ProjectionState | null
  notices: readonly ProjectionNotice[]
  meta: SessionMetaView
  skippedEventCount: number
}

export interface SessionChange {
  head: SyncHead
  skippedEventCount: number
  /** Item ids whose content hash changed on this event. */
  itemIds: string[]
  /** The new state, or `null` when unchanged. */
  state: ProjectionState | null
  /** Notices created or whose status/ack requirement changed. */
  notices: ProjectionNotice[]
  /** The new meta, or `null` when unchanged. */
  meta: SessionMetaView | null
}

interface SyncState {
  throughSeq: number
  chain: string
  sequences: Map<number, string>
  itemHash: Map<string, string>
  itemSeq: Map<string, number | null>
  stateSig: string | null
  metaSig: string | null
  noticeSigs: Map<string, string>
}

export class SyncTracker {
  readonly #sessions = new Map<string, SyncState>()

  /**
   * Fold one projected event into the session's sync state and report what a
   * subscribed peer would need to be told.
   */
  observe(nativeId: string, event: OpenCodeEvent, view: SessionView): SessionChange {
    const state = this.#state(nativeId)
    this.#advanceChain(state, event)
    const itemIds = this.#diffItems(state, view.items, durableSeq(event))
    const meta = this.#diffMeta(state, view.meta)
    const stateChange = this.#diffState(state, view.state)
    const notices = this.#diffNotices(state, view.notices)
    return {
      head: { throughSeq: state.throughSeq, historyHash: state.chain },
      skippedEventCount: view.skippedEventCount,
      itemIds,
      state: stateChange,
      notices,
      meta,
    }
  }

  head(nativeId: string): SyncHead {
    const state = this.#sessions.get(nativeId)
    return state
      ? { throughSeq: state.throughSeq, historyHash: state.chain }
      : { throughSeq: 0, historyHash: GENESIS_HISTORY_HASH }
  }

  /**
   * Resolve the requested resume point. The Hub NEVER resumes on `fromSeq`
   * alone (rev3 ruling 3): a missing, mistyped, mismatched or out-of-window
   * `historyHash` degrades to a full snapshot.
   */
  select(nativeId: string, fromSeq: number | null, historyHash: string | null): SyncSelection {
    const state = this.#state(nativeId)
    const head = { throughSeq: state.throughSeq, historyHash: state.chain }
    if (fromSeq !== null && historyHash !== null && state.sequences.get(fromSeq) === historyHash) {
      const itemIds: string[] = []
      for (const [id, seq] of state.itemSeq) {
        // A `null` seq marks a change driven by a non-durable event; it can
        // never be proven to be inside the checkpointed prefix, so it replays.
        if (seq === null || seq > fromSeq) itemIds.push(id)
      }
      return { mode: 'incremental', fromSeq, itemIds, ...head }
    }
    return { mode: 'snapshot', fromSeq: null, itemIds: null, ...head }
  }

  forget(nativeId: string): void {
    this.#sessions.delete(nativeId)
  }

  #state(nativeId: string): SyncState {
    const existing = this.#sessions.get(nativeId)
    if (existing) return existing
    const created: SyncState = {
      throughSeq: 0,
      chain: GENESIS_HISTORY_HASH,
      sequences: new Map([[0, GENESIS_HISTORY_HASH]]),
      itemHash: new Map(),
      itemSeq: new Map(),
      stateSig: null,
      metaSig: null,
      noticeSigs: new Map(),
    }
    this.#sessions.set(nativeId, created)
    return created
  }

  #advanceChain(state: SyncState, event: OpenCodeEvent): void {
    const seq = durableSeq(event)
    if (seq === null || seq <= state.throughSeq) return
    const entry = sha256Hex(
      canonicalJson({
        aggregateID: event.durable?.aggregateID ?? null,
        seq,
        type: event.type ?? null,
      }),
    )
    state.chain = sha256Hex(`${state.chain}:${entry}`)
    state.throughSeq = seq
    state.sequences.set(seq, state.chain)
    while (state.sequences.size > MAX_RETAINED_SEQUENCES) {
      const oldest = state.sequences.keys().next().value
      if (oldest === undefined) break
      state.sequences.delete(oldest)
    }
  }

  #diffItems(
    state: SyncState,
    items: readonly TimelineItem[],
    seq: number | null,
  ): string[] {
    const changed: string[] = []
    for (const item of items) {
      if (state.itemHash.get(item.id) === item.contentHash) continue
      state.itemHash.set(item.id, item.contentHash)
      state.itemSeq.set(item.id, seq)
      changed.push(item.id)
    }
    return changed
  }

  #diffMeta(state: SyncState, meta: SessionMetaView): SessionMetaView | null {
    const signature = canonicalJson(meta)
    if (state.metaSig === signature) return null
    state.metaSig = signature
    return meta
  }

  #diffState(state: SyncState, value: ProjectionState | null): ProjectionState | null {
    if (value === null) return null
    const signature = canonicalJson({
      status: value.status,
      statusReason: value.statusReason,
      selections: value.selections,
      error: value.error,
      openInteractions: value.openInteractions,
    })
    if (state.stateSig === signature) return null
    state.stateSig = signature
    return value
  }

  #diffNotices(state: SyncState, notices: readonly ProjectionNotice[]): ProjectionNotice[] {
    const changed: ProjectionNotice[] = []
    const seen = new Set<string>()
    for (const notice of notices) {
      seen.add(notice.noticeId)
      const signature = `${notice.status}|${notice.responseRequired}`
      if (state.noticeSigs.get(notice.noticeId) === signature) continue
      state.noticeSigs.set(notice.noticeId, signature)
      changed.push(notice)
    }
    for (const id of state.noticeSigs.keys()) {
      if (!seen.has(id)) state.noticeSigs.delete(id)
    }
    return changed
  }
}

function durableSeq(event: OpenCodeEvent): number | null {
  const seq = event.durable?.seq
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : null
}
