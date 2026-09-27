import test from 'node:test'
import assert from 'node:assert/strict'
import { DeviceLoginError, runDeviceLogin, type DeviceLoginClient } from '../../src/server/device-login.js'
import type { DeviceCodeResponse } from '../../src/shared/oauth.js'

const CODE: DeviceCodeResponse = {
  deviceCode: 'device-code-value',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://api.example.com/#/plugin-device',
  verificationUriComplete: 'https://api.example.com/#/plugin-device?user_code=ABCD-EFGH',
  expiresIn: 600,
  interval: 5,
  scope: 'profile',
}

type PollResponse = Awaited<ReturnType<DeviceLoginClient['pollDeviceToken']>>

function fakeClient(polls: PollResponse[]): { client: DeviceLoginClient; state: { polls: number } } {
  const state = { polls: 0 }
  return {
    state,
    client: {
      async requestDeviceCode() { return CODE },
      async pollDeviceToken() {
        state.polls += 1
        const next = polls.shift()
        if (next === undefined) throw new Error('unexpected extra poll')
        return next
      },
    },
  }
}

const pending: PollResponse = { ok: false, error: 'authorization_pending', description: null, interval: null }
const token: PollResponse = { ok: true, token: { accessToken: 'tok', expiresIn: 3600 } }

test('device login polls through authorization_pending and returns the token', async () => {
  const { client, state } = fakeClient([pending, pending, token])
  const waits: number[] = []
  let clock = 0
  const notices: unknown[] = []
  const result = await runDeviceLogin({
    client,
    onCode: (notice) => { notices.push(notice) },
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms },
  })
  assert.equal(result.accessToken, 'tok')
  assert.equal(state.polls, 3)
  assert.deepEqual(waits, [5_000, 5_000, 5_000])
  assert.equal(notices.length, 1)
  assert.deepEqual((notices[0] as { userCode: string }).userCode, 'ABCD-EFGH')
})

test('slow_down increases the interval and honours a server-supplied interval', async () => {
  const { client } = fakeClient([
    { ok: false, error: 'slow_down', description: null, interval: null },
    { ok: false, error: 'slow_down', description: null, interval: 20 },
    token,
  ])
  const waits: number[] = []
  await runDeviceLogin({ client, onCode: () => undefined, sleep: async (ms) => { waits.push(ms) } })
  // 5s base, +5 on the first slow_down, then the server's 20 wins.
  assert.deepEqual(waits, [5_000, 10_000, 20_000])
})

for (const [error, expected] of [
  ['access_denied', 'access_denied'],
  ['expired_token', 'expired_token'],
  ['invalid_grant', 'invalid_grant'],
  ['unsupported_grant_type', 'unsupported_grant_type'],
] as const) {
  test(`device login maps ${error} to a DeviceLoginError`, async () => {
    const { client } = fakeClient([{ ok: false, error, description: null, interval: null }])
    await assert.rejects(
      runDeviceLogin({ client, onCode: () => undefined, sleep: async () => undefined }),
      (thrown: unknown) => thrown instanceof DeviceLoginError && thrown.code === expected,
    )
  })
}

test('an unknown device error is not swallowed', async () => {
  const { client } = fakeClient([{ ok: false, error: 'server_exploded', description: null, interval: null }])
  await assert.rejects(
    runDeviceLogin({ client, onCode: () => undefined, sleep: async () => undefined }),
    (thrown: unknown) => thrown instanceof DeviceLoginError && thrown.code === 'unexpected_error',
  )
})

test('the local expiry bound stops an endlessly-pending flow', async () => {
  const { client } = fakeClient([pending, pending, pending])
  let clock = 0
  await assert.rejects(
    runDeviceLogin({
      client,
      onCode: () => undefined,
      now: () => clock,
      sleep: async (ms) => { clock += ms + 200_000 },
    }),
    (thrown: unknown) => thrown instanceof DeviceLoginError && thrown.code === 'expired_token',
  )
})

test('an aborted login stops before the next poll', async () => {
  const { client, state } = fakeClient([pending])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runDeviceLogin({ client, onCode: () => undefined, signal: controller.signal, sleep: async () => undefined }),
    (thrown: unknown) => thrown instanceof DeviceLoginError && thrown.code === 'aborted',
  )
  assert.equal(state.polls, 0)
})
