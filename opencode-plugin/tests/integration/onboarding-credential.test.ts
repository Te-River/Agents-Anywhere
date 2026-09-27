/**
 * The real-machine defect this file pins down:
 *
 *   local `connectorToken` ≠ server `token_hash` → the Connector's
 *   `Authorization: Connector …` is answered 401 → the device stays `offline`
 *   forever, silently.
 *
 * Every test here uses an injected fake server and a fake supervisor: no real
 * login, no spawned process. The four contracts:
 *   1. a stale device token is verified before use and rotated (self-heal);
 *   2. concurrent resume/login flows rotate at most once and register once;
 *   3. a 401 is visible in the log, `login.json` and `status()` — with a next
 *      step — instead of a bare `offline`;
 *   4. concurrency (two Onboarding instances, i.e. a reload/second process)
 *      never leaves the disk holding a token the server has replaced.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Onboarding } from '../../src/server/onboarding.js'
import type { ConnectorSpawnConfig, ConnectorSupervisor, SupervisorState } from '../../src/server/connector-supervisor.js'
import { createLogger, type Logger } from '../../src/shared/logger.js'
import { loginPromptPath, readLoginPrompt } from '../../src/shared/login-prompt.js'
import {
  pendingRegistrationPath,
  pluginDataDir,
  readBinding,
  saveAccount,
  saveBinding,
  writeJsonAtomic,
} from '../../src/shared/credentials.js'

const SILENT = createLogger('test', () => undefined)

const DEVICE_ID = 'conn_1'
const USER_ID = 'user_1'

interface DeviceServer {
  origin: string
  /** The only device token the server will accept — held by no one but the test. */
  deviceToken: string
  registrations: number
  revokes: string[]
  authCalls: number
  /** First N `/connector/auth` calls answer 503, i.e. "cannot verify". */
  authUnavailableFirst: number
  revokeFails: boolean
  close(): Promise<void>
}

