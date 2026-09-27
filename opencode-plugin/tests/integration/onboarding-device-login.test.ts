import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Onboarding } from '../../src/server/onboarding.js'
import { ConnectorSupervisor, type ConnectorLauncher } from '../../src/server/connector-supervisor.js'
import { createLogger } from '../../src/shared/logger.js'
import { pluginDataDir, readAccount, readBinding, saveAccount, saveBinding } from '../../src/shared/credentials.js'

const SILENT = createLogger('test', () => undefined)

/** A Node "connector" that speaks the same NDJSON JSON-RPC the Python one does. */
const FAKE_CONNECTOR = `
import { createInterface } from 'node:readline'
const readline = createInterface({ input: process.stdin })
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }
function state(running) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'connector/state', params: { running, authFailed: false } }) + '\\n') }
let started = false
readline.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.method === 'connector.getState') { reply(frame.id, { running: started, authFailed: false }); return }
  if (frame.method === 'connector.start') { started = true; state(true); reply(frame.id, { running: true, authFailed: false }); return }
  if (frame.method === 'connector.stop') { started = false; state(false); reply(frame.id, { running: false, authFailed: false }); return }
  reply(frame.id, {})
})
`

interface FakeServer {
  origin: string
  deviceTokenCalls: number
  revokes: string[]
  close(): Promise<void>
}

