import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, type LogLevel } from '../../src/shared/logger.js'
import { loginPromptPath, readLoginPrompt } from '../../src/shared/login-prompt.js'
import type { LoginMode } from '../../src/shared/plugin-options.js'
import { preferredLoginMode, runAutoLogin } from '../../src/server/auto-login.js'
import type { LoginOptions, LoginOutcome } from '../../src/server/onboarding.js'

const ORIGIN = 'https://api.example.com'

const CONNECTED: LoginOutcome = {
  ok: true,
  stage: { stage: 'connected', apiBaseUrl: ORIGIN, userId: 'user_1', connectorId: 'cxt_1', reusedDevice: false },
}

interface Captured {
  logger: ReturnType<typeof createLogger>
  lines: string[]
}

function capturing(): Captured {
  const lines: string[] = []
  const logger = createLogger('test', (level: LogLevel, _scope: string, message: string) => {
    lines.push(`${level} ${message}`)
  })
  return { logger, lines }
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-auto-login-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the flow is chosen from the machine, never from an env var', () => {
  assert.equal(preferredLoginMode({} as NodeJS.ProcessEnv, 'win32'), 'loopback')
  assert.equal(preferredLoginMode({} as NodeJS.ProcessEnv, 'darwin'), 'loopback')
  assert.equal(preferredLoginMode({} as NodeJS.ProcessEnv, 'linux'), 'device', 'no display server')
  assert.equal(preferredLoginMode({ DISPLAY: ':0' } as NodeJS.ProcessEnv, 'linux'), 'loopback')
  assert.equal(preferredLoginMode({ WAYLAND_DISPLAY: 'wayland-0' } as NodeJS.ProcessEnv, 'linux'), 'loopback')
  // An SSH session has no browser *here*, so its callback could never land.
  assert.equal(preferredLoginMode({ SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } as NodeJS.ProcessEnv, 'darwin'), 'device')
  assert.equal(preferredLoginMode({ SSH_TTY: '/dev/pts/0' } as NodeJS.ProcessEnv, 'linux'), 'device')
  assert.equal(
    preferredLoginMode({ DISPLAY: ':0', SSH_CLIENT: '1.2.3.4 1 22' } as NodeJS.ProcessEnv, 'linux'),
    'device',
  )
})

test('auto login: the loopback prompt reaches the log AND login.json, then settles', async () => {
  await withTempDir(async (dir) => {
    const { logger, lines } = capturing()
    const url = `${ORIGIN}/#/plugin-oauth?state=s&code_challenge=c`
    let headless: boolean | undefined
    const onDisk: Array<Awaited<ReturnType<typeof readLoginPrompt>>> = []

    const result = await runAutoLogin({
      dataDir: dir,
      logger,
      env: {} as NodeJS.ProcessEnv,
      platform: 'win32',
      now: () => 1_000,
      login: async (options: LoginOptions) => {
        headless = options.headless
        await options.onAuthorizationUrl?.(url, { deadline: 11_000, redirectUri: 'http://127.0.0.1:9/oauth/callback' })
        // Readable *during* the flow, before anything settles it.
        onDisk.push(await readLoginPrompt(dir))
        return CONNECTED
      },
    })

    assert.equal(result.mode, 'loopback')
    assert.equal(result.fellBack, false)
    assert.deepEqual(result.attempts, ['loopback'])
    assert.equal(headless, false, 'the graphical path is the browser one')
    const pendingOnDisk = onDisk[0]
    assert.equal(pendingOnDisk?.status, 'pending')
    assert.equal(pendingOnDisk?.authorizationUrl, url)
    assert.equal(pendingOnDisk?.expiresAt, 11_000)

    const loggingIn = lines.find((line) => line.includes(url))
    assert.ok(loggingIn, `no logging_in line in ${JSON.stringify(lines)}`)
    assert.match(loggingIn, /info /)
    assert.ok(loggingIn.includes(loginPromptPath(dir)), 'the line names the file the user can open')

    const settled = await readLoginPrompt(dir)
    assert.equal(settled?.status, 'connected')
    assert.equal(settled?.authorizationUrl, undefined, 'the settled record keeps no URL')
  })
})

