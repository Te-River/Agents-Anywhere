/**
 * OpenCode event → canonical timeline projection.
 *
 * Source of truth is the runtime event list measured in the P0 spike, **not**
 * the published SDK types: six emitted names (`session.step.started`,
 * `session.step.ended`, `session.tool.called`, `session.tool.success`,
 * `session.reasoning.delta`, `shell.exited`) have zero hits in the SDK types.
 * Parsing is therefore defensive by construction — an unknown type or a missing
 * field is counted and skipped, never thrown.
 */

import {
  contentHash,
  timelineItemId,
  type JsonObject,
  type RuntimeStatus,
  type TimelineItem,
  type TimelineRole,
  type TimelineStatus,
  type TimelineType,
} from '../shared/protocol.js'
import { remoteActions, requiresLocalConfirmation } from '../shared/permission-policy.js'
import type { OpenCodeEvent } from './opencode-ctx.js'

export type NoticeSeverity = 'info' | 'success' | 'warning' | 'error'

export interface ProjectionNotice {
  noticeId: string
  sessionId: string
  type: 'notification' | 'interaction'
  title: string
  message: string | null
  severity: NoticeSeverity
  status: string
  interactionType: string | null
  /**
   * AA `NoticeBlocking` contract: `{scope:'session', targetId}` — the Hub
   * rewrites `targetId` to the platform session id on the wire. The permission
   * specifics live in `context`, not here (AA rejects any other shape).
   */
  blocking: JsonObject | null
  responseRequired: boolean
  /** §6: the only remote-actionable answers (`allow_once` / `deny`); never `always`. */
  actions: JsonObject[]
  source: JsonObject
  context: JsonObject
}

export interface ProjectionSnapshot {
  items: TimelineItem[]
  /** Checkpoint cursor: highest `durable.seq` seen (null when none yet). */
  watermark: number | null
  complete: boolean
  totalItems: number
  skippedEvents: number
}

export interface ProjectionState {
  status: RuntimeStatus
  statusReason: string | null
  selections: JsonObject
  error: JsonObject | null
  openInteractions: number
}

export interface ProjectionOutcome {
  changed: boolean
  /** True when the event was understood but unusable (or unknown). */
  skipped: boolean
  reason: string
}

interface SessionProjection {
  nativeId: string
  orderSeq: number
  currentTurnId: string | null
  turnStatus: 'idle' | 'running' | 'error' | 'cancelled'
  items: TimelineItem[]
  byKey: Map<string, number>
  lastDurableSeq: number | null
  openInteractions: Map<string, number>
  /**
   * §6②: `noticeId` → index in `notices`, the by-id handle the projector needs
   * to upsert a re-delivered `permission.asked` and to resolve a reply. It
   * outlives `openInteractions` (which drops the entry once answered) so a
   * replayed `asked` can never look like a brand-new interaction.
   */
  noticeIndex: Map<string, number>
  notices: ProjectionNotice[]
  selections: JsonObject
  bookkeeping: JsonObject
  lastError: JsonObject | null
  lastStatusReason: string | null
  skipped: number
  unknownTypes: Map<string, number>
}

const SKIPPED: ProjectionOutcome = { changed: false, skipped: true, reason: 'skipped' }

export class Projector {
  readonly #sessions = new Map<string, SessionProjection>()

  /** Apply one event. Never throws; returns what happened. */
  apply(nativeId: string, event: OpenCodeEvent): ProjectionOutcome {
    try {
      const projection = this.#session(nativeId)
      this.#advanceCheckpoint(projection, event)
      const type = typeof event.type === 'string' ? event.type : null
      if (type === null) {
        projection.skipped += 1
        return SKIPPED
      }
      const outcome = this.#route(projection, type, event)
      if (outcome.skipped) projection.skipped += 1
      return outcome
    } catch {
      // Defensive: a malformed event must never break the plugin or the host.
      const projection = this.#sessions.get(nativeId)
      if (projection) projection.skipped += 1
      return { changed: false, skipped: true, reason: 'error' }
    }
  }