async function startFakeServer(userId = 'user_1', advertisedRuntimes: string[] = ['opencode']): Promise<FakeServer> {
  const state = { deviceTokenCalls: 0, revokes: [] as string[] }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/'
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const json = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload))
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
        state.deviceTokenCalls += 1
        if (state.deviceTokenCalls === 1) return json(400, { error: 'authorization_pending' })
        return json(200, { access_token: 'access-token', expires_in: 3600, token_type: 'Bearer' })
      }
      if (url === '/api/v2/auth/me') return json(200, { userId, displayName: 'User One', email: null })
      if (url.endsWith('/runtime-types')) {
        const id = url.slice('/api/v2/connectors/'.length, -'/runtime-types'.length)
        return json(200, {
          connectorId: id,
          runtimeTypes: advertisedRuntimes.map((runtimeType) => ({ runtimeType })),
          serverTime: new Date().toISOString(),
        })
      }
      if (url === '/api/v2/connectors' && request.method === 'POST') {
        return json(200, { connector: { id: 'cxt_1', name: 'OpenCode (host)', userId }, connectorToken: 'connector-token-value' })
      }
      if (url.startsWith('/api/v2/connectors/') && url.endsWith('/revoke')) {
        const id = url.slice('/api/v2/connectors/'.length, -'/revoke'.length)
        state.revokes.push(id)
        return json(200, { connector: { id, name: 'OpenCode (host)', userId }, connectorToken: 'rotated-token' })
      }
      if (url.startsWith('/api/v2/connectors/')) return json(404, { error: 'not_found' })
      void body
      return json(404, { error: 'not_found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    get deviceTokenCalls() { return state.deviceTokenCalls },
    get revokes() { return state.revokes },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

interface Sandbox {
  root: string
  dataDir: string
  sourceDir: string
  fakeConnector: string
}

async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-onboard-'))
  const dataDir = join(root, 'data')
  const sourceDir = join(root, 'connector')
  await mkdir(join(sourceDir, 'connector'), { recursive: true })
  await writeFile(join(sourceDir, 'pyproject.toml'), '[project]\nname = "anywhere-cli"\n', 'utf8')
  await writeFile(join(sourceDir, 'connector', 'cli.py'), '# fake\n', 'utf8')
  const fakeConnector = join(root, 'fake-connector.mjs')
  await writeFile(fakeConnector, FAKE_CONNECTOR, 'utf8')
  return { root, dataDir, sourceDir, fakeConnector }
}

/** A supervisor whose "uv" is this Node binary and whose Connector is the fake. */
function fakeSupervisor(box: Sandbox, spawned?: import('node:child_process').ChildProcess[]): ConnectorSupervisor {
  const launch: ConnectorLauncher = (_command, args, options) => {
    const configPath = args[args.indexOf('--config') + 1]
    // The child inherits the real environment: the plugin always runs inside a
    // full host environment, and a partial env breaks spawn on Windows.
    const child = spawn(process.execPath, [box.fakeConnector, '--config', configPath ?? ''], options)
    spawned?.push(child)
    return child
  }
  return new ConnectorSupervisor({
    logger: SILENT,
    sourceDir: box.sourceDir,
    spawn: launch,
    resolveUv: async () => process.execPath,
  })
}

test('one command: headless device login → account + device + Connector, then logout revokes first', async () => {
  const box = await sandbox()
  const server = await startFakeServer()
  const spawned: import('node:child_process').ChildProcess[] = []
  const supervisor = fakeSupervisor(box, spawned)
  const onboarding = new Onboarding({
    logger: SILENT,
    env: { AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv,
    supervisor,
  })
  try {
    const codes: string[] = []
    const outcome = await onboarding.login({
      headless: true,
      apiBaseUrl: server.origin,
      onCode: (notice) => { codes.push(notice.userCode) },
      pollSleep: async () => undefined,
    })
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(outcome.ok && outcome.stage.connectorId, 'cxt_1')
    assert.equal(outcome.ok && outcome.stage.reusedDevice, false)
    assert.deepEqual(codes, ['ABCD-EFGH'])
    assert.ok(server.deviceTokenCalls >= 2, 'the pending poll was retried')

    const dir = pluginDataDir({ AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv)
    const account = await readAccount(dir)
    assert.equal(account?.userId, 'user_1')
    assert.equal(account?.apiBaseUrl, server.origin)
    const binding = await readBinding(dir, server.origin, 'user_1')
    assert.equal(binding?.connectorId, 'cxt_1')
    assert.equal(binding?.connectorToken, 'connector-token-value')

    const connectorConfig = JSON.parse(await readFile(join(pluginDataDir({ AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv), 'connector', 'connector.json'), 'utf8')) as Record<string, unknown>
    assert.equal(connectorConfig['connectorId'], 'cxt_1')
    assert.equal(connectorConfig['serverUrl'], server.origin)

    // A fresh Onboarding (new supervisor) with the shared record mentioning the
    // device resumes with zero login.
    await writeFile(join(box.dataDir, 'connector-runtime.json'), JSON.stringify({ version: 2, connectorIds: ['cxt_1'] }), 'utf8')
    const second = new Onboarding({
      logger: SILENT,
      env: { AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv,
      supervisor: fakeSupervisor(box, spawned),
    })
    const resumed = await second.resume()
    assert.equal(resumed.stage, 'connected', JSON.stringify(resumed))
    assert.equal(resumed.reusedDevice, true, JSON.stringify(resumed))
    await second.supervisor.stop()

    // Logout: revoke on the server happens before the local credentials vanish.
    await onboarding.logout()
    assert.deepEqual(server.revokes, ['cxt_1'])
    assert.equal(await readAccount(dir), null)
    assert.equal(await readBinding(dir, server.origin, 'user_1'), null)
    assert.equal(supervisor.running, false)
  } finally {
    await supervisor.stop().catch(() => undefined)
    // A spawned fake Connector is an OS process: reap every one of them so the
    // test runner never inherits a live handle.
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})

test('a machine with no configured server reports needs_login instead of failing', async () => {
  const box = await sandbox()
  // `serverUrlFiles: []` = "this machine really has nothing": the test must not
  // read the developer's own Desktop config (defect ①'s new sources).
  const onboarding = new Onboarding({
    logger: SILENT,
    env: { AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv,
    serverUrlFiles: [],
  })
  try {
    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'needs_login')
    assert.equal(stage.stage === 'needs_login' && stage.apiBaseUrl, null)
    const outcome = await onboarding.login({ headless: true })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.code, 'not_configured')
  } finally {
    await onboarding.supervisor.stop().catch(() => undefined)
    await rm(box.root, { recursive: true, force: true })
  }
})

test('B: a running Connector that does not advertise opencode is not reused — our own Connector is started', async () => {
  const box = await sandbox()
  // The desktop-bundled Connector this bug is about: it reports Codex/Claude only.
  const server = await startFakeServer('user_1', ['codex', 'claude', 'dsh'])
  const spawned: import('node:child_process').ChildProcess[] = []
  const supervisor = fakeSupervisor(box, spawned)
  const dataDir = pluginDataDir({ AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv)
  try {
    await saveAccount(dataDir, {
      version: 1,
      apiBaseUrl: server.origin,
      userId: 'user_1',
      displayName: 'User One',
      email: null,
      accessToken: 'access-token',
      expiresAt: Date.now() + 3_600_000,
    })
    await saveBinding(dataDir, server.origin, 'user_1', {
      version: 1,
      connectorId: 'cxt_1',
      connectorToken: 'connector-token-value',
      name: 'OpenCode (host)',
      installationId: 'install_1',
    })
    // A live machine-wide record that already lists our device — the reuse signal.
    await writeFile(
      join(box.dataDir, 'connector-runtime.json'),
      JSON.stringify({ version: 2, connectorIds: ['cxt_1'], runtime: { pid: process.pid, kind: 'desktop' } }),
      'utf8',
    )
    const onboarding = new Onboarding({
      logger: SILENT,
      env: { AGENT_CONNECTOR_DATA_DIR: box.dataDir } as NodeJS.ProcessEnv,
      supervisor,
    })
    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    // Not a reuse: we own the Connector that just started, and it is ours.
    assert.equal(stage.reusedDevice, false, JSON.stringify(stage))
    assert.equal(spawned.length, 1, 'exactly one (our own) Connector was launched')
    await onboarding.supervisor.stop()
  } finally {
    await supervisor.stop().catch(() => undefined)
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    await server.close()
    await rm(box.root, { recursive: true, force: true })
  }
})
