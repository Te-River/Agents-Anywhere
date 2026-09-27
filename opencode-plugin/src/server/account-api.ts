/**
 * Thin HTTP client for the Agents Anywhere server's `/api/v2` surface used by
 * onboarding (design §5.1/§5.4 and the P5 implementation report):
 *
 *   POST /oauth/token            authorization_code + PKCE  → access token
 *   GET  /auth/me                account profile
 *   GET  /connectors/{id}        device lookup (reuse verification)
 *   POST /connector/auth         verify a device credential (the 401 oracle)
 *   GET  /connectors             owned devices
 *   GET  /connectors/{id}/runtime-types  what the Connector advertises (reuse gate)
 *   POST /connectors             register a device  → connector token
 *   POST /connectors/{id}/revoke rotate the device token
 *   POST /oauth/device/code      RFC 8628 device authorization
 *   POST /oauth/device/token     RFC 8628 device token poll
 *
 * Only Node built-ins; `fetch` is injectable so every branch is testable against
 * a local fake server. Tokens and codes travel in request bodies/headers and are
 * never logged here.
 */

import { DEVICE_GRANT_TYPE, OAUTH_CLIENT_ID, OAUTH_SCOPE, type DeviceCodeResponse } from '../shared/oauth.js'

const API_NAMESPACE = '/api/v2'
const DEFAULT_TIMEOUT_MS = 20_000

export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    /** OAuth/RFC-8628 error code when the server supplied one, else null. */
    readonly code: string | null,
    message: string,
  ) {
    super(message)
  }
}

export interface AccountProfile {
  userId: string
  displayName: string
  email: string | null
}

export interface DeviceRecord {
  id: string
  name: string
  userId: string
}

export interface TokenBundle {
  accessToken: string
  expiresIn: number
}

export type DevicePollResult =
  | { ok: true; token: TokenBundle }
  | { ok: false; error: string; description: string | null; interval: number | null }

