import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalJson,
  contentHash,
  platformSessionId,
  protocolMajor,
  sha256Hex,
} from '../../src/shared/protocol.js'

/**
 * Reference vectors produced by the Connector's own implementation
 * (`connector/connector/runtime_protocol/timeline.py::timeline_content_hash`,
 * Python 3.12) so `contentHash` is proven byte-compatible across languages, not
 * merely self-consistent.
 */
const CONNECTOR_VECTORS: Array<{
  type: 'message' | 'tool' | 'turn.end'
  status: 'done' | 'running'
  role: 'assistant' | 'user' | null
  content: Record<string, unknown>
  hash: string
}> = [
  {
    type: 'message',
    status: 'done',
    role: 'assistant',
    content: { kind: 'markdown', text: 'hello', format: 'markdown' },
    hash: 'sha256:98a4853981732f072d14f8e97f8073b6d45da24ca8f0c02a1f94ad19b0e919ca',
  },
  {
    type: 'message',
    status: 'done',
    role: 'user',
    content: { kind: 'markdown', text: 'hi 中文', format: 'markdown' },
    hash: 'sha256:24a5db27164085dbc30a01b166d3cf14ee8a9b078f2264a102da4d5402f23da0',
  },
  {
    type: 'tool',
    status: 'running',
    role: null,
    content: { kind: 'tool_call', title: 'bash' },
    hash: 'sha256:dd7ca65bfcaf6e3ec706f1f5a270daba15e48cd6698fe677e91b2eb29a758d79',
  },
  {
    type: 'turn.end',
    status: 'done',
    role: null,
    content: { kind: 'turn_end' },
    hash: 'sha256:fbcbf45c0128b68520e10808e0808e1d7af7ccb4b1dfc229bd76c94e3e1e3512',
  },
]

test('contentHash matches the Connector reference vectors', () => {
  for (const vector of CONNECTOR_VECTORS) {
    assert.equal(
      contentHash(vector.type, vector.status, vector.role, vector.content),
      vector.hash,
      `contentHash mismatch for ${vector.type}/${vector.status}`,
    )
  }
})

test('canonicalJson sorts keys recursively and drops whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(canonicalJson({ role: null, content: { kind: 'turn_end' } }), '{"content":{"kind":"turn_end"},"role":null}')
  assert.equal(canonicalJson(['a', true, 1]), '["a",true,1]')
  assert.throws(() => canonicalJson(Number.NaN), RangeError)
})

test('platformSessionId mirrors the Connector session identity derivation', () => {
  const expected = `sess_opencode_${sha256Hex('connector-test:opencode:ses_native').slice(0, 24)}`
  assert.equal(platformSessionId('connector-test', 'ses_native'), expected)
  assert.match(platformSessionId('connector-test', 'ses_native'), /^sess_opencode_[0-9a-f]{24}$/)
})

test('protocolMajor accepts 1.x and rejects anything else', () => {
  assert.equal(protocolMajor('1.0'), 1)
  assert.equal(protocolMajor('1.7.3'), 1)
  assert.equal(protocolMajor('2.0'), 2)
  assert.equal(protocolMajor(undefined), null)
  assert.equal(protocolMajor(''), null)
  assert.equal(protocolMajor('x.y'), null)
})
