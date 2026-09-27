/**
 * Independent adversarial verification of §6 (P3 write path + remote approval).
 *
 * These tests deliberately try to FALSIFY the implementer's security claims:
 * persistent-answer smuggling, replay/race on the first-answer lock, hook
 * effect rewriting, cross-session answering and high-risk denylist bypasses.
 * Where the implementation genuinely fails open the test records the OBSERVED
 * behaviour and the comment spells out the assertion that would fail if the
 * claim were enforced (see FINDINGS for the counterexamples).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionObserver } from '../../src/server/permission-bridge.js'
import type { ApprovalAnswerInput } from '../../src/server/permission-bridge.js'
import {
  PERSISTENT_ACTION,
  requiresLocalConfirmation,
  isRemoteActionId,
  remoteActions,
} from '../../src/shared/permission-policy.js'
import { createLogger } from '../../src/shared/logger.js'
import type { OpenCodeEvent, PermissionReplyRequest } from '../../src/server/opencode-ctx.js'

const SILENT = createLogger('adv', () => undefined)
const NATIVE = 'ses_native'
const A = 'D:/proj/a'

/**
 * §6⑤: the device identity is the handshake `connectorId` — `userId` is audit
 * only. Notices here are observed as claimed by `DEVICE` and answered as that
 * same device, except where a test deliberately binds another (or none).
 */
const DEVICE = 'device-a'

function asked(id: string, action?: unknown, sessionID = NATIVE): OpenCodeEvent {
  const data: Record<string, unknown> = { id, sessionID, resources: [] }
  if (action !== undefined) data['action'] = action
  return { id: `asked:${id}`, type: 'permission.asked', location: { directory: A }, data }
}

interface Harness {
  observer: PermissionObserver
  replies: PermissionReplyRequest[]
  audit: Array<Record<string, unknown>>
}

function harness(delayMs = 0): Harness {
  const replies: PermissionReplyRequest[] = []
  const audit: Array<Record<string, unknown>> = []
  const observer = new PermissionObserver(SILENT, (entry) => audit.push({ ...entry }))
  observer.install({
    permission: {
      hook: () => ({ dispose: () => undefined }),
      reply: async (request: PermissionReplyRequest) => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        replies.push(request)
      },
    },
  })
  return { observer, replies, audit }
}

function input(noticeId: string, actionId: string, extra: Record<string, unknown> = {}): ApprovalAnswerInput {
  return { noticeId, actionId, userId: 'u1', nativeSessionId: NATIVE, connectorId: DEVICE, ...extra } as ApprovalAnswerInput
}

// §6① — every spelling/shape of the persistent answer must be refused.
test('§6① no spelling of the persistent answer is accepted, and reply never sees `always`', async () => {
  const h = harness()
  const spellings = [
    'always', 'Always', 'ALWAYS', 'AlWaYs', ' always', 'always ', 'always\t',
    'allow_always', 'permanent', 'once', 'deny ', 'ALLOW_ONCE', 'allow_once ', '/always',
  ]
  for (const [i, spelling] of spellings.entries()) {
    const id = `p_${i}`
    h.observer.observe(asked(id, 'webfetch'), DEVICE)
    const outcome = await h.observer.answer(input(`notice_${id}`, spelling))
    assert.equal(outcome.ok, false, `spelling ${JSON.stringify(spelling)} must be refused`)
    assert.equal(outcome.ok === false && outcome.code, 'unsupported_action', spelling)
  }
  assert.deepEqual<PermissionReplyRequest[]>(h.replies, [], 'no malformed answer may reach permission.reply')

  // The two legal actions map to exactly `once` / `reject`.
  h.observer.observe(asked('ok', 'webfetch'), DEVICE)
  assert.equal((await h.observer.answer(input('notice_ok', 'allow_once'))).ok, true)
  h.observer.observe(asked('no', 'webfetch'), DEVICE)
  assert.equal((await h.observer.answer(input('notice_no', 'deny'))).ok, true)
  assert.deepEqual(h.replies.map((r) => r.body.reply), ['once', 'reject'])
  assert.equal(JSON.stringify(h.replies).includes('always'), false)
})

