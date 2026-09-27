import test from 'node:test'
import assert from 'node:assert/strict'
import { apiBaseUrl, webOrigin } from '../../src/shared/oauth.js'

test('webOrigin maps a local self-hosted server from port 8000 to the Web port 5174', () => {
  assert.equal(webOrigin('http://127.0.0.1:8000'), 'http://127.0.0.1:5174')
  assert.equal(webOrigin('http://localhost:8000'), 'http://localhost:5174')
  assert.equal(webOrigin('http://[::1]:8000'), 'http://[::1]:5174')
})

test('webOrigin keeps any other local port unchanged', () => {
  assert.equal(webOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(webOrigin('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(webOrigin('https://127.0.0.1:8443'), 'https://127.0.0.1:8443')
})

test('webOrigin is same-origin for a remote server', () => {
  assert.equal(webOrigin('https://api.example.com'), 'https://api.example.com')
  assert.equal(webOrigin('https://api.example.com:8443/api/v2'), 'https://api.example.com:8443')
  // Port 8000 alone must not trigger the loopback mapping.
  assert.equal(webOrigin('https://api.example.com:8000'), 'https://api.example.com:8000')
})

test('a 127.0.0.1:8000/api/v2 address normalises to the server origin', () => {
  assert.equal(apiBaseUrl('127.0.0.1:8000/api/v2'), 'http://127.0.0.1:8000')
  assert.equal(apiBaseUrl('http://127.0.0.1:8000/api/v2'), 'http://127.0.0.1:8000')
  assert.equal(webOrigin('127.0.0.1:8000/api/v2'), 'http://127.0.0.1:5174')
})

test('a schemeless address assumes https, or http for loopback', () => {
  assert.equal(apiBaseUrl('127.0.0.1:8000'), 'http://127.0.0.1:8000')
  assert.equal(apiBaseUrl('localhost:8000'), 'http://localhost:8000')
  assert.equal(apiBaseUrl('[::1]:8000'), 'http://[::1]:8000')
  assert.equal(apiBaseUrl('api.example.com'), 'https://api.example.com')
  assert.equal(apiBaseUrl('api.example.com/api/v2'), 'https://api.example.com')
})
