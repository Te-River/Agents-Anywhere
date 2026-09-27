import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionObserver } from '../../src/server/permission-bridge.js'
import type { PermissionEvaluatePayload } from '../../src/server/opencode-ctx.js'
import { createLogger, redact } from '../../src/shared/logger.js'
import type { LogLevel } from '../../src/shared/logger.js'

test('the evaluate hook records neutrally and never rewrites the effect', () => {
  const registrations: string[] = []
  let disposeCalls = 0
  let evaluate: ((payload: PermissionEvaluatePayload) => unknown) | null = null

  const observer = new PermissionObserver(createLogger('test', () => undefined))
  const attached = observer.install({
    permission: {
      hook: (name, callback) => {
        registrations.push(name)
        evaluate = callback
        return { dispose: () => (disposeCalls += 1) }
      },
    },
  })

  assert.equal(attached, true)
  assert.deepEqual(registrations, ['evaluate'])
  assert.ok(evaluate)
  const hook = evaluate as ((payload: PermissionEvaluatePayload) => unknown) | null
  assert.ok(hook)

  const returned = hook({ sessionID: 'ses_1', agent: 'build', action: 'shell', effect: 'ask', resources: ['rm -rf /'] })
  assert.equal(returned, undefined, 'undefined keeps the host effect untouched (no auto-allow, no deny)')

  assert.equal(observer.observations.length, 1)
  assert.equal(observer.observations[0]?.action, 'shell')
  assert.equal(observer.observations[0]?.effect, 'ask')

  observer.dispose()
  assert.equal(disposeCalls, 1)
  assert.equal(observer.attached, false)
})

test('a missing permission hook fails soft instead of throwing', () => {
  const observer = new PermissionObserver(createLogger('test', () => undefined))
  assert.equal(observer.install({}), false)
  assert.equal(observer.observations.length, 0)
  observer.dispose()
})

test('secret-like fields are redacted before they reach a log sink', () => {
  const lines: Array<{ level: LogLevel; fields: Record<string, unknown> }> = []
  const logger = createLogger('test', (level, _scope, _message, fields) => {
    lines.push({ level, fields })
  })

  logger.info('handshake', { authToken: 'super-secret', code: 'auth-code', port: 49375, nested: { token: 'x' } })
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.fields['authToken'], '[redacted]')
  assert.equal(lines[0]?.fields['code'], '[redacted]')
  assert.equal(lines[0]?.fields['port'], 49375)
  assert.deepEqual(lines[0]?.fields['nested'], { token: '[redacted]' })

  assert.equal(redact('plain'), 'plain')
  assert.equal((redact({ password: 'p' }) as Record<string, unknown>)['password'], '[redacted]')
})
