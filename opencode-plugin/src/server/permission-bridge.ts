/**
 * Neutral permission observer + remote-approval broker (§6, security-critical).
 *
 * `ctx.permission.hook("evaluate", cb)` is used **only** to record requests. The
 * callback always returns `undefined`, which was measured to leave `effect`
 * untouched (the request is not auto-allowed). Rewriting the effect by returning
 * a string is assumption **A11** and is NOT proven, so no allow/deny decision is
 * ever taken through the hook.
 *
 * The same object owns the remote-answer broker. A remote answer is accepted
 * only when it is `allow_once` / `deny`, only once, only from the connection that
 * owns the session, and only for a non-high-risk action — the actual decision is
 * then applied through `ctx.permission.reply` (`once` / `reject`), never through
 * the hook. `always` is refused everywhere: the bridge never rewrites the host's
 * persistent permission rules.
 *
 * Note: `permission.hook` accepts any name without validation, so a successful
 * registration must never be read as "this hook name is supported".
 */

import { INTERACTION_RESULT_CODES } from '../shared/protocol.js'
import type { Logger } from '../shared/logger.js'
import {
  PERSISTENT_ACTION,
  REMOTE_ALLOW_ACTION,
  isRemoteActionId,
  requiresLocalConfirmation,
} from '../shared/permission-policy.js'
import type {
  Disposable,
  OpenCodeEvent,
  OpenCodePluginContext,
  PermissionEvaluatePayload,
  PermissionReply,
  PermissionReplyRequest,
} from './opencode-ctx.js'

export interface PermissionObservation {
  requestId: string | null
  sessionID: string | null
  action: string | null
  agent: string | null
  effect: string | null
  resources: unknown
  source: unknown
  observedAt: string
}

/** One pending/answered permission interaction, keyed by its notice id. */
export interface ApprovalRecord {
  noticeId: string
  requestId: string
  nativeSessionId: string
  action: string | null
  requiresLocalConfirmation: boolean
  status: 'open' | 'answered' | 'resolved'
  answeredBy: string | null
  answeredAt: string | null
  answeredActionId: string | null
  /**
   * §6⑤: the `initialize` `connectorId` of the connection that owned this
   * session when the notice was observed — the device identity (a reusing
   * `userId` is not a device and never widens this). `null` when no connection
   * had claimed the session yet; `answer` then fails closed (`unbound_notice`),
   * because an unbound notice offers no device to authorize against.
   */
  ownerConnectorId: string | null
}

export interface ApprovalAnswerInput {
  noticeId: string
  actionId: string
  userId: string
  /** The native session the answering connection resolved; binds notice↔device. */
  nativeSessionId: string
  /**
   * §6⑤: the `initialize` `connectorId` of the *answering* connection — this is
   * the device identity; `userId` is caller-supplied audit data and never an
   * authorization input. Compared against `ApprovalRecord.ownerConnectorId`; a
   * missing/`null` value can never match a real owner, and an unowned notice is
   * refused outright (`unbound_notice`).
   */
  connectorId?: string | null
}

export type ApprovalOutcome =
  | { ok: true; actionId: string; requestId: string; userId: string }
  | { ok: false; code: string; message: string }

export type AuditOutcome = 'allowed' | 'denied' | 'refused'

/**
 * §6 audit sink. Called *after* `permission.reply` settles (success) and for
 * every refused attempt (with the machine-readable `reason`); never carries a
 * token/code — the logger redacts secret-like keys on top of that.
 */
export type AuditSink = (entry: {
  noticeId: string
  userId: string
  actionId: string
  ts: string
  source: 'remote'
  outcome: AuditOutcome
  /** Present on refusals: the `INTERACTION_RESULT_CODES` value returned. */
  reason?: string
}) => void

export class PermissionObserver {
  readonly #logger: Logger
  readonly #audit: AuditSink | undefined
  #observations: PermissionObservation[] = []
  #approvals = new Map<string, ApprovalRecord>()
  #disposable: Disposable | null = null
  #attached = false
  #reply: PermissionReply | null = null
  #replyHost: unknown

  constructor(logger: Logger, audit?: AuditSink) {
    this.#logger = logger
    this.#audit = audit
  }

