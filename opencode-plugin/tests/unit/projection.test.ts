import test from 'node:test'
import assert from 'node:assert/strict'
import { Projector } from '../../src/server/projector.js'
import { contentHash, RUNTIME_STATUSES, type TimelineItem } from '../../src/shared/protocol.js'

const NATIVE = 'ses_native'
const PLATFORM = 'sess_opencode_test'

function projector(): Projector {
  return new Projector()
}

function feed(
  instance: Projector,
  type: string,
  data: Record<string, unknown> = {},
): ReturnType<Projector['apply']> {
  return instance.apply(NATIVE, {
    id: `${type}:${Math.random().toString(36).slice(2, 8)}`,
    created: '2026-01-01T00:00:00.000Z',
    type,
    location: { directory: 'D:/proj/a' },
    data: { sessionID: NATIVE, ...data },
  })
}

function items(instance: Projector): TimelineItem[] {
  const snapshot = instance.snapshot(NATIVE, PLATFORM)
  assert.ok(snapshot, 'expected a projected snapshot')
  return snapshot.items
}

test('the six event names missing from the SDK types are all projected', () => {
  const instance = projector()

  // session.step.started → model/agent selections, no timeline item
  assert.equal(feed(instance, 'session.step.started', { agent: 'build', model: 'deepseek-flash' }).skipped, false)
  assert.deepEqual(instance.state(NATIVE)?.selections, { model: 'deepseek-flash', agent: 'build' })

  // session.tool.called → tool item in `running`
  feed(instance, 'session.tool.called', { id: 'call_1', assistantMessageID: 'msg_1', input: { cmd: 'ls' }, executed: true })
  const tool = items(instance).find((item) => item.type === 'tool')
  assert.ok(tool)
  assert.equal(tool.status, 'running')
  assert.equal(tool.content['kind'], 'tool_call')
  assert.deepEqual(tool.content['input'], { cmd: 'ls' })

  // session.tool.success → same item completed with output (kind unchanged)
  feed(instance, 'session.tool.success', { id: 'call_1', content: 'ok', executed: true })
  const completed = items(instance).find((item) => item.type === 'tool')
  assert.equal(completed?.status, 'done')
  assert.equal(completed?.content['kind'], 'tool_call')
  assert.equal(completed?.content['output'], 'ok')
  assert.ok((completed?.revision ?? 0) > 1, 'completing a tool must bump its revision')

  // session.reasoning.delta → assistant message flagged as reasoning
  feed(instance, 'session.reasoning.delta', { assistantMessageID: 'msg_2', delta: 'think', ordinal: 1 })
  const reasoning = items(instance).find((item) => item.metadata['reasoning'] === true)
  assert.ok(reasoning)
  assert.equal(reasoning.content['text'], 'think')
  assert.equal(reasoning.type, 'message')

  // session.step.ended → open assistant items finalised + a turn.end marker
  feed(instance, 'session.step.ended', { assistantMessageID: 'msg_2', cost: 0.01, tokens: { input: 1 } })
  assert.equal(items(instance).find((item) => item.metadata['reasoning'] === true)?.status, 'done')
  assert.ok(items(instance).some((item) => item.type === 'turn.end' && item.status === 'done'))

  // shell.exited → tool(command) completed with its exit code
  feed(instance, 'shell.created', { id: 'sh_1', info: { command: 'echo hi' } })
  feed(instance, 'shell.exited', { id: 'sh_1', exit: 1, status: 'exited' })
  const shell = items(instance).find((item) => item.metadata['shell'] === true)
  assert.ok(shell)
  assert.equal(shell.status, 'failed')
  assert.equal(shell.content['kind'], 'command')
  assert.equal(shell.content['exitCode'], 1)
})

test('every projected item carries the connector-verifiable content hash', () => {
  const instance = projector()
  feed(instance, 'session.next.prompted', { text: 'hello there' })
  feed(instance, 'session.text.started', { assistantMessageID: 'msg_1', ordinal: 0 })
  feed(instance, 'session.text.delta', { assistantMessageID: 'msg_1', delta: 'wor', ordinal: 0 })
  feed(instance, 'session.text.delta', { assistantMessageID: 'msg_1', delta: 'ld', ordinal: 0 })
  feed(instance, 'session.tool.failed', { id: 'call_x', error: 'boom', executed: true })
  feed(instance, 'session.execution.interrupted', { reason: 'user' })

  const projected = items(instance)
  assert.ok(projected.length >= 4)
  for (const item of projected) {
    assert.equal(
      item.contentHash,
      contentHash(item.type, item.status, item.role, item.content),
      `contentHash must be recomputable for ${item.type}/${item.status}`,
    )
  }
  const assistant = projected.find((item) => item.role === 'assistant' && item.type === 'message')
  assert.equal(assistant?.content['text'], 'world')
  assert.ok(projected.some((item) => item.type === 'turn.end' && item.status === 'cancelled'))
})