test('auto login: an SSH machine gets a device code, written to both surfaces', async () => {
  await withTempDir(async (dir) => {
    const { logger, lines } = capturing()
    const onDisk: Array<Awaited<ReturnType<typeof readLoginPrompt>>> = []
    const result = await runAutoLogin({
      dataDir: dir,
      logger,
      env: { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } as NodeJS.ProcessEnv,
      platform: 'linux',
      now: () => 5,
      login: async (options: LoginOptions) => {
        assert.equal(options.headless, true)
        await options.onCode?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://web.example/#/plugin-device',
          verificationUriComplete: 'https://web.example/#/plugin-device?user_code=ABCD-EFGH',
          expiresAt: 42_000,
          interval: 5,
        })
        onDisk.push(await readLoginPrompt(dir))
        return CONNECTED
      },
    })
    assert.equal(result.mode, 'device')
    const pendingOnDisk = onDisk[0]
    assert.equal(pendingOnDisk?.kind, 'device')
    assert.equal(pendingOnDisk?.userCode, 'ABCD-EFGH')
    assert.equal(pendingOnDisk?.expiresAt, 42_000)
    const loggingIn = lines.find((line) => line.includes('ABCD-EFGH'))
    assert.ok(loggingIn, `no logging_in line in ${JSON.stringify(lines)}`)
    assert.ok(loggingIn.includes('https://web.example/#/plugin-device'))
    assert.ok(loggingIn.includes(loginPromptPath(dir)))
  })
})

test('auto login: a loopback that cannot even bind falls back to the device code', async () => {
  await withTempDir(async (dir) => {
    const { logger, lines } = capturing()
    const modes: boolean[] = []
    const result = await runAutoLogin({
      dataDir: dir,
      logger,
      env: {} as NodeJS.ProcessEnv,
      platform: 'win32',
      login: async (options: LoginOptions) => {
        modes.push(options.headless === true)
        if (options.headless === true) return CONNECTED
        return { ok: false, code: 'unavailable', message: '回环登录监听无法启动：EADDRINUSE' }
      },
    })
    assert.deepEqual(modes, [false, true], 'loopback first, device code second')
    assert.equal(result.mode, 'device')
    assert.equal(result.fellBack, true)
    assert.deepEqual(result.attempts, ['loopback', 'device'])
    assert.equal(result.outcome.ok, true)
    assert.ok(lines.some((line) => line.includes('回环登录无法启动')), JSON.stringify(lines))
  })
})

test('auto login: a denied or timed-out loopback is never answered with a device code', async () => {
  await withTempDir(async (dir) => {
    const modes: boolean[] = []
    const result = await runAutoLogin({
      dataDir: dir,
      logger: capturing().logger,
      env: {} as NodeJS.ProcessEnv,
      platform: 'win32',
      login: async (options: LoginOptions) => {
        modes.push(options.headless === true)
        return { ok: false, code: 'timeout', message: 'the loopback login timed out' }
      },
    })
    assert.deepEqual(modes, [false], 'the user said no / walked away: do not spawn a code at them')
    assert.equal(result.mode, 'loopback')
    assert.equal(result.fellBack, false)
  })
})

test('auto login: a forced flow is honoured and never falls back', async () => {
  await withTempDir(async (dir) => {
    const modes: boolean[] = []
    const forced: LoginMode = 'loopback'
    const result = await runAutoLogin({
      dataDir: dir,
      logger: capturing().logger,
      env: { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } as NodeJS.ProcessEnv,
      platform: 'linux',
      forcedMode: forced,
      login: async (options: LoginOptions) => {
        modes.push(options.headless === true)
        return { ok: false, code: 'unavailable', message: '回环登录监听无法启动：EADDRINUSE' }
      },
    })
    assert.deepEqual(modes, [false], 'an explicit choice is not second-guessed')
    assert.equal(result.fellBack, false)
    assert.equal(result.mode, 'loopback')
  })
})

test('a failed login leaves a terminal record with no code and a next step', async () => {
  await withTempDir(async (dir) => {
    const result = await runAutoLogin({
      dataDir: dir,
      logger: capturing().logger,
      env: {} as NodeJS.ProcessEnv,
      platform: 'win32',
      login: async (options: LoginOptions) => {
        await options.onCode?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://web.example/#/plugin-device',
          verificationUriComplete: 'https://web.example/#/plugin-device?user_code=ABCD-EFGH',
          expiresAt: 42_000,
          interval: 5,
        })
        return { ok: false, code: 'expired_token', message: 'the device code expired' }
      },
      forcedMode: 'device',
    })
    assert.equal(result.outcome.ok, false)
    const record = await readLoginPrompt(dir)
    assert.equal(record?.status, 'failed')
    assert.equal(record?.userCode, undefined)
    assert.match(record?.instruction ?? '', /expired_token/)
    assert.match(record?.instruction ?? '', /README/)
  })
})
