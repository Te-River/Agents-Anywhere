import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import { createLogger } from '../../src/shared/logger.js'
import { CAPABILITY_IDS, CATALOG_METHODS } from '../../src/shared/protocol.js'
import type { OpenCodeEvent, OpenCodePluginContext } from '../../src/server/opencode-ctx.js'
import { expectRpcError, FakeBridgeClient } from '../helpers/bridge-client.js'

const SILENT = createLogger('test', () => undefined)
const DIRECTORY = 'D:/proj/a'

function idleStream(): AsyncIterable<OpenCodeEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
}

function ctx(extra: Partial<OpenCodePluginContext>): OpenCodePluginContext {
  return {
    location: { directory: DIRECTORY },
    app: { version: '2.0.18' },
    event: { subscribe: () => idleStream() },
    ...extra,
  }
}

interface CapabilityRow {
  capabilityId: string
  supported: boolean
  unavailableReason?: string
}

async function withHub(
  context: OpenCodePluginContext,
  run: (client: FakeBridgeClient) => Promise<void>,
  logger = SILENT,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-catalog-'))
  const hub = new BridgeHub({ endpointsDirectory: dir, serviceVersion: '2.0.18', logger })
  await hub.start()
  const release = await hub.install(context)
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    await run(client)
  } finally {
    client.close()
    await release()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

async function capability(client: FakeBridgeClient, capabilityId: string): Promise<CapabilityRow | undefined> {
  const caps = (await client.request('runtime.getCapabilities')) as { capabilities: CapabilityRow[] }
  return caps.capabilities.find((row) => row.capabilityId === capabilityId)
}

test('the catalog protocol names are stable (D3/D4)', () => {
  assert.equal(CATALOG_METHODS.listAgents, 'catalog.listAgents')
  assert.equal(CATALOG_METHODS.listModels, 'catalog.listModels')
  assert.equal(CAPABILITY_IDS.catalogAgent, 'catalog.agent')
})

test('catalog.listAgents returns the literal { agents: [...] } contract from ctx.agent.list()', async () => {
  const source = [
    { id: 'build', name: 'Build', description: '默认构建代理', mode: 'primary', hidden: false, permissions: [] },
    { id: 'general', mode: 'subagent' },
    { id: 'compaction', mode: 'primary', hidden: true },
    // An unknown mode is reported as "all" (switchable), never dropped.
    { id: 'weird', mode: 'made-up' },
    // No id: not a usable directory entry.
    { name: 'no-id', mode: 'primary' },
  ]
  await withHub(ctx({ agent: { list: () => ({ location: { directory: DIRECTORY }, data: source }) } }), async (client) => {
    const result = (await client.request(CATALOG_METHODS.listAgents, {})) as { agents: unknown[] }
    assert.deepEqual(result, {
      agents: [
        { id: 'build', name: 'Build', description: '默认构建代理', mode: 'primary', hidden: false },
        { id: 'general', mode: 'subagent', hidden: false },
        { id: 'compaction', mode: 'primary', hidden: true },
        { id: 'weird', mode: 'all', hidden: false },
      ],
    })
    const row = await capability(client, CAPABILITY_IDS.catalogAgent)
    assert.equal(row?.supported, true, 'catalog.agent must be advertised when ctx.agent is present')
  })
})

test('catalog.listAgents falls back to ctx.agent.transform() when only that surface exists', async () => {
  const agent = {
    transform: (callback: (draft: { list: () => unknown[] }) => void): void => {
      callback({ list: () => [{ id: 'plan', mode: 'primary', hidden: false }] })
    },
  }
  await withHub(ctx({ agent }), async (client) => {
    const result = await client.request(CATALOG_METHODS.listAgents, {})
    assert.deepEqual(result, { agents: [{ id: 'plan', mode: 'primary', hidden: false }] })
  })
})

test('a host without ctx.agent fails closed: UNSUPPORTED_OPERATION + unavailable capability', async () => {
  await withHub(ctx({}), async (client) => {
    const error = expectRpcError(await client.request(CATALOG_METHODS.listAgents, {}).catch((e) => e))
    assert.equal(error.code, -32601)
    assert.equal(error.data?.['code'], 'UNSUPPORTED_OPERATION')
    const row = await capability(client, CAPABILITY_IDS.catalogAgent)
    assert.equal(row?.supported, false)
    assert.match(row?.unavailableReason ?? '', /agent/)
  })
})

test('catalog.listModels maps ctx.model items onto the RuntimeModelCatalog envelope', async () => {
  const source = [
    { id: 'gpt-5', name: 'GPT-5', providerID: 'openai', description: 'flagship' },
    // No bare id: the provider-qualified id is derived, and title falls through
    // to the explicit title/modelID.
    { modelID: 'm2', providerID: 'acme', title: 'M2' },
    { name: 'nameless-only' },
  ]
  await withHub(ctx({ model: { list: () => ({ data: source }) } }), async (client) => {
    const result = await client.request(CATALOG_METHODS.listModels, {})
    assert.deepEqual(result, {
      runtime: 'opencode',
      revision: 1,
      models: [
        { id: 'gpt-5', title: 'GPT-5', description: 'flagship', selectionId: 'gpt-5' },
        { id: 'acme/m2', title: 'M2', selectionId: 'acme/m2' },
        { id: 'nameless-only', title: 'nameless-only', selectionId: 'nameless-only' },
      ],
    })
    const row = await capability(client, CAPABILITY_IDS.catalogModel)
    assert.equal(row?.supported, true)
  })
})

/** Keeps `warn` lines so a collapsed catalog row can never be dropped silently. */
function recordingLogger(warnings: Array<{ message: string; fields: unknown }>): ReturnType<typeof createLogger> {
  return createLogger('test', (level, _scope, message, fields) => {
    if (level === 'warn') warnings.push({ message, fields })
  })
}

test('catalog.listModels collapses one model offered by two providers (the server rejects a repeat wholesale)', async () => {
  // Real machine: `longcat-2.5-preview-free` was offered by two gateways. The
  // host listing it twice is legal; the server's `validate_model_catalog`
  // answered `duplicate model id` for the whole catalog, 16 times in a row.
  const source = [
    { id: 'longcat-2.5-preview-free', title: 'LongCat', providerID: 'lxns-uni' },
    { id: 'longcat-2.5-preview-free', title: 'LongCat (backup)', providerID: 'backup-gw' },
    { id: 'glm-5.3', title: 'GLM 5.3', providerID: 'lxns-uni' },
  ]
  const warnings: Array<{ message: string; fields: unknown }> = []
  await withHub(
    ctx({ model: { list: () => ({ data: source }) } }),
    async (client) => {
      const result = await client.request(CATALOG_METHODS.listModels, {})
      assert.deepEqual(result, {
        runtime: 'opencode',
        revision: 1,
        models: [
          { id: 'longcat-2.5-preview-free', title: 'LongCat', selectionId: 'longcat-2.5-preview-free' },
          { id: 'glm-5.3', title: 'GLM 5.3', selectionId: 'glm-5.3' },
        ],
      })
    },
    recordingLogger(warnings),
  )
  const repeat = warnings.find((entry) => entry.message.includes('model catalog repeats an id'))
  assert.deepEqual(repeat?.fields, { duplicates: ['longcat-2.5-preview-free'] })
})

test('catalog.listAgents collapses a repeated agent id and names it', async () => {
  const source = [
    { id: 'build', mode: 'primary' },
    { id: 'build', mode: 'subagent', hidden: true },
    { id: 'plan', mode: 'primary' },
  ]
  const warnings: Array<{ message: string; fields: unknown }> = []
  await withHub(
    ctx({ agent: { list: () => ({ data: source }) } }),
    async (client) => {
      const result = await client.request(CATALOG_METHODS.listAgents, {})
      assert.deepEqual(result, {
        agents: [
          { id: 'build', mode: 'primary', hidden: false },
          { id: 'plan', mode: 'primary', hidden: false },
        ],
      })
    },
    recordingLogger(warnings),
  )
  const repeat = warnings.find((entry) => entry.message.includes('agent catalog repeats an id'))
  assert.deepEqual(repeat?.fields, { duplicates: ['build'] })
})

test('catalog.listPermissions stays UNSUPPORTED_OPERATION (no catalog in this scope)', async () => {
  await withHub(ctx({ agent: { list: () => ({ data: [] }) } }), async (client) => {
    for (const method of [CATALOG_METHODS.listPermissions, CATALOG_METHODS.listModels]) {
      const error = expectRpcError(await client.request(method, {}).catch((e) => e))
      assert.equal(error.code, -32601, method)
      assert.equal(error.data?.['code'], 'UNSUPPORTED_OPERATION', method)
    }
  })
})