  /** Attach the evaluate hook. Fail-soft: absence disables remote approval only. */
  install(ctx: OpenCodePluginContext | undefined): boolean {
    const permission = ctx?.permission
    this.#reply = typeof permission?.reply === 'function' ? permission.reply : null
    this.#replyHost = permission
    if (this.#attached) return true
    const hook = permission?.hook
    if (typeof hook !== 'function') {
      this.#logger.warn('permission.hook unavailable; remote approval stays disabled')
      return false
    }
    try {
      const result = hook.call(permission, 'evaluate', (payload) => {
        try {
          this.#record(payload)
        } catch {
          // A recording failure must never disturb the host's permission chain.
        }
        return undefined
      })
      if (result !== null && typeof result === 'object') this.#disposable = result
      this.#attached = true
      return true
    } catch (error) {
      // §4.1 fail-soft: some hosts may reject the registration entirely.
      this.#logger.warn('permission hook registration failed', {
        error: error instanceof Error ? error.name : typeof error,
      })
      return false
    }
  }

  dispose(): void {
    try {
      this.#disposable?.dispose?.()
    } catch {
      // ignore
    }
    this.#disposable = null
    this.#attached = false
    this.#approvals.clear()
  }

  get observations(): readonly PermissionObservation[] {
    return this.#observations
  }

  get attached(): boolean {
    return this.#attached
  }

  /** True when the host exposed `permission.reply` (capability derivation). */
  get replyAvailable(): boolean {
    return typeof this.#reply === 'function'
  }

  /** Read-only view for tests and diagnostics. */
  pending(noticeId: string): ApprovalRecord | undefined {
    return this.#approvals.get(noticeId)
  }

  get pendingCount(): number {
    return this.#approvals.size
  }

  /**
   * Track a native permission event so a remote answer can be validated. Fed from
   * the Hub's `ingest()` — the same accepted-event path the projector uses.
   *
   * @param ownerConnectorId §6⑤: the `initialize` connectorId of the connection
   *   that owns this session (recorded once, first claim wins).
   */
  observe(event: OpenCodeEvent, ownerConnectorId: string | null = null): void {
    const type = typeof event.type === 'string' ? event.type : null
    const data = event.data
    if (type === null || data === undefined || data === null) return
    if (type === 'permission.asked') {
      const requestId = str(data['id'])
      const sessionID = str(data['sessionID'])
      if (requestId === null || sessionID === null) return
      // §6②: a re-delivered `asked` must never reopen an answered interaction —
      // create only when the key is absent, so the first-answer lock holds.
      const key = `notice_${requestId}`
      if (this.#approvals.has(key)) return
      const action = str(data['action'])
      this.#approvals.set(key, {
        noticeId: key,
        requestId,
        nativeSessionId: sessionID,
        action,
        requiresLocalConfirmation: requiresLocalConfirmation(action),
        status: 'open',
        answeredBy: null,
        answeredAt: null,
        answeredActionId: null,
        ownerConnectorId,
      })
      return
    }
    if (type === 'permission.replied') {
      const requestId = str(data['requestID'])
      if (requestId === null) return
      const record = this.#approvals.get(`notice_${requestId}`)
      // A native answer/取消 resolves the interaction even if we never saw the ask.
      if (record !== undefined) record.status = 'resolved'
    }
  }

  /**
   * §6⑤ (R4): a notice observed *before* any device had claimed its session was
   * recorded with `ownerConnectorId === null` and, since `observe` only ever
   * binds at ingest time, it could never be answered from the wire — a permanent
   * dead end for any notification that arrived during the cold-start window.
   *
   * When a connection later claims that session we bind those still-open notices
   * to it, exactly once. The trust model is unchanged: the *first* claim wins
   * (the Hub only calls this from `#claim`'s first-writer branch), an
   * already-owned notice is never rebound, and a native-answered/cancelled
   * record is skipped so a resolved interaction cannot be reopened.
   *
   * @returns how many notices were bound (for tests / diagnostics).
   */
  bindPending(nativeSessionId: string, connectorId: string): number {
    if (connectorId.length === 0) return 0
    let bound = 0
    for (const record of this.#approvals.values()) {
      if (record.nativeSessionId !== nativeSessionId) continue
      if (record.ownerConnectorId !== null) continue
      if (record.status !== 'open') continue
      record.ownerConnectorId = connectorId
      bound += 1
    }
    return bound
  }

  /**
   * Apply one remote answer. First answer wins (single-threaded check-then-mark
   * before the await), `always` is always refused, non-read-only actions stay
   * local-only, the notice must be bound to a claimed device and belong to the
   * answering connectorId (§6⑤ — an unclaimed notice fails closed with
   * `unbound_notice`), and nothing is retried or cascaded on failure. Every
   * attempt — accepted or refused — is audited.
   */
  async answer(input: ApprovalAnswerInput): Promise<ApprovalOutcome> {
    const record = this.#approvals.get(input.noticeId)
    if (record === undefined || record.nativeSessionId !== input.nativeSessionId) {
      return this.#refuse(input, INTERACTION_RESULT_CODES.unknownNotice, 'unknown or foreign permission notice')
    }
    // §6⑤ device binding: a notice is only answerable by the connector device
    // that claimed its session. `ownerConnectorId` is the handshake `connectorId`
    // (that, and only that, is the device identity; `userId` comes from the caller
    // and is audit-only, never an authorization input). `null` means the session
    // was never claimed when the ask was observed → fail closed: with no owner
    // there is nothing to compare against, so any peer at the same location could
    // otherwise answer on another device's behalf. A different device gets a code
    // distinct from `unknown_notice` so it can tell "not mine" from "no such
    // notice".
    if (record.ownerConnectorId === null) {
      return this.#refuse(
        input,
        INTERACTION_RESULT_CODES.unboundNotice,
        'this notice is not bound to a claimed device; remote answering is unavailable until the session is claimed',
      )
    }
    if ((input.connectorId ?? null) !== record.ownerConnectorId) {
      return this.#refuse(input, INTERACTION_RESULT_CODES.deviceMismatch, 'this notice belongs to another device')
    }
    // Never expose the persistent-rule answer to a remote peer.
    if (input.actionId === PERSISTENT_ACTION) {
      return this.#refuse(input, INTERACTION_RESULT_CODES.unsupportedAction, 'always is never accepted remotely')
    }
    if (!isRemoteActionId(input.actionId)) {
      return this.#refuse(input, INTERACTION_RESULT_CODES.unsupportedAction, `unsupported action: ${input.actionId}`)
    }
    if (record.requiresLocalConfirmation) {
      return this.#refuse(
        input,
        INTERACTION_RESULT_CODES.localConfirmationRequired,
        'this action requires a local confirmation',
      )
    }
    if (record.status !== 'open') {
      return this.#refuse(input, INTERACTION_RESULT_CODES.alreadyAnswered, 'this interaction was already answered')
    }

    const previous: ApprovalRecord = { ...record }
    const ts = new Date().toISOString()
    record.status = 'answered'
    record.answeredBy = input.userId
    record.answeredAt = ts
    record.answeredActionId = input.actionId

    const reply = this.#reply
    if (typeof reply !== 'function') {
      Object.assign(record, previous)
      return this.#refuse(input, INTERACTION_RESULT_CODES.replyUnavailable, 'permission.reply is unavailable on this host')
    }
    try {
      const request: PermissionReplyRequest = {
        path: { requestID: record.requestId },
        body: { reply: input.actionId === 'allow_once' ? 'once' : 'reject' },
      }
      await reply.call(this.#replyHost, request)
    } catch (error) {
      // The answer never landed: release the lock so a retry is possible.
      Object.assign(record, previous)
      this.#logger.warn('permission.reply failed', {
        error: error instanceof Error ? error.name : typeof error,
      })
      return this.#refuse(input, INTERACTION_RESULT_CODES.replyUnavailable, 'permission.reply failed')
    }
    // §6 audit: only a landed answer — never before `permission.reply` settles.
    this.#audit?.({
      noticeId: input.noticeId,
      userId: input.userId,
      actionId: input.actionId,
      ts,
      source: 'remote',
      outcome: input.actionId === REMOTE_ALLOW_ACTION ? 'allowed' : 'denied',
    })
    return { ok: true, actionId: input.actionId, requestId: record.requestId, userId: input.userId }
  }

  /** Audit a refusal (with its reason) and build the outcome in one place. */
  #refuse(input: ApprovalAnswerInput, code: string, message: string): ApprovalOutcome {
    this.#audit?.({
      noticeId: input.noticeId,
      userId: input.userId,
      actionId: input.actionId,
      ts: new Date().toISOString(),
      source: 'remote',
      outcome: 'refused',
      reason: code,
    })
    return refuse(code, message)
  }

  #record(payload: PermissionEvaluatePayload | undefined): void {
    if (payload === null || typeof payload !== 'object') return
    this.#observations.push({
      requestId: null,
      sessionID: str(payload.sessionID),
      action: str(payload.action),
      agent: str(payload.agent),
      effect: str(payload.effect),
      resources: payload.resources,
      source: payload.source,
      observedAt: new Date().toISOString(),
    })
    // Token/code values never reach the log: the logger redacts secret-like keys.
    this.#logger.debug('permission evaluate observed (neutral, no effect change)', {
      action: payload.action,
      effect: payload.effect,
    })
  }
}

function refuse(code: string, message: string): ApprovalOutcome {
  return { ok: false, code, message }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
