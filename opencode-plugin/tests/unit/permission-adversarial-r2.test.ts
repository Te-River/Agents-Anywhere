/**
 * Round-2 independent adversarial probes for the P3 §6② fix.
 *
 * Scope: ONLY the projector's notice upsert/resolve-by-id (`permission-asked-*`
 * / `permission-replied*`) and the observer's owner binding. Each probe tries an
 * event ORDER the implementer's happy path does not use, to see whether an
 * answered interaction can be flipped back to `open`, duplicated, or redirected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Projector } from '../../src/server/projector.js'
import { PermissionObserver } from '../../src/server/permission-bridge.js'
import type { ApprovalAnswerInput } from '../../src/server/permission-bridge.js'
import { createLogger } from '../../src/shared/logger.js'
import type { OpenCodeEvent, PermissionReplyRequest } from '../../src/server/opencode-ctx.js'

const SILENT = createLogger('r2', () => undefined)
const NATIVE = 'ses_r2'
const PLATFORM = 'sess_r2'
const DEVICE = 'device-a'

// ------------------------------------------------------------------ projector

function ev(type: string, data: Record<string, unknown>): OpenCodeEvent {
  return {
    id: `${type}:${Math.random().toString(36).slice(2, 9)}`,
    created: '2026-01-01T00:00:00.000Z',
    type,
    location: { directory: 'D:/proj/r2' },
    data: { sessionID: NATIVE, ...data },
  } as OpenCodeEvent
}

const ask = (p: Projector, id: string, action = 'webfetch') =>
  p.apply(NATIVE, ev('permission.asked', { id, action, resources: [] }))
const reply = (p: Projector, requestId: string, value = 'once') =>
  p.apply(NATIVE, ev('permission.replied', { requestID: requestId, reply: value }))
const notices = (p: Projector) => p.notices(NATIVE, PLATFORM)
const idList = (p: Projector) => notices(p).map((n) => n.noticeId)
const statusList = (p: Projector) => notices(p).map((n) => n.status)
const statusOf = (p: Projector, id: string) => notices(p).find((n) => n.noticeId === id)?.status

test('R2/P1 replay of an answered ask must not redirect the reply onto another open notice', () => {
  const p = new Projector()
  ask(p, 'A')
  assert.equal(reply(p, 'A').reason, 'permission-replied')
  ask(p, 'B')
  assert.equal(p.state(NATIVE)?.openInteractions, 1, 'only B may be open')

  // Replayed reply for the ALREADY-resolved A, while B is the sole open notice.
  const outcome = reply(p, 'A')
  assert.equal(outcome.changed, true)
  assert.equal(statusOf(p, 'notice_A'), 'resolved')
  assert.equal(statusOf(p, 'notice_B'), 'open', 'a replayed reply for A must not resolve B')
  assert.equal(p.state(NATIVE)?.openInteractions, 1)
  assert.equal(p.state(NATIVE)?.status, 'waiting_approval')
})

test('R2/P2 open→open replay replaces in place: no second notice, order and position kept', () => {
  const p = new Projector()
  ask(p, 'A')
  ask(p, 'B')
  const dup = ask(p, 'A') // re-delivery while A is still open
  assert.equal(dup.reason, 'permission-asked-duplicate')
  assert.deepEqual(idList(p), ['notice_A', 'notice_B'], 'position must be preserved, nothing appended')
  assert.deepEqual(statusList(p), ['open', 'open'])
  assert.equal(p.state(NATIVE)?.openInteractions, 2)

  // and the re-delivered open A is still answerable natively
  assert.equal(reply(p, 'A').reason, 'permission-replied')
  assert.deepEqual(statusList(p), ['resolved', 'open'])
  assert.equal(p.state(NATIVE)?.openInteractions, 1)
})

test('R2/P3 two reply replays after an answer never reopen nor duplicate the settled ask', () => {
  const p = new Projector()
  ask(p, 'A')
  reply(p, 'A')
  const second = reply(p, 'A')
  assert.equal(second.reason, 'permission-replied')
  const replay = ask(p, 'A') // re-delivered asked AFTER the answer
  assert.equal(replay.reason, 'permission-asked-redelivered')
  assert.equal(replay.changed, false, 'an already-answered replay must not report a change')
  assert.deepEqual(statusList(p), ['resolved'])
  assert.equal(notices(p)[0]?.responseRequired, false)
  assert.equal(p.state(NATIVE)?.openInteractions, 0)
  assert.equal(p.state(NATIVE)?.status, 'idle')
})

test('R2/P4 interleaved ids: resolving one leaves the other open, in both arrival orders', () => {
  const p = new Projector()
  ask(p, 'A')
  ask(p, 'B')
  reply(p, 'B')
  assert.deepEqual(statusList(p), ['open', 'resolved'])
  reply(p, 'A')
  assert.deepEqual(statusList(p), ['resolved', 'resolved'])
  assert.equal(p.state(NATIVE)?.openInteractions, 0)

  // reverse arrival: B first, then A
  const q = new Projector()
  ask(q, 'B')
  ask(q, 'A')
  reply(q, 'A')
  assert.deepEqual(statusList(q), ['open', 'resolved'])
  reply(q, 'B')
  assert.equal(q.state(NATIVE)?.openInteractions, 0)
})

test('R2/P5 state does not re-enter waiting_approval on a post-answer ask replay', () => {
  const p = new Projector()
  ask(p, 'A')
  assert.equal(p.state(NATIVE)?.status, 'waiting_approval')
  reply(p, 'A')
  assert.equal(p.state(NATIVE)?.status, 'idle')
  ask(p, 'A') // replay of the settled ask
  assert.equal(p.state(NATIVE)?.status, 'idle', 'a settled ask must not re-arm waiting_approval')
  assert.equal(p.state(NATIVE)?.openInteractions, 0)
})

test('R2/P6 BOUNDARY: a reply that arrives before its ask leaves the later ask open', () => {
  // Not reachable from the runtime's seq-ordered stream (replied always follows
  // asked), but the projector keeps no "already replied" tombstone, so an
  // out-of-order/replayed-tail arrival shows a stale open interaction.
  const p = new Projector()
  const orphan = reply(p, 'A')
  assert.equal(orphan.reason, 'permission-replied-unknown')
  assert.deepEqual(notices(p), [], 'an unknown reply must not fabricate a notice')
  ask(p, 'A')
  assert.equal(statusOf(p, 'notice_A'), 'open', 'observed boundary: no tombstone → stale open')
})

// ------------------------------------------------------------------- observer

interface Harness {
  observer: PermissionObserver
  replies: PermissionReplyRequest[]
}

function harness(): Harness {
  const replies: PermissionReplyRequest[] = []
  const observer = new PermissionObserver(SILENT)
  observer.install({
    permission: {
      hook: () => ({ dispose: () => undefined }),
      reply: async (request: PermissionReplyRequest) => {
        replies.push(request)
      },
    },
  })
  return { observer, replies }
}

const obsAsk = (id: string, sessionID = NATIVE): OpenCodeEvent =>
  ev('permission.asked', { id, action: 'webfetch', sessionID, resources: [] })

function input(noticeId: string, actionId: string, extra: Record<string, unknown> = {}): ApprovalAnswerInput {
  return { noticeId, actionId, userId: 'u1', nativeSessionId: NATIVE, connectorId: DEVICE, ...extra } as ApprovalAnswerInput
}

test('R2/P7 an ownerless notice is bound only by a claim (R4), never by a re-delivered ask', async () => {
  const h = harness()
  h.observer.observe(obsAsk('late'), null) // observed before any claim
  assert.equal(h.observer.pending('notice_late')?.ownerConnectorId, null)
  // a re-delivered `asked` never re-owns an existing record (ingest-time binding only)
  h.observer.observe(obsAsk('late'), DEVICE)
  assert.equal(h.observer.pending('notice_late')?.ownerConnectorId, null, 'a re-delivered ask does not backfill')
  // R4: only the Hub's claim path binds the still-open notice, exactly once
  assert.equal(h.observer.bindPending(NATIVE, DEVICE), 1, 'the claim binds the open notice')
  assert.equal(h.observer.pending('notice_late')?.ownerConnectorId, DEVICE)
  assert.equal(h.observer.bindPending(NATIVE, DEVICE), 0, 'the binding is one-time')
  const outcome = await h.observer.answer(input('notice_late', 'allow_once'))
  assert.equal(outcome.ok, true)
  assert.equal(h.replies.length, 1)
})

test('R2/P8 unbound_notice / device_mismatch / unknown_notice stay distinct', async () => {
  const h = harness()
  h.observer.observe(obsAsk('u'), null)
  h.observer.observe(obsAsk('m'), DEVICE)
  const unbound = await h.observer.answer(input('notice_u', 'allow_once', { connectorId: 'any' }))
  const mismatch = await h.observer.answer(input('notice_m', 'allow_once', { connectorId: 'device-b' }))
  const unknown = await h.observer.answer(input('notice_nope', 'allow_once'))
  assert.equal(unbound.ok === false && unbound.code, 'unbound_notice')
  assert.equal(mismatch.ok === false && mismatch.code, 'device_mismatch')
  assert.equal(unknown.ok === false && unknown.code, 'unknown_notice')
  assert.deepEqual(h.replies, [])
})

test('R2/P9 a same-device re-delivered ask stays answerable and never reopens', async () => {
  const h = harness()
  h.observer.observe(obsAsk('dup'), DEVICE)
  h.observer.observe(obsAsk('dup'), DEVICE)
  assert.equal(h.observer.pending('notice_dup')?.status, 'open')
  assert.equal((await h.observer.answer(input('notice_dup', 'allow_once'))).ok, true)
  h.observer.observe(obsAsk('dup'), DEVICE)
  assert.equal(h.observer.pending('notice_dup')?.status, 'answered')
  assert.equal(h.replies.length, 1)
})
