import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, type LogLevel } from '../../src/shared/logger.js'
import { readLoginPrompt } from '../../src/shared/login-prompt.js'
import {
  autoLoginDisabledStateLine,
  connectedStateLine,
  disabledStateLine,
  needsLoginStateLine,
} from '../../src/server/login-state.js'
import { runSetupLogin } from '../../src/server/index.js'
import type { ConnectionStage, LoginOutcome } from '../../src/server/onboarding.js'

const ORIGIN = 'https://api.example.com'

const CONNECTED_STAGE: Extract<ConnectionStage, { stage: 'connected' }> = {
  stage: 'connected',
  apiBaseUrl: ORIGIN,
  userId: 'user_1',
  connectorId: 'cxt_1',
  reusedDevice: true,
}

const CONNECTED: LoginOutcome = { ok: true, stage: CONNECTED_STAGE }

test('needs_login says what is wrong, what happens next, and (when off) how to turn it on', () => {
  const on = needsLoginStateLine(
    { stage: 'needs_login', apiBaseUrl: ORIGIN, reason: 'no stored account' },
    { autoLogin: true, autoLoginSource: 'default' },
  )
  assert.match(on, /需要登录/)
  assert.match(on, /no stored account/)
  assert.match(on, new RegExp(ORIGIN))
  assert.match(on, /已自动发起/)
  assert.doesNotMatch(on, /AGENT_AA_LOGIN/, 'the default path asks for no environment variable')

  const off = needsLoginStateLine(
    { stage: 'needs_login', apiBaseUrl: null, reason: 'no stored account' },
    { autoLogin: false, autoLoginSource: 'options' },
  )
  assert.match(off, /自动登录当前关闭/)
  assert.match(off, /options\.autoLogin/)
  assert.match(off, /未配置/)
})

test('the disabled/auto-login-off and credential-store lines name a next step', () => {
  const off = autoLoginDisabledStateLine({ autoLogin: false, autoLoginSource: 'env' })
  assert.match(off, /AGENT_AA_AUTO_LOGIN/)
  assert.match(off, /options\.autoLogin/)
  assert.match(disabledStateLine({ stage: 'disabled', reason: 'credential store unreadable' }), /AGENT_CONNECTOR_DATA_DIR/)
})

test('connected says who, which device, and how it got there', () => {
  const line = connectedStateLine(CONNECTED_STAGE, { loginMode: 'loopback', fellBack: false })
  assert.match(line, /已连接/)
  assert.match(line, /user_1/)
  assert.match(line, /cxt_1/)
  assert.match(line, /回环 OAuth 登录/)
  assert.match(line, /复用本机已有的 Connector/)
  assert.match(connectedStateLine(CONNECTED_STAGE, { loginMode: 'device', fellBack: true }), /自动回退/)
})

test('the setup login task logs logging_in and then connected, and never throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-login-state-'))
  const lines: string[] = []
  const logger = createLogger('test', (level: LogLevel, _scope: string, message: string) => {
    lines.push(`${level} ${message}`)
  })
  try {
    const url = `${ORIGIN}/#/plugin-oauth?state=s`
    const result = await runSetupLogin({
      dataDir: dir,
      logger,
      env: {} as NodeJS.ProcessEnv,
      forcedMode: 'loopback',
      login: async (options) => {
        await options.onAuthorizationUrl?.(url, { deadline: 9_000, redirectUri: 'http://127.0.0.1:9/oauth/callback' })
        return CONNECTED
      },
    })
    assert.equal(result?.outcome.ok, true)
    assert.ok(lines.some((line) => line.includes('info') && line.includes(url)), JSON.stringify(lines))
    assert.ok(lines.some((line) => line.includes('已连接')), JSON.stringify(lines))
    assert.equal((await readLoginPrompt(dir))?.status, 'connected')

    // A login that blows up is logged, never propagated into the host.
    const failed = await runSetupLogin({
      dataDir: dir,
      logger,
      login: async () => {
        throw new Error('boom')
      },
    })
    assert.equal(failed, null)
    assert.ok(lines.some((line) => line.includes('自动登录失败')), JSON.stringify(lines))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
