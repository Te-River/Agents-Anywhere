import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountApiError, AccountClient } from '../../src/server/account-api.js'

interface SeenCall {
  url: string
  method: string
  authorization: string | null
}

/** A fetcher that answers one status and records what the client actually sent. */
function fetchStatus(status: number, seen: SeenCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const source = input instanceof Request ? input : undefined
    const headers = new Headers(init?.headers ?? source?.headers)
    seen.push({
      url,
      method: init?.method ?? source?.method ?? 'GET',
      authorization: headers.get('authorization'),
    })
    const body = status === 200 ? { accessToken: 'connector-access', expiresIn: 3600 } : { error: 'invalid connector credential' }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

test('verifyConnectorToken uses the Connector header shape and accepts a 200', async () => {
  const seen: SeenCall[] = []
  const client = new AccountClient({ apiBaseUrl: 'https://api.example.com/', fetcher: fetchStatus(200, seen) })
  assert.equal(await client.verifyConnectorToken('conn_1', 'cxt_secret'), true)
  assert.deepEqual(seen, [
    {
      url: 'https://api.example.com/api/v2/connector/auth',
      method: 'POST',
      authorization: 'Connector conn_1:cxt_secret',
    },
  ])
})

test('verifyConnectorToken maps 401/403 to a definitive rejection', async () => {
  for (const status of [401, 403]) {
    const client = new AccountClient({ apiBaseUrl: 'https://api.example.com', fetcher: fetchStatus(status, []) })
    assert.equal(await client.verifyConnectorToken('conn_1', 'stale'), false, `HTTP ${status}`)
  }
})

test('verifyConnectorToken never turns an unexpected failure into "invalid" (no rotation on uncertainty)', async () => {
  const client = new AccountClient({ apiBaseUrl: 'https://api.example.com', fetcher: fetchStatus(500, []) })
  await assert.rejects(
    client.verifyConnectorToken('conn_1', 'cxt_secret'),
    (error: unknown) => error instanceof AccountApiError && error.status === 500,
  )
})
