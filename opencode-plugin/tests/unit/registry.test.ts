/**
 * `EndpointRegistry` publishes one endpoint record into every configured
 * registry — production passes the shared registry plus the registry of the
 * Connector this plugin spawns (`endpointDirectories`). These tests pin the two
 * directories contract: publish everywhere, remove everywhere, and never let a
 * single unwritable registry block or silently degrade the other one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EndpointRegistry } from '../../src/server/registry.js'
import { createLogger, type LogFields, type Logger } from '../../src/shared/logger.js'
import { endpointFileName, readEndpoint, scanEndpoints } from '../../src/shared/endpoint-store.js'

const SILENT = createLogger('test', () => undefined)

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-registry-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function registry(directories: readonly string[], logger: Logger = SILENT): EndpointRegistry {
  return new EndpointRegistry({
    directories,
    pid: 4242,
    port: 51234,
    bridgeId: 'bridge-1',
    token: 'token-value',
    serviceVersion: '2.0.18',
    logger,
  })
}

/** The two production registries, rooted in one temp dir. */
function registries(root: string): { shared: string; connector: string } {
  return {
    shared: join(root, 'opencode-bridge', 'endpoints'),
    connector: join(root, 'opencode-plugin', 'connector', 'opencode-bridge', 'endpoints'),
  }
}

test('publishes the same endpoint record into every configured registry', async () => {
  await withTempDir(async (root) => {
    const { shared, connector } = registries(root)
    const target = join(shared, endpointFileName(4242, 51234))

    const primary = await registry([shared, connector]).publish(['D:/proj/a'])
    assert.equal(primary, target)

    const sharedPaths = await scanEndpoints(shared)
    const connectorPaths = await scanEndpoints(connector)
    assert.deepEqual(sharedPaths, [target])
    assert.deepEqual(connectorPaths, [join(connector, endpointFileName(4242, 51234))])

    const record = await readEndpoint(sharedPaths[0] ?? '')
    assert.equal(record?.port, 51234)
    assert.equal(record?.token, 'token-value')
    assert.deepEqual(record?.locations, ['D:/proj/a'])
    assert.deepEqual(await readEndpoint(connectorPaths[0] ?? ''), record, 'both registries carry the identical record')
  })
})

test('removes the file from every registry it published into', async () => {
  await withTempDir(async (root) => {
    const { shared, connector } = registries(root)
    const target = registry([shared, connector])
    await target.publish(['D:/proj/a'])
    assert.equal((await scanEndpoints(shared)).length, 1)
    assert.equal((await scanEndpoints(connector)).length, 1)

    await target.remove()
    assert.deepEqual(await scanEndpoints(shared), [], 'the shared registry is cleaned')
    assert.deepEqual(await scanEndpoints(connector), [], 'the Connector registry is cleaned too')
    assert.equal(target.path, null)
  })
})

test('an unwritable registry is warned about while the other one still receives the record', async () => {
  await withTempDir(async (root) => {
    const { shared } = registries(root)
    // A regular file stands in for an unusable directory: mkdir under it fails
    // with ENOTDIR on every platform (a `chmod` would be a no-op on Windows).
    const blocker = join(root, 'blocked')
    await writeFile(blocker, 'a file, not a directory')
    const blocked = join(blocker, 'opencode-bridge', 'endpoints')

    const warnings: Array<{ message: string; fields: LogFields }> = []
    const spy = createLogger('test', (level, _scope, message, fields) => {
      if (level === 'warn') warnings.push({ message, fields })
    })

    const target = join(shared, endpointFileName(4242, 51234))
    const primary = await registry([shared, blocked], spy).publish(['D:/proj/a'])

    assert.equal(primary, target, 'the writable registry still publishes and stays primary')
    assert.deepEqual(await scanEndpoints(shared), [target])
    assert.equal(warnings.length, 1, 'the failure is visible, not silent')
    assert.equal(warnings[0]?.message, 'failed to publish the bridge endpoint into one directory')
    assert.equal(warnings[0]?.fields['directory'], blocked)
  })
})

test('rejects only when every configured registry fails', async () => {
  await withTempDir(async (root) => {
    const fileA = join(root, 'a')
    const fileB = join(root, 'b')
    await writeFile(fileA, 'x')
    await writeFile(fileB, 'y')

    await assert.rejects(registry([fileA, fileB]).publish([]), /every configured directory/)
  })
})
