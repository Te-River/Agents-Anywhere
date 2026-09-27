import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACCOUNT_FILE,
  BINDINGS_DIR,
  accountIsUsable,
  bindingPath,
  clearAccount,
  clearBinding,
  clearPendingFlow,
  clearPendingRegistration,
  connectorRuntimePath,
  pendingFlowIsLive,
  pendingRegistrationPath,
  pluginDataDir,
  readAccount,
  readBinding,
  readConnectorRuntime,
  readPendingFlow,
  readPendingRegistration,
  readSettings,
  runtimeMentionsConnector,
  saveAccount,
  saveBinding,
  savePendingFlow,
  savePendingRegistration,
  saveSettings,
  serverKey,
  accountKey,
  writeJsonAtomic,
  type AccountCredential,
} from '../../src/shared/credentials.js'

function readFileText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-cred-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const account = (overrides: Partial<AccountCredential> = {}): AccountCredential => ({
  version: 1,
  apiBaseUrl: 'https://api.example.com',
  userId: 'user_1',
  displayName: 'User One',
  email: null,
  accessToken: 'access-token-value',
  expiresAt: Date.now() + 3_600_000,
  ...overrides,
})

test('pluginDataDir honours AGENT_CONNECTOR_DATA_DIR and defaults under ~/.agents-anywhere', () => {
  const overridden = pluginDataDir({ AGENT_CONNECTOR_DATA_DIR: 'D:/aa-data' } as NodeJS.ProcessEnv)
  assert.equal(overridden.replaceAll('\\', '/'), 'D:/aa-data/opencode-plugin')
  const fallback = pluginDataDir({} as NodeJS.ProcessEnv)
  assert.ok(fallback.replaceAll('\\', '/').endsWith('/.agents-anywhere/opencode-plugin'))
  assert.ok(connectorRuntimePath({} as NodeJS.ProcessEnv).replaceAll('\\', '/').endsWith('/.agents-anywhere/connector-runtime.json'))
})

test('serverKey is stable and the binding path is <serverKey>/<accountId>.json', () => {
  assert.equal(serverKey('https://api.example.com'), serverKey('https://api.example.com/'))
  assert.notEqual(serverKey('https://api.example.com'), serverKey('https://other.example.com'))
  const path = bindingPath('/data', 'https://api.example.com', 'user/../1').replaceAll('\\', '/')
  assert.equal(path, `/data/${BINDINGS_DIR}/${serverKey('https://api.example.com')}/user_.._1.json`)
  // A value that would collapse the filename is hashed instead of escaping the dir.
  assert.equal(accountKey('..'), accountKey('..'))
  assert.ok(/^acct_[0-9a-f]{24}$/.test(accountKey('..')))
})

test('writeJsonAtomic publishes a complete file with no temp residue', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'nested', 'value.json')
    await writeJsonAtomic(target, { a: 1 })
    await writeJsonAtomic(target, { a: 2 })
    const entries = await readdir(join(dir, 'nested'))
    assert.deepEqual(entries, ['value.json'])
    assert.deepEqual(JSON.parse(await readFileText(target)), { a: 2 })
  })
})

test('credentials are written 0600 on POSIX', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mode bits are not enforced by the Windows ACL model')
    return
  }
  await withTempDir(async (dir) => {
    await saveAccount(dir, account())
    const info = await stat(join(dir, ACCOUNT_FILE))
    assert.equal(info.mode & 0o777, 0o600)
  })
})

test('settings round-trip carries only the api base url', async () => {
  await withTempDir(async (dir) => {
    await saveSettings(dir, 'https://api.example.com')
    assert.deepEqual(await readSettings(dir), { version: 1, apiBaseUrl: 'https://api.example.com' })
    const raw = await readSettings(dir)
    assert.deepEqual(Object.keys(raw!).sort(), ['apiBaseUrl', 'version'])
  })
})

test('readAccount rejects a record with no usable token and clearAccount removes it', async () => {
  await withTempDir(async (dir) => {
    await saveAccount(dir, account())
    assert.equal((await readAccount(dir))?.userId, 'user_1')
    await writeFile(join(dir, ACCOUNT_FILE), JSON.stringify({ ...account(), accessToken: '' }), 'utf8')
    assert.equal(await readAccount(dir), null)
    await clearAccount(dir)
    assert.equal(await readAccount(dir), null)
  })
})

