import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ONBOARDING_GLOBAL_KEY,
  Onboarding,
  installOnboarding,
  serverUrlFromEnv,
} from '../../src/server/onboarding.js'
import { judgeConnectorCapability, type ConnectorCapability } from '../../src/server/connector-capability.js'
import { ConnectorOwnershipError, ConnectorSupervisor } from '../../src/server/connector-supervisor.js'
import { readOwnership, setBlocked, setOwnChild } from '../../src/server/connector-ownership.js'
import { createLogger } from '../../src/shared/logger.js'
import { formatDevicePrompt } from '../../src/shared/login-prompt.js'
import { parseLoginMode } from '../../src/shared/plugin-options.js'
import {
  pluginDataDir,
  saveAccount,
  saveBinding,
  type AccountCredential,
} from '../../src/shared/credentials.js'

const SILENT = createLogger('test', () => undefined)

const ORIGIN = 'https://api.example.com'

test('serverUrlFromEnv normalises a valid origin and rejects the rest', () => {
  assert.equal(serverUrlFromEnv({ AGENT_SERVER_URL: 'https://api.example.com/' } as NodeJS.ProcessEnv), ORIGIN)
  assert.equal(serverUrlFromEnv({ AGENT_SERVER_URL: 'https://api.example.com/api/v2' } as NodeJS.ProcessEnv), ORIGIN)
  assert.equal(serverUrlFromEnv({ AGENT_SERVER_URL: 'ftp://api.example.com' } as NodeJS.ProcessEnv), null)
  assert.equal(serverUrlFromEnv({ AGENT_SERVER_URL: 'not a url' } as NodeJS.ProcessEnv), null)
  assert.equal(serverUrlFromEnv({} as NodeJS.ProcessEnv), null)
})

test('autoLoginMode accepts only the two documented triggers', () => {
  assert.equal(parseLoginMode('device'), 'device')
  assert.equal(parseLoginMode(' LOOPBACK '), 'loopback')
  assert.equal(parseLoginMode('yes'), null)
  assert.equal(parseLoginMode(undefined), null)
})

