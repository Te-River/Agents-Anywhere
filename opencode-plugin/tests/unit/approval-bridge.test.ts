import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionObserver } from '../../src/server/permission-bridge.js'
import {
  REMOTE_ALLOW_ACTION,
  REMOTE_DENY_ACTION,
  PERSISTENT_ACTION,
  remoteActions,
  requiresLocalConfirmation,
} from '../../src/shared/permission-policy.js'
import { createLogger } from '../../src/shared/logger.js'
import type { OpenCodeEvent, PermissionReplyRequest } from '../../src/server/opencode-ctx.js'

const SILENT = createLogger('test', () => undefined)
const NATIVE = 'ses_native'

/**
 * §6⑤: the device identity is the handshake `connectorId`. Every notice below is
 * observed as claimed by `DEVICE` (a session no connection has claimed fails
 * closed, `unbound_notice`) and answered as that same device.
 */
const DEVICE = 'device-a'

function asked(id: string, action: string, sessionID = NATIVE): OpenCodeEvent {
  return { id: `asked:${id}`, type: 'permission.asked', location: { directory: 'D:/proj/a' }, data: { id, action, sessionID, resources: [] } }
}

function replied(requestID: string, sessionID = NATIVE): OpenCodeEvent {
  return { id: `replied:${requestID}`, type: 'permission.replied', location: { directory: 'D:/proj/a' }, data: { requestID, reply: 'once', sessionID } }
}

interface Harness {
  observer: PermissionObserver
  replies: PermissionReplyRequest[]
  audit: Array<Record<string, unknown>>
  evaluate: ((payload: unknown) => unknown) | null
}

function harness(): Harness {
  const replies: PermissionReplyRequest[] = []
  const audit: Array<Record<string, unknown>> = []
  let evaluate: ((payload: unknown) => unknown) | null = null
  const observer = new PermissionObserver(SILENT, (entry) => audit.push({ ...entry }))
  observer.install({
    permission: {
      hook: (_name, callback) => {
        evaluate = callback as (payload: unknown) => unknown
        return { dispose: () => undefined }
      },
      reply: async (request: PermissionReplyRequest) => {
        replies.push(request)
      },
    },
  })
  return { observer, replies, audit, evaluate }
}

