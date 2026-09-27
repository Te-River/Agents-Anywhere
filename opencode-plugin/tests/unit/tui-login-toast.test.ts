/**
 * Defect ② (TUI half): a login the user started from the *server* side used to
 * be invisible in the TUI. The watcher polls `login.json` and toasts each
 * state change — 开始登录 / 成功 / 失败 — with an actionable message.
 *
 * Everything is injected here: a fake api, a fake `readPrompt`, no real
 * `login.json`, no timer left running, no host surface touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loginStateToast, startLoginStateWatcher, type TuiToast } from '../../src/tui/index.js'
import type { LoginPrompt } from '../../src/shared/login-prompt.js'

const PATH = 'C:\\fake-data\\opencode-plugin\\login.json'

function prompt(overrides: Partial<LoginPrompt> & Pick<LoginPrompt, 'status' | 'kind' | 'createdAt'>): LoginPrompt {
  return { version: 1, expiresAt: 0, instruction: '', ...overrides }
}

const DEVICE_PENDING = prompt({
  status: 'pending',
  kind: 'device',
  createdAt: 1,
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://web.example/#/plugin-device',
})
const CONNECTED = prompt({ status: 'connected', kind: 'device', createdAt: 2, instruction: '登录已完成。' })
const FAILED = prompt({ status: 'failed', kind: 'device', createdAt: 3, instruction: '登录未完成（expired_token）：设备码已过期。' })

interface Recorder {
  toasts: TuiToast[]
}

function fakeApi(): { api: Record<string, unknown>; recorded: Recorder } {
  const recorded: Recorder = { toasts: [] }
  const api: Record<string, unknown> = {
    app: { version: '2.0.18' },
    ui: { toast: (input: TuiToast) => recorded.toasts.push(input) },
  }
  return { api, recorded }
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

test('loginStateToast maps a state change to one actionable toast, and a re-read to nothing', () => {
  assert.equal(loginStateToast(DEVICE_PENDING, DEVICE_PENDING, PATH), null, 'the same record is not re-announced')
  assert.equal(loginStateToast(null, null, PATH), null)

  const started = loginStateToast(DEVICE_PENDING, null, PATH)
  assert.equal(started?.variant, 'warning')
  assert.match(started?.message ?? '', /ABCD-EFGH/)
  assert.match(started?.message ?? '', /https:\/\/web\.example\/#\/plugin-device/)
  assert.match(started?.message ?? '', /login\.json/)

  const loopback = loginStateToast(
    prompt({ status: 'pending', kind: 'loopback', createdAt: 4, authorizationUrl: 'https://web.example/#/plugin-oauth?x=1' }),
    null,
    PATH,
  )
  assert.match(loopback?.message ?? '', /授权/)
  assert.match(loopback?.message ?? '', /plugin-oauth/)

  const done = loginStateToast(CONNECTED, DEVICE_PENDING, PATH)
  assert.equal(done?.variant, 'success')
  assert.match(done?.message ?? '', /登录成功/)

  const failed = loginStateToast(FAILED, CONNECTED, PATH)
  assert.equal(failed?.variant, 'error')
  assert.match(failed?.message ?? '', /expired_token/)
  assert.match(failed?.message ?? '', /\/aa-login/, 'a failure always names the retry command')
})

test('the watcher toasts 开始登录 / 成功 / 失败 and stops when disposed', async () => {
  const { api, recorded } = fakeApi()
  let current: LoginPrompt | null = null
  let reads = 0
  const stop = startLoginStateWatcher(api, {
    dataDir: 'C:\\fake-data\\opencode-plugin',
    intervalMs: 5,
    readPrompt: async () => {
      reads += 1
      return current
    },
  })
  try {
    assert.ok(await waitUntil(() => reads >= 1), 'the watcher polls')
    // The first read is only the baseline: a stale record from an earlier run
    // must not be announced as if it had just happened.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(recorded.toasts.length, 0, 'the baseline read is silent')

    current = DEVICE_PENDING
    assert.ok(await waitUntil(() => recorded.toasts.length === 1))
    assert.equal(recorded.toasts[0]?.variant, 'warning')
    assert.match(recorded.toasts[0]?.message ?? '', /ABCD-EFGH/)

    current = CONNECTED
    assert.ok(await waitUntil(() => recorded.toasts.length === 2))
    assert.equal(recorded.toasts[1]?.variant, 'success')

    current = FAILED
    assert.ok(await waitUntil(() => recorded.toasts.length === 3))
    assert.equal(recorded.toasts[2]?.variant, 'error')
    assert.match(recorded.toasts[2]?.message ?? '', /\/aa-login/)

    // A re-read of the same record must not add a fourth toast.
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(recorded.toasts.length, 3)

    stop()
    current = prompt({ status: 'pending', kind: 'loopback', createdAt: 99 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(recorded.toasts.length, 3, 'a disposed watcher must not keep polling')
  } finally {
    stop()
  }
})

test('a hostile api or a failing read never throws into the host', async () => {
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error('nope')
      },
    },
  )
  let reads = 0
  const stop = startLoginStateWatcher(hostile as never, {
    dataDir: 'x',
    intervalMs: 5,
    readPrompt: async () => {
      reads += 1
      if (reads === 1) return null
      throw new Error('unreadable')
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.doesNotThrow(() => stop())
  assert.ok(reads >= 2, 'the failing read is retried, not fatal')
})