  #advanceCheckpoint(projection: SessionProjection, event: OpenCodeEvent): void {
    // Only durable (persistable session) events carry a sequence number.
    const seq = event.durable?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      projection.lastDurableSeq =
        projection.lastDurableSeq === null ? seq : Math.max(projection.lastDurableSeq, seq)
    }
  }

  #route(
    projection: SessionProjection,
    type: string,
    event: OpenCodeEvent,
  ): ProjectionOutcome {
    const data = asObject(event.data)
    switch (type) {
      case 'session.next.prompted':
      case 'session.inbox.enqueued':
        return this.#userMessage(projection, event, data)
      case 'session.execution.started':
        return this.#turnMarker(projection, event, 'start', 'done')
      case 'session.text.started':
      case 'session.text.delta':
      case 'session.step.streamed':
        return this.#assistantText(projection, event, data, false)
      case 'session.reasoning.started':
      case 'session.reasoning.delta':
        return this.#assistantText(projection, event, data, true)
      case 'session.step.started':
        return this.#stepStarted(projection, data)
      case 'session.step.ended':
        return this.#stepEnded(projection, event, data)
      case 'session.step.failed':
        return this.#turnFault(projection, event, 'failed', data)
      case 'session.execution.interrupted':
        return this.#turnFault(projection, event, 'cancelled', data)
      case 'session.error':
        return this.#turnFault(projection, event, 'failed', data)
      case 'session.idle':
        return this.#idle(projection, event)
      case 'session.tool.input.started':
        return this.#toolItem(projection, event, data, 'pending', { kind: 'tool_call', title: str(data, 'name') })
      case 'session.tool.input.ended':
        return this.#toolItem(projection, event, data, 'pending', { input: json(data['text']) })
      case 'session.tool.called':
        return this.#toolItem(projection, event, data, 'running', {
          input: json(data['input']),
          executed: data['executed'] === true,
        })
      case 'session.tool.progress':
        return this.#toolItem(projection, event, data, 'running', { progress: json(data['metadata']) })
      case 'session.tool.success':
        return this.#toolItem(projection, event, data, 'done', {
          output: json(data['content']),
          executed: data['executed'] === true,
        })
      case 'session.tool.failed':
        return this.#toolItem(projection, event, data, 'failed', {
          error: json(data['error']),
          executed: data['executed'] === true,
        })
      case 'permission.asked':
        return this.#permissionAsked(projection, event, data)
      case 'permission.replied':
        return this.#permissionReplied(projection, event, data)
      case 'shell.created':
        return this.#shellItem(projection, event, data, 'running', null)
      case 'shell.exited':
        return this.#shellItem(projection, event, data, exitStatus(data), data['exit'])
      case 'shell.deleted':
        return this.#shellItem(projection, event, data, 'done', null)
      case 'session.created':
      case 'session.deleted':
      case 'session.usage.updated':
      case 'session.status':
      case 'session.instructions.updated':
      case 'session.inbox.delivered':
        return this.#bookkeeping(projection, type, data)
      default: {
        const count = projection.unknownTypes.get(type) ?? 0
        projection.unknownTypes.set(type, count + 1)
        return { changed: false, skipped: true, reason: `unknown:${type}` }
      }
    }
  }

  #bookkeeping(
    projection: SessionProjection,
    type: string,
    data: JsonObject,
  ): ProjectionOutcome {
    if (type === 'session.usage.updated') {
      projection.bookkeeping = { ...projection.bookkeeping, tokens: json(data['tokens']) ?? null, cost: json(data['cost']) ?? null }
    } else if (type === 'session.status') {
      const status = str(data, 'status')
      if (status !== null) projection.lastStatusReason = status
    }
    // Domain bookkeeping does not enter the timeline.
    return { changed: false, skipped: false, reason: `bookkeeping:${type}` }
  }

  #userMessage(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
  ): ProjectionOutcome {
    const text = firstText(data)
    const key = `user:${event.id ?? `${event.created ?? ''}:${projection.orderSeq}`}`
    const { item, created } = this.#upsert(projection, key, () => ({
      sessionId: projection.nativeId,
      type: 'message',
      status: 'done',
      role: 'user',
      turnId: projection.currentTurnId,
      content: { kind: 'markdown', text, format: 'markdown' },
      source: { runtime: 'opencode', event: event.type ?? '' },
      metadata: {},
    }))
    if (!created && text.length > 0) {
      item.content['text'] = text
      touch(item)
    }
    projection.turnStatus = 'running'
    return { changed: created || text.length > 0, skipped: false, reason: 'user-message' }
  }

  #turnMarker(
    projection: SessionProjection,
    event: OpenCodeEvent,
    phase: 'start' | 'end',
    status: TimelineStatus,
  ): ProjectionOutcome {
    const key = `turn:${phase}:${event.id ?? event.created ?? projection.orderSeq}`
    const { item } = this.#upsert(projection, key, () => ({
      sessionId: projection.nativeId,
      type: phase === 'start' ? 'turn.start' : 'turn.end',
      status,
      role: phase === 'start' ? 'user' : null,
      turnId: null,
      content: { kind: phase === 'start' ? 'turn_start' : 'turn_end' },
      source: { runtime: 'opencode', event: event.type ?? '' },
      metadata: {},
    }))
    if (phase === 'start') projection.currentTurnId = item.id
    return { changed: true, skipped: false, reason: `turn-${phase}` }
  }

  #assistantText(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
    reasoning: boolean,
  ): ProjectionOutcome {
    const messageId = str(data, 'assistantMessageID')
    if (messageId === null) return SKIPPED
    const ordinal = numberOr(data['ordinal'], 0)
    const key = `${reasoning ? 'reasoning' : 'text'}:${messageId}:${ordinal}`
    const delta = str(data, 'delta') ?? ''
    const { item, created } = this.#upsert(projection, key, () => ({
      sessionId: projection.nativeId,
      type: 'message',
      status: 'inProgress',
      role: 'assistant',
      turnId: projection.currentTurnId,
      content: { kind: 'markdown', text: '', format: 'markdown' },
      source: { runtime: 'opencode', event: event.type ?? '', itemId: messageId },
      metadata: reasoning ? { reasoning: true, ordinal } : { ordinal },
    }))
    if (reasoning) item.metadata['reasoning'] = true
    if (delta.length > 0) {
      item.content['text'] = `${String(item.content['text'] ?? '')}${delta}`
    }
    if (created) refresh(item)
    else touch(item)
    projection.turnStatus = 'running'
    return { changed: created || delta.length > 0, skipped: false, reason: reasoning ? 'reasoning' : 'text' }
  }

  #stepStarted(projection: SessionProjection, data: JsonObject): ProjectionOutcome {
    const model = str(data, 'model')
    const agent = str(data, 'agent')
    if (model !== null) projection.selections = { ...projection.selections, model }
    if (agent !== null) projection.selections = { ...projection.selections, agent }
    projection.turnStatus = 'running'
    projection.lastError = null
    return { changed: true, skipped: false, reason: 'step-started' }
  }

  #stepEnded(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
  ): ProjectionOutcome {
    const messageId = str(data, 'assistantMessageID')
    for (const item of projection.items) {
      if (item.status !== 'inProgress') continue
      if (messageId !== null && item.source['itemId'] !== messageId) continue
      item.status = 'done'
      touch(item)
    }
    this.#turnMarker(projection, event, 'end', 'done')
    projection.bookkeeping = { ...projection.bookkeeping, cost: json(data['cost']) ?? null, tokens: json(data['tokens']) ?? null }
    projection.turnStatus = 'idle'
    return { changed: true, skipped: false, reason: 'step-ended' }
  }

  #turnFault(
    projection: SessionProjection,
    event: OpenCodeEvent,
    status: 'failed' | 'cancelled',
    data: JsonObject,
  ): ProjectionOutcome {
    for (const item of projection.items) {
      if (item.status === 'inProgress' || item.status === 'pending' || item.status === 'running') {
        item.status = status
        touch(item)
      }
    }
    const marker = this.#turnMarker(projection, event, 'end', status)
    const last = projection.items[projection.items.length - 1]
    if (last && last.type === 'turn.end' && marker.reason === 'turn-end') {
      const error = json(data['error']) ?? str(data, 'reason')
      if (error !== undefined) last.metadata['error'] = error
      touch(last)
    }
    projection.lastError =
      json(data['error']) !== undefined ? asObject(json(data['error'])) : str(data, 'reason') !== null ? { message: str(data, 'reason') } : null
    projection.turnStatus = status === 'cancelled' ? 'cancelled' : 'error'
    return { changed: true, skipped: false, reason: `turn-${status}` }
  }

  #idle(projection: SessionProjection, event: OpenCodeEvent): ProjectionOutcome {
    for (const item of projection.items) {
      if (item.status === 'inProgress') {
        item.status = 'done'
        touch(item)
      }
    }
    this.#turnMarker(projection, event, 'end', 'done')
    projection.turnStatus = 'idle'
    return { changed: true, skipped: false, reason: 'idle' }
  }

  #toolItem(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
    status: TimelineStatus,
    contentPatch: JsonObject,
  ): ProjectionOutcome {
    const id = str(data, 'id')
    if (id === null) return SKIPPED
    const key = `tool:${id}`
    const messageId = str(data, 'assistantMessageID')
    const { item, created } = this.#upsert(projection, key, () => ({
      sessionId: projection.nativeId,
      type: 'tool',
      status,
      role: 'tool',
      turnId: projection.currentTurnId,
      content: { kind: 'tool_call' },
      source: { runtime: 'opencode', event: event.type ?? '', itemId: id },
      metadata: messageId === null ? { nativeToolId: id } : { nativeToolId: id, messageId },
    }))
    for (const [patchKey, patchValue] of Object.entries(contentPatch)) {
      if (patchValue === undefined) continue
      if (patchKey === 'executed') {
        item.metadata['executed'] = patchValue
        continue
      }
      item.content[patchKey] = patchValue
    }
    item.status = created ? status : mergeStatus(item.status, status)
    if (created) refresh(item)
    else touch(item)
    projection.turnStatus = 'running'
    return { changed: true, skipped: false, reason: `tool:${event.type ?? ''}` }
  }

  #shellItem(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
    status: TimelineStatus,
    exitCode: unknown,
  ): ProjectionOutcome {
    const id = str(data, 'id')
    if (id === null) return SKIPPED
    const key = `shell:${id}`
    const info = json(data['info'])
    const command = typeof info === 'string' ? info : typeof info === 'object' && info !== null ? str(info as JsonObject, 'command') : null
    const { item, created } = this.#upsert(projection, key, () => ({
      sessionId: projection.nativeId,
      type: 'tool',
      status,
      role: 'tool',
      turnId: projection.currentTurnId,
      content: {
        kind: 'command',
        ...(command !== null ? { command } : {}),
      },
      source: { runtime: 'opencode', event: event.type ?? '', itemId: id },
      metadata: { nativeToolId: id, shell: true },
    }))
    if (typeof exitCode === 'number') item.content['exitCode'] = exitCode
    item.status = created ? status : mergeStatus(item.status, status)
    if (created) refresh(item)
    else touch(item)
    return { changed: true, skipped: false, reason: `shell:${event.type ?? ''}` }
  }

  #permissionAsked(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
  ): ProjectionOutcome {
    const id = str(data, 'id')
    if (id === null) return SKIPPED
    const action = str(data, 'action')
    const noticeId = `notice_${id}`
    // §6: high-risk actions stay local-only; the remote surface gets no buttons.
    const localOnly = requiresLocalConfirmation(action)
    const notice: ProjectionNotice = {
      noticeId,
      sessionId: projection.nativeId,
      type: 'interaction',
      title: action ?? 'Permission requested',
      message: describeResources(data['resources']),
      severity: 'warning',
      status: 'open',
      // §6 / AA contract: the interaction type is `approval` and `blocking` is
      // the AA `NoticeBlocking` shape (`scope` + `targetId`). The permission
      // specifics (`permission`/`requestId`/`requiresLocalConfirmation`) ride in
      // `context` — AA's `NoticeIn` rejects any other `blocking` shape.
      interactionType: 'approval',
      blocking: { scope: 'session', targetId: projection.nativeId },
      // The interaction is open either way; a local-only one simply has no
      // remote-actionable answer.
      responseRequired: true,
      actions: remoteActions(action),
      source: { runtime: 'opencode', event: event.type ?? '', itemId: id },
      context: {
        permission: action,
        requestId: id,
        requiresLocalConfirmation: localOnly,
        ...(data['source'] !== undefined ? { source: json(data['source']) } : {}),
        ...(data['save'] !== undefined ? { save: json(data['save']) } : {}),
      },
    }
    // §6②: upsert by `noticeId`, never append. A re-delivered `permission.asked`
    // (reconnect / event replay) must not flip an answered interaction back to
    // `open` — that would emit a second `notice.upsert` and re-arm a settled ask.
    const existing = projection.noticeIndex.get(noticeId)
    if (existing !== undefined) {
      const current = projection.notices[existing]
      if (current === undefined || current.status !== 'open') {
        return { changed: false, skipped: false, reason: 'permission-asked-redelivered' }
      }
      // Still open: replace in place (refresh the mutable fields), keep the
      // single open entry and its original position.
      projection.notices[existing] = notice
      projection.openInteractions.set(id, existing)
      return { changed: true, skipped: false, reason: 'permission-asked-duplicate' }
    }
    projection.noticeIndex.set(noticeId, projection.notices.length)
    projection.openInteractions.set(id, projection.notices.length)
    projection.notices.push(notice)
    return { changed: true, skipped: false, reason: 'permission-asked' }
  }

  #permissionReplied(
    projection: SessionProjection,
    event: OpenCodeEvent,
    data: JsonObject,
  ): ProjectionOutcome {
    const requestId = str(data, 'requestID')
    if (requestId === null) return SKIPPED
    projection.openInteractions.delete(requestId)
    // §6②: resolve by `noticeId`, never by "the last notice pushed" — a replayed
    // `asked` must not redirect a reply onto another interaction's notice.
    const index = projection.noticeIndex.get(`notice_${requestId}`)
    const notice = index === undefined ? undefined : projection.notices[index]
    if (notice === undefined) return { changed: true, skipped: false, reason: 'permission-replied-unknown' }
    if (notice.status !== 'resolved') {
      notice.status = 'resolved'
      notice.responseRequired = false
    }
    notice.context = { ...notice.context, reply: json(data['reply']) ?? null, event: event.type ?? '' }
    return { changed: true, skipped: false, reason: 'permission-replied' }
  }

  snapshot(nativeId: string, sessionId: string): ProjectionSnapshot | null {
    const projection = this.#sessions.get(nativeId)
    if (!projection) return null
    const items = projection.items.map((item) => ({ ...item, sessionId }))
    return {
      items,
      watermark: projection.lastDurableSeq,
      complete: true,
      totalItems: items.length,
      skippedEvents: projection.skipped,
    }
  }

  /**
   * Raw projected items (native session keying). The sync surface re-keys them
   * per connection itself, so it must not pay for `snapshot()`'s copy/re-key.
   */
  timeline(nativeId: string): readonly TimelineItem[] {
    return this.#sessions.get(nativeId)?.items ?? []
  }

  /** Native events this session could not project (Hub-owned skip counter). */
  skippedEvents(nativeId: string): number {
    return this.#sessions.get(nativeId)?.skipped ?? 0
  }

  state(nativeId: string): ProjectionState | null {
    const projection = this.#sessions.get(nativeId)
    if (!projection) return null
    const status: RuntimeStatus =
      projection.openInteractions.size > 0
        ? 'waiting_approval'
        : projection.turnStatus === 'running'
          ? 'running'
          : projection.turnStatus === 'error'
            ? 'error'
            : 'idle'
    return {
      status,
      statusReason:
        projection.turnStatus === 'cancelled'
          ? 'interrupted'
          : projection.lastStatusReason,
      selections: { ...projection.selections, ...projection.bookkeeping },
      error: projection.lastError,
      openInteractions: projection.openInteractions.size,
    }
  }

  notices(nativeId: string, sessionId: string): ProjectionNotice[] {
    const projection = this.#sessions.get(nativeId)
    if (!projection) return []
    return projection.notices.map((notice) => ({ ...notice, sessionId }))
  }

  counters(): { sessions: number; skippedEvents: number; unknownTypes: Record<string, number> } {
    const unknownTypes: Record<string, number> = {}
    let skippedEvents = 0
    for (const projection of this.#sessions.values()) {
      skippedEvents += projection.skipped
      for (const [type, count] of projection.unknownTypes) {
        unknownTypes[type] = (unknownTypes[type] ?? 0) + count
      }
    }
    return { sessions: this.#sessions.size, skippedEvents, unknownTypes }
  }

  forget(nativeId: string): void {
    this.#sessions.delete(nativeId)
  }

  #session(nativeId: string): SessionProjection {
    const existing = this.#sessions.get(nativeId)
    if (existing) return existing
    const created: SessionProjection = {
      nativeId,
      orderSeq: 0,
      currentTurnId: null,
      turnStatus: 'idle',
      items: [],
      byKey: new Map(),
      lastDurableSeq: null,
      openInteractions: new Map(),
      noticeIndex: new Map(),
      notices: [],
      selections: {},
      lastError: null,
      lastStatusReason: null,
      bookkeeping: {},
      skipped: 0,
      unknownTypes: new Map(),
    }
    this.#sessions.set(nativeId, created)
    return created
  }

  #upsert(
    projection: SessionProjection,
    key: string,
    init: () => {
      sessionId: string
      type: TimelineType
      status: TimelineStatus
      role: TimelineRole | null
      turnId: string | null
      content: JsonObject
      source: JsonObject
      metadata: JsonObject
    },
  ): { item: TimelineItem; created: boolean } {
    const index = projection.byKey.get(key)
    if (index !== undefined) {
      const existing = projection.items[index]
      if (existing) return { item: existing, created: false }
    }
    const seed = init()
    const item: TimelineItem = {
      ...seed,
      id: timelineItemId(`${projection.nativeId}:${key}`),
      orderSeq: ++projection.orderSeq,
      revision: 1,
      contentHash: '',
    }
    refresh(item)
    projection.items.push(item)
    projection.byKey.set(key, projection.items.length - 1)
    return { item, created: true }
  }
}