async function startDeviceServer(): Promise<DeviceServer> {
  const state = {
    // Deliberately *different* from any token seeded on disk: the server has
    // rotated since, which is exactly the real-machine 401 this file pins down.
    deviceToken: 'server-current-token',
    registrations: 0,
    revokes: [] as string[],
    authCalls: 0,
    authUnavailableFirst: 0,
    revokeFails: false,
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/'
    request.on('data', () => undefined)
    request.on('end', () => {
      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload))
      }
      const device = { id: DEVICE_ID, name: 'OpenCode (test)', userId: USER_ID }
      if (url === '/api/v2/connector/auth') {
        state.authCalls += 1
        if (state.authCalls <= state.authUnavailableFirst) return json(503, { error: 'temporarily unavailable' })
        const authorization = request.headers['authorization'] ?? ''
        const token = authorization.startsWith('Connector ') ? authorization.slice('Connector '.length).split(':')[1] : undefined
        if (token === state.deviceToken) return json(200, { accessToken: 'connector-access', expiresIn: 3600 })
        return json(401, { error: 'invalid connector credential' })
      }
      if (url === '/api/v2/connectors' && request.method === 'POST') {
        state.registrations += 1
        state.deviceToken = `token-${state.registrations}`
        return json(200, { connector: device, connectorToken: state.deviceToken })
      }
      if (url.startsWith(`/api/v2/connectors/${DEVICE_ID}/revoke`)) {
        if (state.revokeFails) return json(500, { error: 'rotate failed' })
        state.revokes.push(DEVICE_ID)
        state.deviceToken = `rotated-${state.revokes.length}`
        return json(200, { connector: device, connectorToken: state.deviceToken })
      }
      if (url === '/api/v2/oauth/device/code') {
        return json(200, {
          device_code: 'device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://web.example/#/plugin-device',
          verification_uri_complete: 'https://web.example/#/plugin-device?user_code=ABCD-EFGH',
          expires_in: 600,
          interval: 1,
        })
      }
      if (url === '/api/v2/oauth/device/token') {
        return json(200, { access_token: 'access-token', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url === '/api/v2/auth/me') return json(200, { userId: USER_ID, displayName: 'User One', email: null })
      return json(404, { error: 'not_found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    get deviceToken() { return state.deviceToken },
    get registrations() { return state.registrations },
    get revokes() { return state.revokes },
    get authCalls() { return state.authCalls },
    set authUnavailableFirst(value: number) { state.authUnavailableFirst = value },
    set revokeFails(value: boolean) { state.revokeFails = value },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

interface Sandbox {
  root: string
  dataDir: string
  connectorDir: string
  env: NodeJS.ProcessEnv
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-credential-'))
  const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv
  const dataDir = pluginDataDir(env)
  return { root, dataDir, connectorDir: join(dataDir, 'connector'), env }
}

/** The seeded account + the stale device credential the bug is about. */
async function seedCredentials(box: Sandbox, server: DeviceServer, token: string): Promise<void> {
  await saveAccount(box.dataDir, {
    version: 1,
    apiBaseUrl: server.origin,
    userId: USER_ID,
    displayName: 'User One',
    email: null,
    accessToken: 'access-token',
    expiresAt: Date.now() + 3_600_000,
  })
  await saveBinding(box.dataDir, server.origin, USER_ID, {
    version: 1,
    connectorId: DEVICE_ID,
    connectorToken: token,
    name: 'OpenCode (test)',
    installationId: 'install-1',
  })
}

interface RecordingSupervisor {
  supervisor: ConnectorSupervisor
  started: ConnectorSpawnConfig[]
  /** Fire the exact state notification the real supervisor emits on a 401. */
  emit: (state: SupervisorState) => void
}

/** A supervisor double: records what the Connector was told, accepts a listener. */
function recordingSupervisor(): RecordingSupervisor {
  const started: ConnectorSpawnConfig[] = []
  let listener: ((state: SupervisorState) => void) | undefined
  const supervisor = {
    running: false,
    prepare: async () => undefined,
    start: async (config: ConnectorSpawnConfig) => {
      started.push(config)
    },
    stop: async () => undefined,
    attachStateListener: (next: (state: SupervisorState) => void) => {
      listener = next
    },
  }
  return {
    supervisor: supervisor as unknown as ConnectorSupervisor,
    started,
    emit: (state) => listener?.(state),
  }
}

function capturedLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = []
  const logger = createLogger('test', (level, _scope, message) => {
    if (level === 'warn' || level === 'error') warnings.push(message)
  })
  return { logger, warnings }
}

/** A Connector probe that says "nothing here" without touching the machine. */
const NO_PROBE = async (): Promise<{ decision: 'none'; reason: string; kind: null; pid: null }> => ({
  decision: 'none',
  reason: 'test',
  kind: null,
  pid: null,
})

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('adopt: a Connector adopted from an earlier process with an old token is stopped and restarted', async () => {
  const box = await sandbox()
  const server = await startDeviceServer()
  try {
    // The binding is already current (the server accepts it)…
    await seedCredentials(box, server, 'server-current-token')
    // …but the Connector we started in an earlier process still runs on an old
    // token baked into its connector.json, so it can only ever answer 401.
    await writeJsonAtomic(join(box.connectorDir, 'owner.json'), {
      child: { pid: process.pid, connectorId: DEVICE_ID, childStatePath: '', spawnedAt: Date.now() },
    })
    await writeJsonAtomic(join(box.connectorDir, 'connector.json'), {
      connectorId: DEVICE_ID,
      connectorToken: 'stale-token',
    })
    const stopped: number[] = []
    const { supervisor, started } = recordingSupervisor()
    const onboarding = new Onboarding({
      logger: SILENT,
      env: box.env,
      supervisor,
      probeConnector: NO_PROBE,
      // Never signal a real pid in a test: the seam records the decision.
      stopOwnConnector: (pid) => stopped.push(pid),
    })

    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.deepEqual(stopped, [process.pid], 'our own stale orphan was stopped')
    assert.equal(server.authCalls, 1, 'the binding itself was valid — nothing rotated')
    assert.deepEqual(server.revokes, [])
    assert.equal(started.length, 1, 'the Connector was restarted')
    assert.equal(started[0]?.connectorToken, 'server-current-token')
  } finally {
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

test('自愈: a stale device token is rotated before the Connector starts (server response wins)', async () => {
  const box = await sandbox()
  const server = await startDeviceServer()
  try {
    await seedCredentials(box, server, 'stale-token')
    const { supervisor, started } = recordingSupervisor()
    const onboarding = new Onboarding({
      logger: SILENT,
      env: box.env,
      supervisor,
      probeConnector: NO_PROBE,
    })

    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(server.authCalls, 1, 'the stored token was actually checked')
    assert.deepEqual(server.revokes, [DEVICE_ID], 'the same device was rotated, not replaced')
    assert.equal(server.registrations, 0, 'healing a token must never register a second device')
    assert.equal(server.deviceToken, 'rotated-1')

    const binding = await readBinding(box.dataDir, server.origin, USER_ID)
    assert.equal(binding?.connectorToken, 'rotated-1', 'the local file holds the server-issued token')
    assert.equal(binding?.connectorId, DEVICE_ID)
    assert.equal(started.length, 1)
    assert.equal(started[0]?.connectorToken, 'rotated-1', 'the Connector was started with the rotated token')
    assert.equal(await onboarding.status().then((status) => status.credentialProblem), null)
  } finally {
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

test('并发/重载: two instances resuming together rotate exactly once and agree with the server', async () => {
  const box = await sandbox()
  const server = await startDeviceServer()
  try {
    await seedCredentials(box, server, 'stale-token')
    const first = recordingSupervisor()
    const second = recordingSupervisor()
    const one = new Onboarding({ logger: SILENT, env: box.env, supervisor: first.supervisor, probeConnector: NO_PROBE })
    const two = new Onboarding({ logger: SILENT, env: box.env, supervisor: second.supervisor, probeConnector: NO_PROBE })

    const [stageOne, stageTwo] = await Promise.all([one.resume(), two.resume()])
    assert.equal(stageOne.stage, 'connected', JSON.stringify(stageOne))
    assert.equal(stageTwo.stage, 'connected', JSON.stringify(stageTwo))
    assert.deepEqual(server.revokes, [DEVICE_ID], 'one rotation, not two')
    assert.equal(server.registrations, 0)
    assert.equal(server.deviceToken, 'rotated-1')

    const binding = await readBinding(box.dataDir, server.origin, USER_ID)
    assert.equal(binding?.connectorToken, server.deviceToken, 'disk and server agree')
    for (const config of [...first.started, ...second.started]) {
      assert.equal(config.connectorToken, server.deviceToken, 'no Connector was launched with the old token')
    }
  } finally {
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

test('注册幂等: two concurrent logins register one device and rotate nothing', async () => {
  const box = await sandbox()
  const server = await startDeviceServer()
  try {
    const first = recordingSupervisor()
    const second = recordingSupervisor()
    const one = new Onboarding({ logger: SILENT, env: box.env, supervisor: first.supervisor, probeConnector: NO_PROBE })
    const two = new Onboarding({ logger: SILENT, env: box.env, supervisor: second.supervisor, probeConnector: NO_PROBE })

    const [loginOne, loginTwo] = await Promise.all([
      one.login({ headless: true, apiBaseUrl: server.origin, pollSleep: async () => undefined }),
      two.login({ headless: true, apiBaseUrl: server.origin, pollSleep: async () => undefined }),
    ])
    assert.equal(loginOne.ok, true, JSON.stringify(loginOne))
    assert.equal(loginTwo.ok, true, JSON.stringify(loginTwo))
    assert.equal(server.registrations, 1, 'exactly one device was created')
    assert.deepEqual(server.revokes, [], 'a fresh registration must not rotate anything')
    assert.equal(server.deviceToken, 'token-1')

    const binding = await readBinding(box.dataDir, server.origin, USER_ID)
    assert.equal(binding?.connectorToken, 'token-1', 'the server-issued token is what was saved')
    assert.equal(binding?.connectorId, DEVICE_ID)
    for (const config of [...first.started, ...second.started]) {
      assert.equal(config.connectorToken, 'token-1')
    }
    // The registration intent file disappears only once the credential exists.
    await assert.rejects(
      access(pendingRegistrationPath(box.dataDir, server.origin, USER_ID)),
      /ENOENT/,
    )
  } finally {
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

test('失败可见: an unrepairable 401 reaches the log, login.json and status() with a next step', async () => {
  const box = await sandbox()
  const server = await startDeviceServer()
  try {
    await seedCredentials(box, server, 'stale-token')
    // The pre-spawn check cannot reach the server, so the stale token is used…
    server.authUnavailableFirst = 1
    // …and the repair also fails: the rotation endpoint is down.
    server.revokeFails = true
    const { supervisor, started, emit } = recordingSupervisor()
    const { logger, warnings } = capturedLogger()
    const onboarding = new Onboarding({ logger, env: box.env, supervisor, probeConnector: NO_PROBE })

    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(started.length, 1, 'the stale credential was used while it could not be verified')

    // The exact signal the real supervisor emits when the server answers 401.
    emit({ running: false, authFailed: true })

    await waitFor(async () => (await onboarding.status()).credentialProblem !== null, 'credentialProblem')
    await waitFor(async () => (await readLoginPrompt(box.dataDir))?.status === 'failed', 'failed login.json')

    const status = await onboarding.status()
    assert.match(status.credentialProblem ?? '', /HTTP 401/)
    assert.match(status.credentialProblem ?? '', /\/aa-login/)
    const prompt = await readLoginPrompt(box.dataDir)
    assert.equal(prompt?.status, 'failed')
    assert.match(prompt?.instruction ?? '', /HTTP 401/)
    assert.match(prompt?.instruction ?? '', /下一步/)
    assert.ok(
      warnings.some((line) => line.includes('HTTP 401')),
      `the 401 reached the log: ${JSON.stringify(warnings)}`,
    )
    assert.ok(
      warnings.some((line) => line.includes('自动修复设备凭据失败')),
      `the failed repair is reported: ${JSON.stringify(warnings)}`,
    )
    assert.equal(loginPromptPath(box.dataDir), join(box.dataDir, 'login.json'))
  } finally {
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

test('401 后自愈: a Connector-reported auth failure is repaired and restarted with the new token', async () => {
  const box = await sandbox()
  const server = await startDeviceServer()
  try {
    await seedCredentials(box, server, 'stale-token')
    // Unverifiable at resume time (503), definitively rejected at repair time (401).
    server.authUnavailableFirst = 1
    const { supervisor, started, emit } = recordingSupervisor()
    const { logger, warnings } = capturedLogger()
    const onboarding = new Onboarding({ logger, env: box.env, supervisor, probeConnector: NO_PROBE })

    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(started[0]?.connectorToken, 'stale-token')

    emit({ running: false, authFailed: true })
    await waitFor(async () => started.length >= 2, 'the Connector restart')

    assert.deepEqual(server.revokes, [DEVICE_ID])
    assert.equal(server.registrations, 0)
    assert.equal(started[1]?.connectorToken, server.deviceToken, 'the restart carries the repaired token')
    const binding = await readBinding(box.dataDir, server.origin, USER_ID)
    assert.equal(binding?.connectorToken, server.deviceToken)
    assert.equal((await onboarding.status()).credentialProblem, null, 'the problem clears once repaired')
    assert.ok(warnings.some((line) => line.includes('HTTP 401')))

    await waitFor(async () => (await readLoginPrompt(box.dataDir))?.status === 'connected', 'recovered login.json')
    const prompt = await readLoginPrompt(box.dataDir)
    assert.match(prompt?.instruction ?? '', /自动修复/)
  } finally {
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})