// §6 ① — never `always`, never a persistent-rule rewrite.
test('§6① a remote `always` is refused and the persistent rules are never touched', async () => {
  const h = harness()
  h.observer.observe(asked('req_always', 'webfetch'), DEVICE)
  const outcome = await h.observer.answer({ noticeId: 'notice_req_always', actionId: PERSISTENT_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.code, 'unsupported_action')
  assert.deepEqual(h.replies, [], 'permission.reply is never called for always')
  // The exposed actions never include the persistent answer either.
  assert.deepEqual(
    remoteActions('webfetch').map((action) => action['actionId']),
    [REMOTE_ALLOW_ACTION, REMOTE_DENY_ACTION],
  )
})

// §6 ② — first answer wins; no retry, no cascade.
test('§6② the first answer locks the notice; a second answer is already_answered', async () => {
  const h = harness()
  h.observer.observe(asked('req_lock', 'webfetch'), DEVICE)
  const first = await h.observer.answer({ noticeId: 'notice_req_lock', actionId: REMOTE_ALLOW_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(first.ok, true)
  assert.equal(h.replies.length, 1)
  assert.deepEqual(h.replies[0], { path: { requestID: 'req_lock' }, body: { reply: 'once' } })

  const second = await h.observer.answer({ noticeId: 'notice_req_lock', actionId: REMOTE_DENY_ACTION, userId: 'user-2', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(second.ok, false)
  assert.equal(second.ok === false && second.code, 'already_answered')
  assert.equal(h.replies.length, 1, 'a refused second answer must not call reply again')
})

test('§6② a native answer/cancel closes the notice to remote answering', async () => {
  const h = harness()
  h.observer.observe(asked('req_native', 'webfetch'), DEVICE)
  h.observer.observe(replied('req_native'))
  const outcome = await h.observer.answer({ noticeId: 'notice_req_native', actionId: REMOTE_ALLOW_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.code, 'already_answered')
  assert.deepEqual(h.replies, [])
})

// §6 ③ — A11 unproven: the evaluate hook stays neutral (returns undefined).
test('§6③ the evaluate hook is neutral and never rewrites the effect', () => {
  const h = harness()
  assert.ok(h.evaluate)
  for (const effect of ['ask', 'allow', 'deny']) {
    const returned = h.evaluate({ sessionID: NATIVE, agent: 'build', action: 'shell', effect, resources: ['rm -rf /'] })
    assert.equal(returned, undefined, `effect ${effect}: the hook must return undefined (A11 unproven)`)
  }
  assert.deepEqual(h.replies, [], 'the hook never answers anything by itself')
})

// §6 ④ — audit every remote answer (after permission.reply), and never a token.
test('§6④ every remote answer is audited with an outcome and no secret', async () => {
  const h = harness()
  h.observer.observe(asked('req_audit', 'webfetch'), DEVICE)
  await h.observer.answer({ noticeId: 'notice_req_audit', actionId: REMOTE_DENY_ACTION, userId: 'user-9', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(h.audit.length, 1)
  const entry = h.audit[0]!
  assert.deepEqual(Object.keys(entry).sort(), ['actionId', 'noticeId', 'outcome', 'source', 'ts', 'userId'].sort())
  assert.equal(entry['source'], 'remote')
  assert.equal(entry['userId'], 'user-9')
  assert.equal(entry['actionId'], REMOTE_DENY_ACTION)
  assert.equal(entry['outcome'], 'denied')
  assert.equal(typeof entry['ts'], 'string')
  assert.equal(JSON.stringify(entry).toLowerCase().includes('token'), false, 'audit must never carry a token')
})

// §6 ⑤ — an answer is bound to the connection's session/device.
test('§6⑤ an answer for another session or an unknown notice is rejected', async () => {
  const h = harness()
  h.observer.observe(asked('req_bind', 'webfetch', 'ses_other'), DEVICE)
  const foreign = await h.observer.answer({ noticeId: 'notice_req_bind', actionId: REMOTE_ALLOW_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(foreign.ok === false && foreign.code, 'unknown_notice')

  const unknown = await h.observer.answer({ noticeId: 'notice_missing', actionId: REMOTE_ALLOW_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(unknown.ok === false && unknown.code, 'unknown_notice')
  assert.deepEqual(h.replies, [])
})

// §6 ⑥ — high-risk actions stay local-only.
test('§6⑥ a high-risk action requires local confirmation and refuses any remote answer', async () => {
  const h = harness()
  h.observer.observe(asked('req_write', 'write'), DEVICE)
  assert.equal(requiresLocalConfirmation('write'), true)
  assert.deepEqual(remoteActions('write'), [], 'a high-risk action exposes no remote buttons')
  const outcome = await h.observer.answer({ noticeId: 'notice_req_write', actionId: REMOTE_ALLOW_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.code, 'local_confirmation_required')
  assert.deepEqual(h.replies, [], 'the remote answer never reaches permission.reply')
})

test('a missing permission.reply fails closed without locking the notice', async () => {
  const observer = new PermissionObserver(SILENT)
  observer.install({ permission: { hook: () => ({ dispose: () => undefined }) } })
  observer.observe(asked('req_noreply', 'webfetch'), DEVICE)
  const outcome = await observer.answer({ noticeId: 'notice_req_noreply', actionId: REMOTE_ALLOW_ACTION, userId: 'user-1', nativeSessionId: NATIVE, connectorId: DEVICE })
  assert.equal(outcome.ok === false && outcome.code, 'reply_unavailable')
})
