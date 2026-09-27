import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { LoopbackOAuthFlow, type LoopbackFlowError } from '../../src/server/oauth-loopback.js'

/** A real loopback listener, a real HTTP request — only the browser is simulated. */
async function fetchCallback(redirectUri: string, params: Record<string, string>): Promise<Response> {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return await fetch(url.href, { redirect: 'manual' })
}

/** The callback settles asynchronously; give the promise chain a turn. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** A raw request so a forged Host header can actually reach the listener. */
function rawGet(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = httpRequest(
      { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', headers: { host } },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

test('loopback: a correct state+code is consumed once and handed to onAuthorized', async () => {
  const codes: string[] = []
  let verifier = ''
  let redirect = ''
  const flow = new LoopbackOAuthFlow({
    webOrigin: 'https://web.example',
    onAuthorized: (code, input) => { codes.push(code); verifier = input.verifier; redirect = input.redirectUri },
  })
  const started = await flow.start()
  try {
    assert.equal(started.redirectUri, `http://127.0.0.1:${started.port}/oauth/callback`)
    assert.ok(started.authorizationUrl.startsWith('https://web.example/#/plugin-oauth?'))
    assert.ok(started.authorizationUrl.includes(`state=${started.state}`))

    const first = await fetchCallback(started.redirectUri, { code: 'auth-code-1', state: started.state })
    assert.equal(first.status, 200)
    await tick()
    assert.equal(codes.length, 1)
    assert.equal(codes[0], 'auth-code-1')
    assert.equal(verifier, flow.verifier)
    assert.equal(redirect, started.redirectUri)
    // The answer page must not echo the code back into the browser.
    assert.equal((await first.text()).includes('auth-code-1'), false)

    const replay = await fetchCallback(started.redirectUri, { code: 'auth-code-1', state: started.state })
    assert.equal(replay.status, 409)
    assert.equal(codes.length, 1, 'a replayed callback never re-consumes the code')
  } finally {
    await flow.close()
  }
})

test('loopback: a mismatched state answers 400 and aborts the flow', async () => {
  const failures: LoopbackFlowError[] = []
  const flow = new LoopbackOAuthFlow({ webOrigin: 'https://web.example', onAuthorized: () => undefined, onFailed: (error) => failures.push(error) })
  const started = await flow.start()
  try {
    const response = await fetchCallback(started.redirectUri, { code: 'auth-code-1', state: 'not-the-state' })
    assert.equal(response.status, 400)
    assert.deepEqual(failures.map((error) => error.code), ['state_mismatch'])
  } finally {
    await flow.close()
  }
})

test('loopback: a missing code and a denial are both rejected politely', async () => {
  const failures: LoopbackFlowError[] = []
  const flow = new LoopbackOAuthFlow({ webOrigin: 'https://web.example', onAuthorized: () => undefined, onFailed: (error) => failures.push(error) })
  const started = await flow.start()
  try {
    const missing = await fetchCallback(started.redirectUri, { state: started.state })
    assert.equal(missing.status, 400)
    assert.equal(failures.length, 0, 'a malformed request does not settle the flow')

    const denied = await fetchCallback(started.redirectUri, { error: 'access_denied', state: started.state })
    assert.equal(denied.status, 200)
    assert.deepEqual(failures.map((error) => error.code), ['denied'])
  } finally {
    await flow.close()
  }
})

test('loopback: a non-GET method and a foreign Host header are refused', async () => {
  const flow = new LoopbackOAuthFlow({ webOrigin: 'https://web.example', onAuthorized: () => undefined })
  const started = await flow.start()
  try {
    const wrongHost = await rawGet(`${started.redirectUri}?code=x&state=${started.state}`, 'evil.example')
    assert.equal(wrongHost, 403)
    const wrongMethod = await fetch(started.redirectUri, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await flow.close()
  }
})

test('loopback: the timeout closes the listener and reports it', async () => {
  const failures: LoopbackFlowError[] = []
  const flow = new LoopbackOAuthFlow({ webOrigin: 'https://web.example', timeoutMs: 30, onAuthorized: () => undefined, onFailed: (error) => failures.push(error) })
  const started = await flow.start()
  await new Promise((resolve) => setTimeout(resolve, 60))
  try {
    assert.deepEqual(failures.map((error) => error.code), ['timeout'])
    await assert.rejects(fetch(started.redirectUri, { redirect: 'manual' }))
  } finally {
    await flow.close()
  }
})
