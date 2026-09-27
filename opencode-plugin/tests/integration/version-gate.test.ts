/**
 * P6 host version gate — hub wiring: the gate reads `ctx.app.version`, warns
 * once when out of range, and annotates the capability set instead of serving a
 * silently healthy surface. Control runs prove an in-range host is unchanged and
 * an unknown version is recorded without annotating rows.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeHub } from '../../src/server/bridge-hub.js'
import type { OpenCodeEvent, OpenCodePluginContext } from '../../src/server/opencode-ctx.js'
import { createLogger, type LogLevel } from '../../src/shared/logger.js'
import { OPENCODE_SUPPORTED_RANGE } from '../../src/shared/version-gate.js'
import { FakeBridgeClient } from '../helpers/bridge-client.js'

const VERSION_LINE_PREFIX = '宿主 OpenCode 版本'

interface RecordedLine {
  level: LogLevel
  message: string
  fields: Record<string, unknown>
}

interface Caps {
  capabilities: Array<{ capabilityId: string; metadata: Record<string, unknown> }>
  metadata: Record<string, unknown>
}

function idleStream(): AsyncIterable<OpenCodeEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) }
}

function ctx(appVersion: string | undefined): OpenCodePluginContext {
  const base: OpenCodePluginContext = {
    location: { directory: 'D:/proj/a' },
    event: { subscribe: () => idleStream() },
    // A registered evaluate hook keeps the unrelated "permission.hook
    // unavailable" warn out of the recorded lines, so the version warn is the
    // only one this test has to account for.
    permission: { hook: () => ({ dispose: () => undefined }) },
  }
  return appVersion === undefined ? base : { ...base, app: { version: appVersion } }
}

/**
 * `hubVersion` mirrors production (`installPlugin` passes `ctx.app.version` to
 * the hub); `ctxVersion` exercises the `install(ctx)` refresh path when the hub
 * was created without a version.
 */
async function withHub(
  versions: { hubVersion?: string; ctxVersion?: string },
  run: (caps: Caps, lines: RecordedLine[]) => void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-version-'))
  const lines: RecordedLine[] = []
  const logger = createLogger('test', (level, _scope, message, fields) => {
    lines.push({ level, message, fields: { ...fields } })
  })
  const hub = new BridgeHub({
    endpointsDirectory: dir,
    ...(versions.hubVersion !== undefined ? { serviceVersion: versions.hubVersion } : {}),
    logger,
  })
  await hub.start()
  const release = await hub.install(ctx(versions.ctxVersion))
  const client = await FakeBridgeClient.connect(hub.port)
  try {
    await client.initialize(FakeBridgeClient.initializeParams(hub.token))
    run((await client.request('runtime.getCapabilities')) as Caps, lines)
  } finally {
    client.close()
    await release()
    await hub.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

const versionLines = (lines: RecordedLine[]): RecordedLine[] =>
  lines.filter((line) => line.message.startsWith(VERSION_LINE_PREFIX))

test('an out-of-range host warns once and annotates every capability row', async () => {
  await withHub({ hubVersion: '1.9.0', ctxVersion: '1.9.0' }, (caps, lines) => {
    assert.equal(caps.metadata['hostVersion'], '1.9.0')
    assert.equal(caps.metadata['hostVersionSource'], 'ctx.app.version')
    assert.equal(caps.metadata['hostVersionSupported'], false)
    assert.equal(typeof caps.metadata['hostVersionReason'], 'string')

    assert.ok(caps.capabilities.length > 0)
    for (const row of caps.capabilities) {
      assert.equal(row.metadata['probe'], 'unverified', `${row.capabilityId} probe`)
      assert.equal(row.metadata['hostVersionOutOfRange'], true, `${row.capabilityId} flag`)
    }

    const warns = versionLines(lines).filter((line) => line.level === 'warn')
    assert.equal(warns.length, 1, 'the host-version warning fires exactly once')
    const warn = warns[0]
    assert.ok(warn?.message.includes('1.9.0'))
    assert.ok(warn?.message.includes(OPENCODE_SUPPORTED_RANGE))
    assert.equal(warn?.fields['hostVersion'], '1.9.0')
  })
})

test('the install(ctx) refresh also warns when only the context carries the version', async () => {
  await withHub({ ctxVersion: '3.0.0' }, (caps, lines) => {
    assert.equal(caps.metadata['hostVersion'], '3.0.0')
    assert.equal(caps.metadata['hostVersionSupported'], false)
    const warns = versionLines(lines).filter((line) => line.level === 'warn')
    assert.equal(warns.length, 1)
    assert.ok(warns[0]?.message.includes('3.0.0'))
  })
})

test('an in-range host is untouched: no warning, rows keep their own metadata', async () => {
  await withHub({ hubVersion: '2.0.18', ctxVersion: '2.0.18' }, (caps, lines) => {
    assert.equal(caps.metadata['hostVersion'], '2.0.18')
    assert.equal(caps.metadata['hostVersionSupported'], true)
    assert.equal(caps.metadata['hostVersionReason'], undefined)
    assert.equal(versionLines(lines).length, 0)
    const sessionList = caps.capabilities.find((row) => row.capabilityId === 'session.list')
    assert.equal(sessionList?.metadata['probe'], undefined)
    assert.equal(sessionList?.metadata['hostVersionOutOfRange'], undefined)
  })
})

test('an un-obtainable version is recorded and the gate is skipped (no row annotation)', async () => {
  await withHub({}, (caps, lines) => {
    assert.equal(caps.metadata['hostVersion'], null)
    assert.equal(caps.metadata['hostVersionSource'], 'unknown')
    assert.equal(caps.metadata['hostVersionSupported'], null)
    const recorded = versionLines(lines)
    assert.equal(recorded.filter((line) => line.level === 'warn').length, 0)
    assert.equal(recorded.filter((line) => line.level === 'info').length, 1)
    const sessionList = caps.capabilities.find((row) => row.capabilityId === 'session.list')
    assert.equal(sessionList?.metadata['hostVersionOutOfRange'], undefined)
  })
})