test('formatDeviceNotice carries the URL and the short code', () => {
  const text = formatDevicePrompt(
    {
      version: 1,
      status: 'pending',
      kind: 'device',
      createdAt: 0,
      expiresAt: 0,
      instruction: '',
      verificationUri: 'https://web.example/#/plugin-device',
      verificationUriComplete: 'https://web.example/#/plugin-device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    },
    null,
  )
  assert.match(text, /ABCD-EFGH/)
  assert.match(text, /https:\/\/web\.example/)
})

test('options.serverUrl outranks the env var and settings.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-opt-server-'))
  try {
    const onboarding = new Onboarding({
      logger: SILENT,
      env: { AGENT_CONNECTOR_DATA_DIR: root, AGENT_SERVER_URL: 'https://env.example' } as NodeJS.ProcessEnv,
      serverUrl: 'https://opt.example',
    })
    const stage = await onboarding.resume()
    assert.equal(stage.stage === 'needs_login' && stage.apiBaseUrl, 'https://opt.example')
    assert.equal((await onboarding.status()).apiBaseUrl, 'https://opt.example')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a throwing browser opener is fail-soft: the flow, not the opener, decides the outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-openurl-'))
  try {
    const opened: string[] = []
    const controller = new AbortController()
    const onboarding = new Onboarding({
      logger: SILENT,
      env: { AGENT_CONNECTOR_DATA_DIR: root, AGENT_SERVER_URL: ORIGIN } as NodeJS.ProcessEnv,
      openUrl: async (url) => {
        opened.push(url)
        // Fires the registered abort listener *then* rejects, so one run proves
        // both halves: the opener was called, and its failure reached nothing.
        controller.abort()
        throw new Error('no browser on this machine')
      },
    })
    const prompts: string[] = []
    const outcome = await onboarding.login({
      headless: false,
      signal: controller.signal,
      onAuthorizationUrl: (url) => {
        prompts.push(url)
      },
    })
    assert.equal(opened.length, 1, 'the system browser was launched exactly once')
    assert.match(opened[0] ?? '', /^https:\/\/api\.example\.com\/#\/plugin-oauth\?/)
    assert.equal(prompts.length, 1, 'the URL is handed over before the browser is launched')
    assert.equal(prompts[0], opened[0])
    // 'aborted' (our own signal) — *not* 'login_failed' — proves the opener's
    // rejection was swallowed instead of failing the login.
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.code, 'aborted', JSON.stringify(outcome))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the env server URL reaches a needs_login decision with no settings file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-env-'))
  try {
    const onboarding = new Onboarding({
      logger: SILENT,
      env: { AGENT_CONNECTOR_DATA_DIR: root, AGENT_SERVER_URL: ORIGIN } as NodeJS.ProcessEnv,
    })
    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'needs_login')
    assert.equal(stage.stage === 'needs_login' && stage.apiBaseUrl, ORIGIN)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** A supervisor whose spawn would be observable — and must never run on reuse. */
function spySupervisor(): { supervisor: ConnectorSupervisor; spawns: () => number } {
  let spawns = 0
  const supervisor = new ConnectorSupervisor({
    logger: SILENT,
    sourceDir: join(tmpdir(), 'aa-oc-not-a-real-connector'),
    resolveUv: async () => 'uv',
    spawn: () => {
      spawns += 1
      throw new Error('spawn must not be reached')
    },
  })
  return { supervisor, spawns: () => spawns }
}

/**
 * Resume verifies the stored device credential before using it (the 401 fix).
 * Unit tests must never touch the real network, so every Onboarding built here
 * gets a fetcher that accepts the device token and 404s everything else.
 */
function verifiedFetcher(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const status = url.endsWith('/api/v2/connector/auth') ? 200 : 404
    return new Response('{}', { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

async function seedCredentials(root: string): Promise<void> {
  const dataDir = pluginDataDir({ AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv)
  await saveAccount(dataDir, {
    version: 1,
    apiBaseUrl: ORIGIN,
    userId: 'user_1',
    displayName: 'User One',
    email: null,
    accessToken: 'access-token',
    expiresAt: Date.now() + 3_600_000,
  })
  await saveBinding(dataDir, ORIGIN, 'user_1', {
    version: 1,
    connectorId: 'cxt_1',
    connectorToken: 'connector-token',
    name: 'OpenCode',
    installationId: 'install_1',
  })
}

test('a reuse decision connects without spawning a second Connector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  try {
    await seedCredentials(root)
    const { supervisor, spawns } = spySupervisor()
    const onboarding = new Onboarding({
      logger: SILENT,
      fetcher: verifiedFetcher(),
      env: { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv,
      supervisor,
      probeConnector: async () => ({ decision: 'reuse', reason: '本机已有', kind: 'opencode-plugin', pid: 4242 }),
      // Task B: reuse also requires the Connector to advertise `opencode`.
      probeConnectorCapability: async () => ({
        verdict: 'reuse',
        runtimeTypes: ['opencode'],
        reason: '该 Connector 上报的 runtime 类型包含 opencode',
      }),
    })
    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(stage.stage === 'connected' && stage.reusedDevice, true)
    assert.equal(spawns(), 0, 'reuse must never spawn')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** A live, in-record Connector whose advertised runtime types the test chooses. */
function gateProbe(
  runtimeTypes: string[] | null,
  calls: string[],
): (input: { account: AccountCredential; connectorId: string }) => Promise<ConnectorCapability> {
  return async (input) => {
    calls.push(input.connectorId)
    // The real pure verdict — only the transport is faked here.
    return judgeConnectorCapability({ runtimeTypes })
  }
}

/**
 * Resume with a "live, bound to our device" reuse probe and a chosen capability
 * answer. `spawns`/`gateCalls` are the observable evidence for which branch ran.
 */
async function resumeWithGate(
  root: string,
  runtimeTypes: string[] | null,
  extra: { forceReuseConnector?: boolean } = {},
): Promise<{ stage: Awaited<ReturnType<Onboarding['resume']>>; spawns: number; gateCalls: string[] }> {
  const { supervisor, spawns } = spySupervisor()
  const gateCalls: string[] = []
  const onboarding = new Onboarding({
    logger: SILENT,
    env: { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv,
    supervisor,
    probeConnector: async () => ({ decision: 'reuse', reason: '本机已有', kind: 'desktop', pid: 9016 }),
    probeConnectorCapability: gateProbe(runtimeTypes, gateCalls),
    ...(extra.forceReuseConnector !== undefined ? { forceReuseConnector: extra.forceReuseConnector } : {}),
  })
  const stage = await onboarding.resume()
  return { stage, spawns: spawns(), gateCalls }
}

test('B: a Connector that knows opencode is reused (no spawn)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  try {
    await seedCredentials(root)
    const { stage, spawns, gateCalls } = await resumeWithGate(root, ['opencode', 'codex'])
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(stage.stage === 'connected' && stage.reusedDevice, true)
    assert.equal(spawns, 0)
    assert.deepEqual(gateCalls, ['cxt_1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('B: the desktop-bundled Connector (no opencode) is NOT reused — we start our own', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  try {
    await seedCredentials(root)
    const { stage, spawns, gateCalls } = await resumeWithGate(root, ['codex', 'claude', 'dsh'])
    // The spy supervisor cannot actually start (its source dir is a placeholder),
    // so reaching it at all is the evidence that the reuse shortcut was skipped.
    assert.equal(stage.stage, 'needs_login', JSON.stringify(stage))
    assert.match(stage.stage === 'needs_login' ? stage.reason : '', /connector failed to start/)
    assert.equal(spawns, 0, 'the spy throws before spawning')
    assert.deepEqual(gateCalls, ['cxt_1'], 'the capability gate was consulted')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('B: an undecidable Connector is conservatively NOT reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  try {
    await seedCredentials(root)
    const { stage, gateCalls } = await resumeWithGate(root, null)
    assert.equal(stage.stage, 'needs_login', JSON.stringify(stage))
    assert.match(stage.stage === 'needs_login' ? stage.reason : '', /connector failed to start/)
    assert.deepEqual(gateCalls, ['cxt_1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('B: forceReuseConnector skips the capability gate and reuses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-reuse-'))
  try {
    await seedCredentials(root)
    const { stage, spawns, gateCalls } = await resumeWithGate(root, ['codex'], { forceReuseConnector: true })
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(stage.stage === 'connected' && stage.reusedDevice, true)
    assert.equal(spawns, 0)
    assert.deepEqual(gateCalls, [], 'the explicit opt-in must not even ask')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a none decision falls through to the spawn path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-spawn-'))
  try {
    await seedCredentials(root)
    const { supervisor } = spySupervisor()
    const onboarding = new Onboarding({
      logger: SILENT,
      fetcher: verifiedFetcher(),
      env: { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv,
      supervisor,
      probeConnector: async () => ({ decision: 'none', reason: '无', kind: null, pid: null }),
    })
    const stage = await onboarding.resume()
    // The invalid source dir makes `prepare()` fail, which is exactly how we
    // observe that the spawn path (not the reuse shortcut) was taken.
    assert.equal(stage.stage, 'needs_login', JSON.stringify(stage))
    assert.match(stage.stage === 'needs_login' ? stage.reason : '', /connector failed to start/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Connector we already started is adopted across reloads — no second spawn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-own-'))
  try {
    await seedCredentials(root)
    const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv
    // What a previous setup()/hot reload left behind: our own live child.
    await setOwnChild(join(pluginDataDir(env), 'connector'), {
      pid: process.pid,
      connectorId: 'cxt_1',
      childStatePath: '',
      spawnedAt: Date.now(),
    })
    const { supervisor, spawns } = spySupervisor()
    const onboarding = new Onboarding({
      logger: SILENT,
      fetcher: verifiedFetcher(),
      env,
      supervisor,
      // 'none' would take the spawn path if adoption did not run first.
      probeConnector: async () => ({ decision: 'none', reason: '无', kind: null, pid: null }),
    })
    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(stage.stage === 'connected' && stage.reusedDevice, true)
    assert.equal(spawns(), 0, 'adoption must never spawn a second Connector')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a refused spawn (lease held elsewhere) records the holder for later setups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-blocked-'))
  try {
    await seedCredentials(root)
    const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv
    const supervisor = {
      running: false,
      prepare: async () => undefined,
      start: async () => {
        throw new ConnectorOwnershipError('本机已有另一个 Connector 在运行', { kind: 'desktop-workbench', pid: 4242 })
      },
      stop: async () => undefined,
    } as unknown as ConnectorSupervisor
    const onboarding = new Onboarding({
      logger: SILENT,
      fetcher: verifiedFetcher(),
      env,
      supervisor,
      probeConnector: async () => ({ decision: 'occupied', reason: '其它来源占用', kind: 'desktop-workbench', pid: 4242 }),
    })
    const stage = await onboarding.resume()
    // The existing contract: a held machine-wide lease still counts as connected.
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    const blocked = (await readOwnership(join(pluginDataDir(env), 'connector'))).blocked
    assert.equal(blocked?.pid, 4242)
    assert.equal(blocked?.kind, 'desktop-workbench')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a recorded live foreign block skips the spawn on the next setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-blocked-skip-'))
  try {
    await seedCredentials(root)
    const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv
    await setBlocked(join(pluginDataDir(env), 'connector'), {
      kind: 'desktop-workbench',
      pid: process.pid, // live
      connectorId: 'cxt_1',
      at: Date.now(),
    })
    const { supervisor, spawns } = spySupervisor()
    const onboarding = new Onboarding({
      logger: SILENT,
      fetcher: verifiedFetcher(),
      env,
      supervisor,
      // 'none' would take the spawn path if the block check did not run first.
      probeConnector: async () => ({ decision: 'none', reason: '无', kind: null, pid: null }),
    })
    const stage = await onboarding.resume()
    assert.equal(stage.stage, 'connected', JSON.stringify(stage))
    assert.equal(spawns(), 0, 'a known-doomed spawn must not be repeated')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('installOnboarding adopts a structurally-equal prior instance (hot reload changes class identity)', async () => {
  const key = Symbol.for(ONBOARDING_GLOBAL_KEY)
  const globals = globalThis as unknown as Record<symbol, unknown>
  const previous = globals[key]
  const fake = {
    resume: async () => ({ stage: 'disabled', reason: 'x' }),
    status: async () => ({}),
    supervisor: {},
  }
  globals[key] = fake
  try {
    // `fake` is NOT `instanceof` this module's Onboarding (the reload case), so
    // only the structural check can adopt it.
    assert.equal(installOnboarding({ logger: SILENT }), fake)
  } finally {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  }
})