function refresh(item: TimelineItem): void {
  item.contentHash = contentHash(item.type, item.status, item.role, item.content)
}

/** An in-place update: bump the revision, then re-address the content. */
function touch(item: TimelineItem): void {
  item.revision += 1
  refresh(item)
}

const STATUS_RANK: Partial<Record<TimelineStatus, number>> = {
  pending: 0,
  inProgress: 1,
  running: 2,
  waiting_approval: 3,
  done: 4,
  failed: 4,
  cancelled: 4,
  interrupted: 4,
  hidden: 5,
}

/** Never regress a terminal status back to a transient one. */
function mergeStatus(current: TimelineStatus, next: TimelineStatus): TimelineStatus {
  const currentRank = STATUS_RANK[current] ?? 0
  const nextRank = STATUS_RANK[next] ?? 0
  return nextRank >= currentRank ? next : current
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function str(source: JsonObject, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** JSON-safe projection of an arbitrary event field (undefined stays undefined). */
function json(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return String(value)
  }
}

function firstText(data: JsonObject): string {
  for (const key of ['text', 'content', 'message']) {
    const value = data[key]
    if (typeof value === 'string') return value
  }
  const item = json(data['item'])
  if (typeof item === 'string') return item
  if (item !== null && typeof item === 'object') {
    const nested = firstText(item as JsonObject)
    if (nested.length > 0) return nested
  }
  return ''
}

function describeResources(resources: unknown): string | null {
  const value = json(resources)
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string').join(', ') || null
  return null
}

function exitStatus(data: JsonObject): TimelineStatus {
  const exit = data['exit']
  if (typeof exit === 'number') return exit === 0 ? 'done' : 'failed'
  const status = data['status']
  return typeof status === 'string' && status !== 'exited' ? 'failed' : 'done'
}
