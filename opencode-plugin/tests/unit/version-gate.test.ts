/**
 * P6 host version gate — pure-function coverage: below / at / above the range,
 * and the "version unavailable" skip path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENCODE_MAX_EXCLUSIVE,
  OPENCODE_MIN_VERSION,
  OPENCODE_SUPPORTED_RANGE,
  OPENCODE_VALIDATED_VERSIONS,
  compareVersions,
  evaluateHostVersion,
  parseVersion,
} from '../../src/shared/version-gate.js'

test('in-range versions pass the gate (the minimum bound is inclusive)', () => {
  for (const version of [OPENCODE_MIN_VERSION, '2.0.16', '2.0.18', '2.1.0', '2.99.99']) {
    const gate = evaluateHostVersion(version)
    assert.equal(gate.supported, true, version)
    assert.equal(gate.warning, null, version)
    assert.equal(gate.reason, null, version)
    assert.equal(gate.version, version)
    assert.equal(gate.source, 'ctx.app.version')
  }
})

test('a host below the range fails with an actionable warning naming version and range', () => {
  for (const version of ['0.1.0', '1.9.9', '2.0.5']) {
    const gate = evaluateHostVersion(version)
    assert.equal(gate.supported, false, version)
    assert.ok(gate.warning?.includes(version), `${version}: warning must name the current version`)
    assert.ok(
      gate.warning?.includes(OPENCODE_SUPPORTED_RANGE),
      `${version}: warning must name the supported range`,
    )
    assert.ok(gate.warning?.includes(OPENCODE_MIN_VERSION))
    // The measured/validated versions are part of the actionable message.
    assert.ok(gate.warning?.includes(OPENCODE_VALIDATED_VERSIONS[0]))
    assert.match(gate.reason ?? '', /below the supported minimum/)
  }
})

test('a host at or above the exclusive ceiling fails (a V3 contract is not assumed)', () => {
  for (const version of ['3.0.0', '3.1.4', '4.0.0']) {
    const gate = evaluateHostVersion(version)
    assert.equal(gate.supported, false, version)
    assert.ok(gate.warning?.includes(OPENCODE_MAX_EXCLUSIVE))
    assert.match(gate.reason ?? '', /unsupported ceiling/)
  }
})

test('an unobtainable version skips the gate and records why (never assumes supported)', () => {
  for (const version of [undefined, null, '', '   ']) {
    const gate = evaluateHostVersion(version)
    assert.equal(gate.supported, null)
    assert.equal(gate.version, null)
    assert.equal(gate.source, 'unknown')
    assert.equal(gate.warning, null)
    assert.match(gate.reason ?? '', /unavailable/)
  }
})

test('a non-semver version is recorded as unverifiable, never treated as supported', () => {
  const gate = evaluateHostVersion('nightly')
  assert.equal(gate.supported, null)
  assert.equal(gate.version, 'nightly')
  assert.equal(gate.source, 'ctx.app.version')
  assert.equal(gate.warning, null)
  assert.match(gate.reason ?? '', /not a semver/)
})

test('parseVersion / compareVersions handle the shapes the host reports', () => {
  assert.deepEqual(parseVersion('2.0.18'), [2, 0, 18])
  assert.deepEqual(parseVersion('v2.1'), [2, 1, 0])
  assert.deepEqual(parseVersion(' 2 '), [2, 0, 0])
  assert.deepEqual(parseVersion('2.1.0-beta.1'), [2, 1, 0])
  assert.equal(parseVersion('nightly'), null)
  assert.equal(parseVersion(undefined), null)

  assert.equal(compareVersions('2.0.18', '2.0.6'), 1)
  assert.equal(compareVersions('2.0.6', '2.0.6'), 0)
  assert.equal(compareVersions('2.0.5', '2.0.6'), -1)
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1)
  assert.throws(() => compareVersions('nightly', '2.0.0'))
})
