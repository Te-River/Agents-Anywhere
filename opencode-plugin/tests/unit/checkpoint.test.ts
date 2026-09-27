import test from 'node:test'
import assert from 'node:assert/strict'
import { Projector } from '../../src/server/projector.js'

const NATIVE = 'ses_native'
const PLATFORM = 'sess_opencode_test'

function feed(instance: Projector, type: string, durableSeq: number | undefined): void {
  instance.apply(NATIVE, {
    id: `${type}:${durableSeq ?? 'none'}`,
    created: '2026-01-01T00:00:00.000Z',
    type,
    location: { directory: 'D:/proj/a' },
    data: { sessionID: NATIVE, delta: 'x', assistantMessageID: 'msg_1', ordinal: 0 },
    ...(durableSeq !== undefined ? { durable: { aggregateID: NATIVE, seq: durableSeq, version: 1 } } : {}),
  })
}

function watermark(instance: Projector): number | null {
  const snapshot = instance.snapshot(NATIVE, PLATFORM)
  assert.ok(snapshot)
  return snapshot.watermark
}

test('the checkpoint advances only on durable events and only ever forward', () => {
  const instance = new Projector()

  // Non-durable events (the majority) must not move the checkpoint.
  feed(instance, 'session.text.delta', undefined)
  feed(instance, 'session.step.streamed', undefined)
  assert.equal(watermark(instance), null)

  feed(instance, 'session.text.delta', 5)
  assert.equal(watermark(instance), 5)

  // Duplicate / out-of-order durable seqs must not regress the checkpoint.
  feed(instance, 'session.text.delta', 3)
  assert.equal(watermark(instance), 5)

  feed(instance, 'session.tool.called', 9)
  assert.equal(watermark(instance), 9)

  // …and a later non-durable event leaves it untouched.
  feed(instance, 'session.idle', undefined)
  assert.equal(watermark(instance), 9)
})

test('the checkpoint is per session, not global', () => {
  const instance = new Projector()
  instance.apply('ses_one', {
    id: 'e1',
    type: 'session.text.delta',
    location: { directory: 'D:/proj/a' },
    data: { sessionID: 'ses_one', assistantMessageID: 'm1', ordinal: 0 },
    durable: { seq: 12 },
  })
  instance.apply('ses_two', {
    id: 'e2',
    type: 'session.text.delta',
    location: { directory: 'D:/proj/a' },
    data: { sessionID: 'ses_two', assistantMessageID: 'm1', ordinal: 0 },
  })

  assert.equal(instance.snapshot('ses_one', PLATFORM)?.watermark, 12)
  assert.equal(instance.snapshot('ses_two', PLATFORM)?.watermark, null)
})