test('accountIsUsable applies the 60s expiry skew', () => {
  const now = 1_000_000
  assert.equal(accountIsUsable(account({ expiresAt: now + 61_000 }), now), true)
  assert.equal(accountIsUsable(account({ expiresAt: now + 59_000 }), now), false)
  assert.equal(accountIsUsable(null, now), false)
})

test('binding round-trip, default name and clearBinding', async () => {
  await withTempDir(async (dir) => {
    assert.equal(await readBinding(dir, 'https://api.example.com', 'user_1'), null)
    await saveBinding(dir, 'https://api.example.com', 'user_1', {
      version: 1, connectorId: 'cxt_1', connectorToken: 'token-value', name: 'OpenCode (host)', installationId: 'inst-1',
    })
    const binding = await readBinding(dir, 'https://api.example.com', 'user_1')
    assert.equal(binding?.connectorId, 'cxt_1')
    await clearBinding(dir, 'https://api.example.com', 'user_1')
    assert.equal(await readBinding(dir, 'https://api.example.com', 'user_1'), null)
  })
})

test('a pending registration key survives beside the binding, without a secret', async () => {
  await withTempDir(async (dir) => {
    const url = 'https://api.example.com'
    await savePendingRegistration(dir, url, 'user_1', {
      version: 1, installationId: 'install-1', name: 'OpenCode (host)', createdAt: 1_000,
    })
    assert.deepEqual(await readPendingRegistration(dir, url, 'user_1'), {
      version: 1, installationId: 'install-1', name: 'OpenCode (host)', createdAt: 1_000,
    })
    // It is a sibling of the binding, so a lost registration response can be
    // retried against the same device instead of creating a second one.
    assert.equal(pendingRegistrationPath(dir, url, 'user_1'), bindingPath(dir, url, 'user_1') + '.pending.json')
    const raw = JSON.parse(await readFileText(pendingRegistrationPath(dir, url, 'user_1'))) as Record<string, unknown>
    assert.equal('connectorToken' in raw, false)
    await savePendingRegistration(dir, url, 'user_1', {
      version: 1, installationId: 'install-2', name: 'OpenCode (host)', createdAt: 2_000,
    })
    assert.equal((await readPendingRegistration(dir, url, 'user_1'))?.installationId, 'install-2')
    await clearPendingRegistration(dir, url, 'user_1')
    assert.equal(await readPendingRegistration(dir, url, 'user_1'), null)
    // A malformed record is surfaced to the caller, which treats it as absent.
    await writeFile(pendingRegistrationPath(dir, url, 'user_1'), '{ broken', 'utf8')
    await assert.rejects(readPendingRegistration(dir, url, 'user_1'), /corrupt JSON/)
  })
})

test('pending flow is non-credential state that expires', async () => {
  await withTempDir(async (dir) => {
    const flow = { version: 1 as const, apiBaseUrl: 'https://api.example.com', state: 's', verifier: 'v', redirectUri: 'http://127.0.0.1:1/oauth/callback', createdAt: 0, deadline: 2_000 }
    await savePendingFlow(dir, flow)
    assert.equal(pendingFlowIsLive(await readPendingFlow(dir), 1_000), true)
    assert.equal(pendingFlowIsLive(await readPendingFlow(dir), 3_000), false)
    await clearPendingFlow(dir)
    assert.equal(await readPendingFlow(dir), null)
  })
})

test('the shared connector-runtime record drives reuse detection', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'connector-runtime.json')
    await writeFile(path, JSON.stringify({ version: 2, connectorIds: ['cxt_a', 'cxt_b'], runtime: { pid: 42, kind: 'cli' } }), 'utf8')
    const runtime = await readConnectorRuntime({ AGENT_CONNECTOR_DATA_DIR: dir } as NodeJS.ProcessEnv)
    assert.equal(runtimeMentionsConnector(runtime, 'cxt_a'), true)
    assert.equal(runtimeMentionsConnector(runtime, 'cxt_z'), false)
    // A malformed record never throws — reuse is an optimisation.
    await writeFile(path, '{ broken', 'utf8')
    assert.equal(await readConnectorRuntime({ AGENT_CONNECTOR_DATA_DIR: dir } as NodeJS.ProcessEnv), null)
  })
})