test('§6① extra fields on the answer cannot smuggle a persistent decision', async () => {
  const h = harness()
  h.observer.observe(asked('smug', 'webfetch'), DEVICE)
  const outcome = await h.observer.answer(
    input('notice_smug', 'allow_once', {
      reply: 'always',
      body: { reply: 'always' },
      permission: { action: 'always' },
      actions: [{ actionId: 'always' }],
      save: true,
    }),
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(h.replies, [{ path: { requestID: 'smug' }, body: { reply: 'once' } }])
})

// §6② — concurrency + replay: single winner, no cascade onto other notices.
test('§6② two concurrent answers: one lands, the other is already_answered, other notices untouched', async () => {
  const h = harness(15) // slow reply widens the race window
  h.observer.observe(asked('race', 'webfetch'), DEVICE)
  h.observer.observe(asked('other', 'webfetch'), DEVICE)
  const outcomes = await Promise.all([
    h.observer.answer(input('notice_race', 'allow_once', { userId: 'u1' })),
    h.observer.answer(input('notice_race', 'deny', { userId: 'u2' })),
  ])
  assert.equal(outcomes.filter((o) => o.ok).length, 1, JSON.stringify(outcomes))
  const loser = outcomes.find((o) => !o.ok)
  assert.equal(loser?.ok === false && loser.code, 'already_answered')
  assert.equal(h.replies.length, 1, 'only the winning answer may reach permission.reply')

  const other = await h.observer.answer(input('notice_other', 'allow_once'))
  assert.equal(other.ok, true, 'a second notice must not be poisoned by the race')
  assert.equal(h.replies.length, 2)
})

test('§6② replay after a native reply is already_answered and never re-replies', async () => {
  const h = harness()
  h.observer.observe(asked('nat', 'webfetch'), DEVICE)
  h.observer.observe({ id: 'r', type: 'permission.replied', location: { directory: A }, data: { requestID: 'nat', reply: 'once', sessionID: NATIVE } })
  const outcome = await h.observer.answer(input('notice_nat', 'allow_once'))
  assert.equal(outcome.ok === false && outcome.code, 'already_answered')
  assert.deepEqual(h.replies, [])
})

test('§6② a reply that throws releases the lock without retrying or cascading', async () => {
  const observer = new PermissionObserver(SILENT)
  let calls = 0
  observer.install({
    permission: { hook: () => ({ dispose: () => undefined }), reply: async () => { calls += 1; throw new Error('boom') } },
  })
  observer.observe(asked('boom', 'webfetch'), DEVICE)
  const first = await observer.answer(input('notice_boom', 'allow_once'))
  assert.equal(first.ok === false && first.code, 'reply_unavailable')
  assert.equal(calls, 1)
  const second = await observer.answer(input('notice_boom', 'allow_once'))
  assert.equal(second.ok === false && second.code, 'reply_unavailable')
  assert.equal(calls, 2, 'a failed answer must not auto-retry; a later explicit answer may')
})

// §6③ — the evaluate hook must stay neutral for every payload shape.
test('§6③ the evaluate hook returns undefined for every effect shape (no rewrite possible)', () => {
  let evaluate: ((payload: unknown) => unknown) | null = null
  const observer = new PermissionObserver(SILENT)
  observer.install({ permission: { hook: (_n, cb) => { evaluate = cb as (p: unknown) => unknown; return { dispose: () => undefined } } } })
  assert.ok(evaluate)
  const hook = evaluate as ((payload: unknown) => unknown) | null
  assert.ok(hook)
  const payloads = [
    { sessionID: NATIVE, agent: 'build', action: 'shell', effect: 'ask', resources: ['rm -rf /'] },
    { sessionID: NATIVE, action: 'write', effect: 'allow', resources: [] },
    { sessionID: NATIVE, action: 'bash', effect: 'deny', resources: [] },
    { effect: 'allow' },
    { sessionID: NATIVE, action: 'shell', effect: 'ask', decision: 'allow', reply: 'always' },
    {},
  ]
  for (const payload of payloads) {
    assert.equal(hook(payload), undefined, JSON.stringify(payload))
  }
  // The hook name is unvalidated by the host, so a registration success proves nothing.
  assert.equal(typeof evaluate, 'function')
})

// §6⑤ — an answer bound to another session is refused.
test('§6⑤ an answer carrying another native session is refused', async () => {
  const h = harness()
  h.observer.observe(asked('foreign', 'webfetch', 'ses_someone_else'), DEVICE)
  const outcome = await h.observer.answer(input('notice_foreign', 'allow_once'))
  assert.equal(outcome.ok === false && outcome.code, 'unknown_notice')
  assert.deepEqual(h.replies, [])
})

// §6⑥ — the enumerated high-risk names must stay local-only.
test('§6⑥ every enumerated high-risk action refuses a remote answer (case-insensitive)', async () => {
  const h = harness()
  const high = ['write', 'EDIT', 'Patch', 'Bash', 'SHELL', 'rm', 'move', 'mv', 'delete', 'execute', 'run']
  for (const [i, action] of high.entries()) {
    assert.equal(requiresLocalConfirmation(action), true, action)
    assert.deepEqual(remoteActions(action), [], action)
    const id = `h_${i}`
    h.observer.observe(asked(id, action), DEVICE)
    const outcome = await h.observer.answer(input(`notice_${id}`, 'allow_once'))
    assert.equal(outcome.ok === false && outcome.code, 'local_confirmation_required', action)
  }
  assert.deepEqual(h.replies, [])
})

// §6⑥ — the predicate is now an ALLOWLIST (fail-closed): only actions proven
// read-only may be answered remotely. Any unlisted/future/mis-spelled name, and
// a missing or empty action, stays local-only.
test('§6⑥ an action outside the read-only allowlist (or missing/empty) stays local-only', async () => {
  for (const action of ['write', 'write_file', 'multiedit', 'apply_patch', 'bash_write', 'Bash', null, '', '  ']) {
    assert.equal(requiresLocalConfirmation(action), true, JSON.stringify(action))
  }
  assert.equal(requiresLocalConfirmation('read'), false)
  assert.equal(requiresLocalConfirmation('webfetch'), false)
  assert.equal(isRemoteActionId('allow_once'), true)

  const h = harness()
  h.observer.observe(asked('gap_none'), DEVICE) // action omitted entirely
  const outcome = await h.observer.answer(input('notice_gap_none', 'allow_once'))
  assert.equal(outcome.ok === false && outcome.code, 'local_confirmation_required')
  assert.deepEqual(h.replies, [])
})

// §6① — the persistent answer is not even offered as a remote action.
test('§6① remoteActions never surfaces the persistent answer, and null is local-only', () => {
  for (const action of ['webfetch', 'read']) {
    const ids = remoteActions(action).map((a) => a['actionId'])
    assert.deepEqual(ids, ['allow_once', 'deny'])
    assert.equal(ids.includes(PERSISTENT_ACTION), false)
  }
  // A missing action is not proven read-only → no remote buttons at all.
  assert.deepEqual(remoteActions(null), [])
})

// §6② — a replayed `asked` for an answered interaction must not reopen it.
test('§6② a re-delivered permission.asked never reopens an answered interaction', async () => {
  const h = harness()
  h.observer.observe(asked('dup', 'webfetch'), DEVICE)
  assert.equal((await h.observer.answer(input('notice_dup', 'allow_once'))).ok, true)
  // The host re-emits the same ask (reconnect / event replay).
  h.observer.observe(asked('dup', 'webfetch'), DEVICE)
  assert.equal(h.observer.pending('notice_dup')?.status, 'answered', 'observe must not reset a answered record')
  const replay = await h.observer.answer(input('notice_dup', 'deny'))
  assert.equal(replay.ok === false && replay.code, 'already_answered')
  assert.equal(h.replies.length, 1, 'a replayed ask must not allow a second reply')
})

// §6⑤ — the notice is bound to the connector device that claimed the session.
test('§6⑤ a notice bound to one connector device refuses any other device', async () => {
  const h = harness()
  h.observer.observe(asked('bind', 'webfetch'), 'device-a')
  const foreign = await h.observer.answer(input('notice_bind', 'allow_once', { connectorId: 'device-b' }))
  assert.equal(foreign.ok === false && foreign.code, 'device_mismatch')
  assert.deepEqual(h.replies, [], 'a foreign device must never touch permission.reply')
  const owner = await h.observer.answer(input('notice_bind', 'allow_once', { connectorId: 'device-a' }))
  assert.equal(owner.ok, true, 'the owning device still answers')
})

// §6⑤ — first claim wins: a re-delivered ask (host replay) from a DIFFERENT
// claim must not rebind the owner; the second device stays locked out.
test('§6⑤ first claim wins and a re-delivered ask cannot rebind the owner', async () => {
  const h = harness()
  h.observer.observe(asked('owner', 'webfetch'), 'device-a')
  h.observer.observe(asked('owner', 'webfetch'), 'device-b') // replay after a later claim
  assert.equal(h.observer.pending('notice_owner')?.ownerConnectorId, 'device-a')
  const foreign = await h.observer.answer(input('notice_owner', 'allow_once', { connectorId: 'device-b' }))
  assert.equal(foreign.ok === false && foreign.code, 'device_mismatch')
  assert.deepEqual(h.replies, [], 'the later claim must never answer')
  assert.equal((await h.observer.answer(input('notice_owner', 'allow_once', { connectorId: 'device-a' }))).ok, true)
})

// §6⑤ — fail closed when no device has claimed the session (owner === null):
// there is no device to bind the notice to, so remote answering is refused with
// its own code (`unbound_notice`), distinct from a foreign device
// (`device_mismatch`) and from a notice that does not exist (`unknown_notice`).
test('§6⑤ an unclaimed notice refuses remote answers (fail-closed, unbound_notice)', async () => {
  const h = harness()
  h.observer.observe(asked('unclaimed', 'webfetch')) // no owner claim yet
  assert.equal(h.observer.pending('notice_unclaimed')?.ownerConnectorId, null)
  const rogue = await h.observer.answer(input('notice_unclaimed', 'allow_once', { connectorId: 'rogue-device' }))
  assert.equal(rogue.ok, false, 'a null owner must not fall through to a remote answer')
  assert.equal(rogue.ok === false && rogue.code, 'unbound_notice')
  assert.deepEqual(h.replies, [], 'an unbound notice may never reach permission.reply')
  // Even the "same" absent identity is not an owner.
  const anonymous = await h.observer.answer(input('notice_unclaimed', 'allow_once', { connectorId: null }))
  assert.equal(anonymous.ok === false && anonymous.code, 'unbound_notice')
  assert.deepEqual(h.replies, [])
})

// §6⑤ — userId is not part of the device identity: the binding is the handshake
// connectorId, so a second connection presenting the SAME connectorId is treated
// as the owning device (documented boundary, not a leak of another device).
test('§6⑤ device identity is connectorId: a different userId on the same connectorId still answers', async () => {
  const h = harness()
  h.observer.observe(asked('same_dev', 'webfetch'), 'device-a')
  const otherUser = await h.observer.answer(
    input('notice_same_dev', 'allow_once', { connectorId: 'device-a', userId: 'u2' }),
  )
  assert.equal(otherUser.ok, true, 'same connectorId = same device')
})

// §6⑦ — audit: refusals carry an outcome + reason; a landed answer is audited
// only after permission.reply, with its outcome, and never contains a token.
test('§6⑦ every attempt is audited (outcome/reason), refusals included', async () => {
  const h = harness()
  h.observer.observe(asked('audit', 'write'), DEVICE)
  await h.observer.answer(input('notice_audit', 'allow_once'))
  const refusal = h.audit.find((entry) => entry['noticeId'] === 'notice_audit')
  assert.equal(refusal?.['outcome'], 'refused')
  assert.equal(refusal?.['reason'], 'local_confirmation_required')

  h.observer.observe(asked('audit_ok', 'webfetch'), DEVICE)
  await h.observer.answer(input('notice_audit_ok', 'allow_once'))
  assert.equal(h.audit.find((entry) => entry['noticeId'] === 'notice_audit_ok')?.['outcome'], 'allowed')
  assert.equal(JSON.stringify(h.audit).includes('always'), false)
})
