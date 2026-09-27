import test from 'node:test'
import assert from 'node:assert/strict'
import {
  judgeConnectorCapability,
  probeConnectorCapability,
  readRuntimeTypes,
} from '../../src/server/connector-capability.js'

// -- payload parsing ---------------------------------------------------------------

test('readRuntimeTypes accepts the runtimeTypes shape the server model uses', () => {
  const types = readRuntimeTypes({
    connectorId: 'cxt_1',
    runtimeTypes: [{ runtimeType: 'codex' }, { runtimeType: 'opencode' }],
  })
  assert.deepEqual(types, ['codex', 'opencode'])
})

test('readRuntimeTypes accepts the runtimes shape too', () => {
  const types = readRuntimeTypes({
    connectorId: 'cxt_1',
    runtimes: [{ runtimeId: 'r1', runtimeType: 'opencode' }],
  })
  assert.deepEqual(types, ['opencode'])
})

test('readRuntimeTypes returns null (unknown) for anything unrecognisable', () => {
  assert.equal(readRuntimeTypes(null), null)
  assert.equal(readRuntimeTypes('{}'), null)
  assert.equal(readRuntimeTypes([]), null)
  assert.equal(readRuntimeTypes({ connectorId: 'cxt_1' }), null)
  assert.equal(readRuntimeTypes({ runtimeTypes: 'opencode' }), null)
})

test('readRuntimeTypes keeps an empty list distinct from an unreadable payload', () => {
  assert.deepEqual(readRuntimeTypes({ runtimeTypes: [] }), [])
})

// -- verdict ------------------------------------------------------------------------

test('a Connector that advertises opencode is reusable', () => {
  const verdict = judgeConnectorCapability({ runtimeTypes: ['codex', 'opencode'] })
  assert.equal(verdict.verdict, 'reuse')
  assert.match(verdict.reason, /opencode/)
})

test('the desktop-bundled Connector (no opencode) is incompatible', () => {
  const verdict = judgeConnectorCapability({ runtimeTypes: ['codex', 'claude', 'dsh'] })
  assert.equal(verdict.verdict, 'incompatible')
  assert.match(verdict.reason, /不认识 opencode/)
  assert.match(verdict.reason, /codex, claude, dsh/)
})

test('an empty advertisement is incompatible, not a reuse', () => {
  assert.equal(judgeConnectorCapability({ runtimeTypes: [] }).verdict, 'incompatible')
})

test('an unreadable payload is unknown (the conservative verdict)', () => {
  const verdict = judgeConnectorCapability({ runtimeTypes: null, error: 'HTTP 404' })
  assert.equal(verdict.verdict, 'unknown')
  assert.match(verdict.reason, /保守/)
  assert.match(verdict.reason, /HTTP 404/)
})

// -- probe -------------------------------------------------------------------------

test('the probe queries the injected transport with our token and device', async () => {
  const seen: Array<[string, string]> = []
  const verdict = await probeConnectorCapability({
    accessToken: 'token-1',
    connectorId: 'cxt_1',
    listRuntimeTypes: async (token, connectorId) => {
      seen.push([token, connectorId])
      return { runtimeTypes: [{ runtimeType: 'opencode' }] }
    },
  })
  assert.equal(verdict.verdict, 'reuse')
  assert.deepEqual(seen, [['token-1', 'cxt_1']])
})

test('a failing transport is unknown, never a throw', async () => {
  const verdict = await probeConnectorCapability({
    accessToken: 'token-1',
    connectorId: 'cxt_1',
    listRuntimeTypes: async () => {
      throw new Error('device not found')
    },
  })
  assert.equal(verdict.verdict, 'unknown')
  assert.match(verdict.reason, /device not found/)
})
