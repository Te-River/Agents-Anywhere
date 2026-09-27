import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OAUTH_CLIENT_ID,
  apiBaseUrl,
  buildAuthorizationUrl,
  constantTimeEquals,
  createPkcePair,
  createState,
  s256Challenge,
} from '../../src/shared/oauth.js'

test('createState is 32 random bytes, base64url, and never repeats', () => {
  const a = createState()
  const b = createState()
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
})

test('PKCE S256 matches RFC 7636 and carries the method', () => {
  const pair = createPkcePair()
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{64}$/)
  assert.equal(pair.challenge, s256Challenge(pair.verifier))
  assert.equal(pair.method, 'S256')
  // Known vector: base64url(sha256("abc")).
  assert.equal(s256Challenge('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
})

test('the authorization URL matches design §5.1 exactly', () => {
  const url = new URL(buildAuthorizationUrl({
    webOrigin: 'https://api.example.com/',
    redirectUri: 'http://127.0.0.1:49375/oauth/callback',
    state: 'STATE',
    codeChallenge: 'CHALLENGE',
  }))
  assert.equal(url.origin, 'https://api.example.com')
  assert.ok(url.hash.startsWith('#/plugin-oauth?'))
  const params = new URLSearchParams(url.hash.slice('#/plugin-oauth?'.length))
  assert.equal(params.get('response_type'), 'code')
  assert.equal(params.get('client_id'), OAUTH_CLIENT_ID)
  assert.equal(params.get('client_id'), 'agents-anywhere-opencode-plugin')
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:49375/oauth/callback')
  assert.equal(params.get('code_challenge'), 'CHALLENGE')
  assert.equal(params.get('code_challenge_method'), 'S256')
  assert.equal(params.get('scope'), 'profile')
  assert.equal(params.get('state'), 'STATE')
})

test('constantTimeEquals compares content, not length alone', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true)
  assert.equal(constantTimeEquals('abc', 'abd'), false)
  assert.equal(constantTimeEquals('abc', 'abcd'), false)
  assert.equal(constantTimeEquals('', ''), true)
})

test('apiBaseUrl accepts an origin, a bare host and /api/v2; rejects anything deeper', () => {
  assert.equal(apiBaseUrl('https://api.example.com'), 'https://api.example.com')
  assert.equal(apiBaseUrl('api.example.com'), 'https://api.example.com')
  assert.equal(apiBaseUrl('https://api.example.com/api/v2'), 'https://api.example.com')
  assert.equal(apiBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080')
  assert.equal(apiBaseUrl('https://api.example.com/deep/path'), null)
  assert.equal(apiBaseUrl('ftp://api.example.com'), null)
  assert.equal(apiBaseUrl('https://user:pw@api.example.com'), null)
  assert.equal(apiBaseUrl('https://api.example.com/?x=1'), null)
  assert.equal(apiBaseUrl(''), null)
})
