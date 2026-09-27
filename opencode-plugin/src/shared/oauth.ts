/**
 * OAuth wire constants and the pure crypto/URL helpers shared by the loopback
 * (design §5.1) and headless (design §5.2) flows.
 *
 * Kept dependency-free and side-effect-free so both the server plugin and the
 * TUI plugin can use it and every branch is unit-testable without a socket.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** The built-in OAuth client the server registers for this plugin (P5). */
export const OAUTH_CLIENT_ID = 'agents-anywhere-opencode-plugin'
export const OAUTH_SCOPE = 'profile'
export const OAUTH_RESPONSE_TYPE = 'code'

/** RFC 8628 device-code grant type the server's `/oauth/device/token` requires. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** Server-side TTL is 600 s; these are the client's own bounds. */
export const DEVICE_CODE_TTL_MS = 600_000
export const DEVICE_POLL_DEFAULT_INTERVAL_MS = 5_000

/** Machine-readable errors of `POST /oauth/device/token` (RFC 8628 shape). */
export const DEVICE_FLOW_ERRORS = {
  authorizationPending: 'authorization_pending',
  slowDown: 'slow_down',
  accessDenied: 'access_denied',
  expiredToken: 'expired_token',
  invalidGrant: 'invalid_grant',
  unsupportedGrantType: 'unsupported_grant_type',
} as const

export type DeviceFlowError = (typeof DEVICE_FLOW_ERRORS)[keyof typeof DEVICE_FLOW_ERRORS]

export interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  /** Seconds between polls, as dictated by the server. */
  interval: number
  scope: string | null
}

export interface PkcePair {
  /** Secret verifier, sent only on the token exchange. */
  verifier: string
  /** S256 challenge, sent in the authorization URL. */
  challenge: string
  method: 'S256'
}

/** 32 random bytes, base64url — the OAuth `state` (design §5.1). */
export function createState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * PKCE S256: a 48-byte verifier (RFC 7636 allows 43–128 chars; base64url of 48
 * bytes is 64) and its SHA-256 challenge.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: s256Challenge(verifier), method: 'S256' }
}

export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Constant-time string comparison; unequal lengths are compared anyway. */
export function constantTimeEquals(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * `${webOrigin}/#/plugin-oauth?...` exactly as design §5.1 spells it. Built with
 * `URL` so encoding is never hand-rolled; the query lives in the **hash** the
 * Web app reads.
 */
export function buildAuthorizationUrl(input: {
  webOrigin: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(`${trimSlash(input.webOrigin)}/`)
  const query = new URLSearchParams({
    response_type: OAUTH_RESPONSE_TYPE,
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    scope: OAUTH_SCOPE,
    state: input.state,
  })
  url.hash = `/plugin-oauth?${query.toString()}`
  return url.href
}

/** Loopback hosts: their locally-developed Web app listens on a different port. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
/** A local self-hosted instance answers the API on this port… */
const LOCAL_SERVER_PORT = '8000'
/** …and serves the Web/OAuth app on this one (design §5.1 / Desktop parity). */
const LOCAL_WEB_PORT = '5174'

/** `URL#hostname` keeps IPv6 brackets, so compare with and without them. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  return LOOPBACK_HOSTS.has(host) || (host.startsWith('[') && LOOPBACK_HOSTS.has(host.slice(1, -1)))
}

/**
 * Scheme for a schemeless address. Loopback is plain HTTP — assuming HTTPS
 * there is what made a self-hosted `127.0.0.1:8000` unreachable — everything
 * else keeps the documented `https://` default.
 */
function assumedScheme(input: string): 'http' | 'https' {
  const authority = input.split(/[/?#]/, 1)[0] ?? ''
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const host = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1)
    : (hostPort.split(':')[0] ?? '')
  return isLoopbackHostname(host) ? 'http' : 'https'
}

/** Normalise a server origin for API calls: `scheme://host[:port]`, no path. */
export function apiBaseUrl(value: string): string | null {
  try {
    const input = value.trim()
    if (input.length === 0) return null
    const url = new URL(input.includes('://') ? input : `${assumedScheme(input)}://${input}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    if (url.search !== '' || url.hash !== '') return null
    const path = url.pathname.replace(/\/+$/, '')
    // Accept a bare origin or an explicit `/api/v2` suffix, nothing deeper.
    if (path !== '' && path !== '/api/v2') return null
    return url.origin
  } catch {
    return null
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * The Web/OAuth origin for a server address (design §5.1, the same rule the
 * Desktop app and DSH use). A remote server serves its Web app same-origin; a
 * locally developed instance answers the API on `8000` but serves the Web app
 * on `5174`, while any other local port is kept as written. Accepts the same
 * shorthand as {@link apiBaseUrl} (missing scheme, trailing `/api/v2`).
 */
export function webOrigin(serverUrl: string): string | null {
  const base = apiBaseUrl(serverUrl)
  if (base === null) return null
  const url = new URL(base)
  if (isLoopbackHostname(url.hostname) && url.port === LOCAL_SERVER_PORT) url.port = LOCAL_WEB_PORT
  return url.origin
}