export interface AccountApiOptions {
  apiBaseUrl: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

export class AccountClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: AccountApiOptions) {
    this.#baseUrl = options.apiBaseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetcher ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get apiBaseUrl(): string {
    return this.#baseUrl
  }

  /** Exchange a loopback authorization code (with PKCE) for a token bundle. */
  async exchangeAuthorizationCode(input: {
    code: string
    verifier: string
    redirectUri: string
    signal?: AbortSignal
  }): Promise<TokenBundle> {
    const payload = await this.#json<{ access_token?: unknown; expires_in?: unknown }>(
      '/oauth/token',
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OAUTH_CLIENT_ID,
          code: input.code,
          code_verifier: input.verifier,
          redirect_uri: input.redirectUri,
        }),
      },
      input.signal,
    )
    return requireToken(payload)
  }

  async me(accessToken: string, signal?: AbortSignal): Promise<AccountProfile> {
    const payload = await this.#json<Record<string, unknown>>(
      '/auth/me',
      { headers: bearer(accessToken) },
      signal,
    )
    const userId = str(payload['userId']) ?? str(payload['id'])
    if (userId === null) throw new AccountApiError(200, null, 'the account response carried no user id')
    const email = str(payload['email'])
    return {
      userId,
      displayName: str(payload['displayName']) ?? userId,
      email: email !== null && email.length > 0 ? email : null,
    }
  }

  // ── device code (headless / SSH) ────────────────────────────────────────────

  async requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
    const payload = await this.#json<Record<string, unknown>>(
      '/oauth/device/code',
      {
        method: 'POST',
        body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }),
      },
      signal,
    )
    const deviceCode = str(payload['device_code'])
    const userCode = str(payload['user_code'])
    const verificationUri = str(payload['verification_uri'])
    if (deviceCode === null || userCode === null || verificationUri === null) {
      throw new AccountApiError(200, null, 'the device-code response was missing required fields')
    }
    const expiresIn = num(payload['expires_in'])
    const interval = num(payload['interval'])
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: str(payload['verification_uri_complete']) ?? verificationUri,
      expiresIn: expiresIn !== null && expiresIn > 0 ? expiresIn : 600,
      interval: interval !== null && interval > 0 ? interval : 5,
      scope: str(payload['scope']),
    }
  }

  /**
   * One poll. RFC 8628 returns its pending/slow-down/denied states as HTTP 400
   * with an `{error, error_description}` body, so those are **results**, not
   * thrown errors — only a genuinely unexpected status throws.
   */
  async pollDeviceToken(deviceCode: string, signal?: AbortSignal): Promise<DevicePollResult> {
    const response = await this.#send(
      '/oauth/device/token',
      {
        method: 'POST',
        body: new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, client_id: OAUTH_CLIENT_ID, device_code: deviceCode }),
      },
      signal,
    )
    const body = await readJson(response)
    if (response.ok) {
      try {
        return { ok: true, token: requireToken(body ?? {}) }
      } catch (error) {
        throw new AccountApiError(response.status, null, error instanceof Error ? error.message : 'invalid token response')
      }
    }
    const record = (body ?? {}) as Record<string, unknown>
    const error = str(record['error'])
    if (response.status === 400 && error !== null) {
      return {
        ok: false,
        error,
        description: str(record['error_description']),
        interval: num(record['interval']),
      }
    }
    throw new AccountApiError(response.status, error, `device token request failed (HTTP ${response.status})`)
  }

  // ── connectors / devices ────────────────────────────────────────────────────

  /** `null` when the device no longer exists (HTTP 404) — a deleted device. */
  async getConnector(accessToken: string, id: string, signal?: AbortSignal): Promise<DeviceRecord | null> {
    try {
      const payload = await this.#json<{ connector?: unknown }>(
        `/connectors/${encodeURIComponent(id)}`,
        { headers: bearer(accessToken) },
        signal,
      )
      return readDevice(payload['connector'])
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404) return null
      throw error
    }
  }

  /**
   * The server's only oracle for a **device** credential: `POST /connector/auth`
   * authorizes with the Connector's own `Connector <id>:<token>` header and
   * answers 401 for a rotated or revoked token. `GET /connectors/{id}` cannot
   * stand in for it — that call is authorized by the *account* token, so it
   * reports a rotated device credential as healthy (the real-machine root cause
   * of `online:false` / plugin 401).
   *
   * `true` = accepted, `false` = definitively rejected (401/403). Every other
   * outcome throws, so an unreachable or older server can never trigger a
   * rotation on a mere guess.
   */
  async verifyConnectorToken(id: string, token: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.#send(
      '/connector/auth',
      { method: 'POST', headers: { Authorization: `Connector ${id}:${token}` } },
      signal,
    )
    if (response.ok) return true
    if (response.status === 401 || response.status === 403) return false
    throw new AccountApiError(response.status, null, `device credential check failed (HTTP ${response.status})`)
  }

  async listConnectors(accessToken: string, signal?: AbortSignal): Promise<DeviceRecord[]> {    const payload = await this.#json<{ connectors?: unknown }>(
      '/connectors',
      { headers: bearer(accessToken) },
      signal,
    )
    const rows = Array.isArray(payload['connectors']) ? payload['connectors'] : []
    return rows.map(readDevice).filter((device): device is DeviceRecord => device !== null)
  }

  /**
   * What the running Connector **advertises** it can drive — the reuse gate's
   * evidence (task B). Returns the raw payload: the server owns this shape
   * (`{runtimeTypes:[{runtimeType}]}` on 2.0.x, `{runtimes:[…]}` elsewhere), so
   * `connector-capability.ts` parses it defensively instead of asserting one.
   */
  async listConnectorRuntimeTypes(
    accessToken: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return await this.#json<Record<string, unknown>>(
      `/connectors/${encodeURIComponent(id)}/runtime-types`,
      { headers: bearer(accessToken) },
      signal,
    )
  }

  async registerConnector(
    accessToken: string,
    input: { name: string; installationId: string },
    signal?: AbortSignal,
  ): Promise<{ device: DeviceRecord; connectorToken: string }> {
    const payload = await this.#json<{ connector?: unknown; connectorToken?: unknown }>(
      '/connectors',
      {
        method: 'POST',
        headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.name, connectorKind: 'cli', installationId: input.installationId }),
      },
      signal,
    )
    const device = readDevice(payload['connector'])
    const token = str(payload['connectorToken'])
    if (device === null || token === null || token.length === 0) {
      throw new AccountApiError(200, null, 'device registration returned no credential')
    }
    return { device, connectorToken: token }
  }

  /** `POST /connectors/{id}/revoke` also **rotates** the token (DSH semantics). */
  async revokeConnector(accessToken: string, id: string, signal?: AbortSignal): Promise<{ device: DeviceRecord; connectorToken: string }> {
    const payload = await this.#json<{ connector?: unknown; connectorToken?: unknown }>(
      `/connectors/${encodeURIComponent(id)}/revoke`,
      { method: 'POST', headers: bearer(accessToken) },
      signal,
    )
    const device = readDevice(payload['connector'])
    const token = str(payload['connectorToken'])
    if (device === null || token === null || token.length === 0) {
      throw new AccountApiError(200, null, 'device revoke returned no credential')
    }
    return { device, connectorToken: token }
  }

  // ── transport ───────────────────────────────────────────────────────────────

  async #json<T>(path: string, options: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await this.#send(path, options, signal)
    const body = await readJson(response)
    if (!response.ok) {
      const record = (body ?? {}) as Record<string, unknown>
      throw new AccountApiError(response.status, str(record['error']), `request failed (HTTP ${response.status})`)
    }
    if (body === null) throw new AccountApiError(response.status, null, 'the server returned no JSON body')
    return body as T
  }

  async #send(path: string, options: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    return await this.#fetch(`${this.#baseUrl}${API_NAMESPACE}${path}`, {
      ...options,
      redirect: 'error',
      signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function requireToken(payload: Record<string, unknown>): TokenBundle {
  const accessToken = str(payload['access_token'])
  const expiresIn = num(payload['expires_in'])
  if (accessToken === null || expiresIn === null || expiresIn <= 0) {
    throw new Error('the authorization server returned no usable credential')
  }
  return { accessToken, expiresIn }
}

function readDevice(value: unknown): DeviceRecord | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = str(record['id'])
  const userId = str(record['userId'])
  if (id === null || userId === null) return null
  return { id, name: str(record['name']) ?? id, userId }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json()
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
