import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupStaleEndpoints,
  connectorDataDirectory,
  connectorEndpointDirectory,
  endpointDirectories,
  endpointDirectory,
  endpointFileName,
  isEndpointFileName,
  makeEndpointRecord,
  parseEndpointRecord,
  publishEndpoint,
  readEndpoint,
  removeEndpoint,
  scanEndpoints,
} from '../../src/shared/endpoint-store.js'
import { pluginDataDir } from '../../src/shared/credentials.js'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-endpoints-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const record = (port: number) =>
  makeEndpointRecord({
    bridgeId: 'bridge-1',
    port,
    token: 'token-value',
    pid: 4242,
    locations: ['D:/proj/a'],
    serviceVersion: '2.0.18',
  })

test('publishEndpoint writes an atomically-replaced file with the contract fields', async () => {
  await withTempDir(async (dir) => {
    const expected = record(49375)
    const path = await publishEndpoint(dir, expected)
    assert.equal(path, join(dir, '4242-49375.json'))
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    assert.equal(raw['version'], 1)
    assert.equal(raw['runtime'], 'opencode')
    assert.equal(raw['protocolVersion'], '1.0')
    assert.equal(raw['host'], '127.0.0.1')
    assert.equal(raw['port'], 49375)
    assert.equal(raw['pid'], 4242)
    assert.deepEqual(raw['locations'], ['D:/proj/a'])
    assert.equal(raw['serviceVersion'], '2.0.18')

    const parsed = await readEndpoint(path)
    assert.deepEqual(parsed, expected)
  })
})

test('republishing leaves exactly one file and no temporary residue', async () => {
  await withTempDir(async (dir) => {
    for (let index = 0; index < 5; index += 1) await publishEndpoint(dir, record(5000 + index))
    const entries = await readdir(dir)
    assert.equal(entries.length, 5)
    assert.equal(entries.filter((name) => name.endsWith('.tmp')).length, 0)

    await publishEndpoint(dir, record(5000))
    const again = await readdir(dir)
    assert.equal(again.length, 5)
    assert.equal(again.filter((name) => name.endsWith('.tmp')).length, 0)
  })
})

test('scanEndpoints only reports <pid>-<port>.json files', async () => {
  await withTempDir(async (dir) => {
    await publishEndpoint(dir, record(6000))
    await writeFile(join(dir, 'notes.json'), '{}')
    await writeFile(join(dir, '4242-6000.json.tmp'), '{}')
    await writeFile(join(dir, 'abc-def.json'), '{}')
    const paths = await scanEndpoints(dir)
    assert.deepEqual(paths, [join(dir, '4242-6000.json')])
    assert.ok(isEndpointFileName(endpointFileName(4242, 6000)))
    assert.ok(!isEndpointFileName('notes.json'))
  })
})

test('removeEndpoint is idempotent', async () => {
  await withTempDir(async (dir) => {
    const path = await publishEndpoint(dir, record(7000))
    await removeEndpoint(path)
    await removeEndpoint(path)
    assert.deepEqual(await scanEndpoints(dir), [])
  })
})

test('cleanupStaleEndpoints drops unreadable files and failed handshakes', async () => {
  await withTempDir(async (dir) => {
    const live = await publishEndpoint(dir, record(8001))
    const stale = await publishEndpoint(dir, record(8002))
    const corrupt = join(dir, '4242-8003.json')
    await writeFile(corrupt, '{ not json')

    const removed = await cleanupStaleEndpoints(dir, (_record, path) => path === live)
    assert.deepEqual(removed.sort(), [corrupt, stale].sort())
    assert.deepEqual(await scanEndpoints(dir), [live])
  })
})

test('parseEndpointRecord rejects records that would violate the contract', () => {
  assert.equal(parseEndpointRecord('not json'), null)
  assert.equal(parseEndpointRecord(JSON.stringify({ ...record(1), version: 2 })), null)
  assert.equal(parseEndpointRecord(JSON.stringify({ ...record(1), runtime: 'dsh' })), null)
  assert.equal(parseEndpointRecord(JSON.stringify({ ...record(1), host: '0.0.0.0' })), null)
  assert.equal(parseEndpointRecord(JSON.stringify({ ...record(1), port: 0 })), null)
  assert.equal(parseEndpointRecord(JSON.stringify({ ...record(1), token: '' })), null)
  assert.equal(parseEndpointRecord(JSON.stringify({ ...record(1), protocolVersion: '2.0' }))?.protocolVersion, '2.0')
})

test('endpointDirectory honours the connector data-dir override', () => {
  const overridden = endpointDirectory({ AGENT_CONNECTOR_DATA_DIR: 'D:/aa-data' } as NodeJS.ProcessEnv)
  assert.equal(overridden.replaceAll('\\', '/'), 'D:/aa-data/opencode-bridge/endpoints')
  const fallback = endpointDirectory({} as NodeJS.ProcessEnv)
  assert.ok(fallback.replaceAll('\\', '/').endsWith('/.agents-anywhere/opencode-bridge/endpoints'))
})

test('connectorEndpointDirectory is the registry of the Connector this plugin spawns', () => {
  // The supervisor spawns the Connector with
  // AGENT_CONNECTOR_DATA_DIR = <pluginDataDir>/connector; the Connector then
  // scans <that>/opencode-bridge/endpoints. Pin both halves of the convention.
  const env = { AGENT_CONNECTOR_DATA_DIR: 'D:/aa-data' } as NodeJS.ProcessEnv
  const connectorDataDir = join(pluginDataDir(env), 'connector')
  const normalize = (path: string): string => path.replaceAll('\\', '/')
  assert.equal(normalize(connectorDataDirectory(env)), normalize(connectorDataDir))
  assert.equal(
    normalize(connectorEndpointDirectory(env)),
    normalize(join(connectorDataDir, 'opencode-bridge', 'endpoints')),
  )
})

test('endpointDirectories lists the shared registry and the spawned Connector registry', () => {
  const env = { AGENT_CONNECTOR_DATA_DIR: 'D:/aa-data' } as NodeJS.ProcessEnv
  assert.deepEqual(endpointDirectories(env), [endpointDirectory(env), connectorEndpointDirectory(env)])
  assert.notEqual(endpointDirectories(env)[0], endpointDirectories(env)[1])

  const fallback = endpointDirectories({} as NodeJS.ProcessEnv)
  assert.ok(fallback[0]?.replaceAll('\\', '/').endsWith('/.agents-anywhere/opencode-bridge/endpoints'))
  assert.ok(
    fallback[1]
      ?.replaceAll('\\', '/')
      .endsWith('/.agents-anywhere/opencode-plugin/connector/opencode-bridge/endpoints'),
  )
})