test('unknown event types are counted and never throw', () => {
  const instance = projector()
  const outcome = feed(instance, 'session.mystery.thing', { whatever: 1 })
  assert.equal(outcome.skipped, true)
  assert.equal(outcome.reason, 'unknown:session.mystery.thing')

  const broken = instance.apply(NATIVE, { type: undefined } as never)
  assert.equal(broken.skipped, true)

  const counters = instance.counters()
  assert.equal(counters.unknownTypes['session.mystery.thing'], 1)
  assert.ok(counters.skippedEvents >= 2)

  // A whitelisted type that is missing its key field is skipped, not thrown.
  assert.equal(feed(instance, 'session.tool.called', {}).skipped, true)
  assert.equal(feed(instance, 'session.text.delta', { delta: 'orphan delta' }).skipped, true, 'no assistantMessageID → skipped')
})

test('permission events become notices, never timeline items', () => {
  const instance = projector()
  feed(instance, 'permission.asked', { id: 'req_1', action: 'shell', resources: ['bash: rm -rf /'], source: { type: 'tool' } })
  assert.equal(items(instance).length, 0, 'permission.asked must not enter the timeline')

  const open = instance.notices(NATIVE, PLATFORM)
  assert.equal(open.length, 1)
  assert.equal(open[0]?.type, 'interaction')
  assert.equal(open[0]?.responseRequired, true)
  assert.equal(open[0]?.status, 'open')
  assert.equal(open[0]?.sessionId, PLATFORM)
  // §6 / AA contract: the interaction kind is `approval`, `blocking` is the AA
  // NoticeBlocking shape, and the permission specifics live in `context`. A
  // high-risk action (shell) exposes no remote buttons and stays local-only.
  assert.equal(open[0]?.interactionType, 'approval')
  assert.deepEqual(open[0]?.actions, [])
  assert.deepEqual(open[0]?.blocking, { scope: 'session', targetId: NATIVE })
  assert.equal((open[0]?.context as Record<string, unknown>)['requiresLocalConfirmation'], true)
  assert.equal((open[0]?.context as Record<string, unknown>)['requestId'], 'req_1')
  assert.equal((open[0]?.context as Record<string, unknown>)['permission'], 'shell')
  assert.equal(instance.state(NATIVE)?.status, 'waiting_approval')

  feed(instance, 'permission.replied', { requestID: 'req_1', reply: 'once' })
  assert.equal(instance.notices(NATIVE, PLATFORM)[0]?.status, 'resolved')
  assert.equal(instance.state(NATIVE)?.status, 'idle')
})

test('§6② a re-delivered permission.asked never duplicates nor reopens the notice', () => {
  const instance = projector()
  const ask = () => feed(instance, 'permission.asked', { id: 'req_dup', action: 'webfetch', resources: [] })

  ask()
  ask() // identical replay BEFORE the answer: still one open notice
  assert.equal(instance.notices(NATIVE, PLATFORM).length, 1)
  assert.equal(instance.notices(NATIVE, PLATFORM)[0]?.status, 'open')
  assert.equal(instance.state(NATIVE)?.openInteractions, 1)

  feed(instance, 'permission.replied', { requestID: 'req_dup', reply: 'once' })
  assert.deepEqual(instance.notices(NATIVE, PLATFORM).map((notice) => notice.status), ['resolved'])
  assert.equal(instance.state(NATIVE)?.openInteractions, 0)

  // Identical replay AFTER the answer: no second notice, no flip back to open.
  ask()
  const after = instance.notices(NATIVE, PLATFORM)
  assert.equal(after.length, 1, 'a replayed ask must never enqueue a second notice')
  assert.equal(after.filter((notice) => notice.noticeId === 'notice_req_dup').length, 1)
  assert.deepEqual(after.map((notice) => notice.status), ['resolved'])
  assert.equal(after[0]?.responseRequired, false)
  assert.equal(instance.state(NATIVE)?.openInteractions, 0)
  assert.equal(instance.state(NATIVE)?.status, 'idle')
})

test('a low-risk permission notice offers only allow_once/deny (never always)', () => {
  const instance = projector()
  feed(instance, 'permission.asked', { id: 'req_low', action: 'webfetch' })
  const notice = instance.notices(NATIVE, PLATFORM)[0]
  assert.equal(notice?.interactionType, 'approval')
  assert.deepEqual(
    notice?.actions.map((action) => action['actionId']),
    ['allow_once', 'deny'],
  )
  assert.equal((notice?.context as Record<string, unknown>)['requiresLocalConfirmation'], false)
})

test('orderSeq is monotonic and state is a valid platform status', () => {
  const instance = projector()
  feed(instance, 'session.next.prompted', { text: 'a' })
  feed(instance, 'session.text.delta', { assistantMessageID: 'msg_1', delta: 'b', ordinal: 0 })
  feed(instance, 'session.idle', {})
  const seqs = items(instance).map((item) => item.orderSeq)
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right))
  assert.equal(new Set(seqs).size, seqs.length)
  const status = instance.state(NATIVE)?.status
  assert.ok(status !== undefined && (RUNTIME_STATUSES as readonly string[]).includes(status))
})
