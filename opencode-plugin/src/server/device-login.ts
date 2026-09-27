/**
 * Headless / SSH device-code login (design §5.2, RFC 8628).
 *
 * A loopback callback is unreachable across machines, so the headless path is
 * the *only* one that works over SSH: the plugin asks for a device code, shows
 * `verification_uri` + `user_code` (through the TUI's toast/attention), and
 * polls `/oauth/device/token` on the server's schedule until the user approves
 * from a browser on any device.
 *
 * The poll state machine is pure apart from the injected client/sleep, so every
 * branch (`authorization_pending`, `slow_down` with an increasing interval,
 * `access_denied`, `expired_token`, timeout, abort) is unit-testable with a fake
 * server and no real waiting.
 */

import type { TokenBundle } from './account-api.js'
import type { DeviceCodeResponse } from '../shared/oauth.js'

export type DeviceLoginErrorCode =
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'unexpected_error'
  | 'timeout'
  | 'aborted'

export class DeviceLoginError extends Error {
  constructor(
    readonly code: DeviceLoginErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** The subset of `AccountClient` this flow needs; injectable for tests. */
export interface DeviceLoginClient {
  requestDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse>
  pollDeviceToken(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; token: TokenBundle }
    | { ok: false; error: string; description: string | null; interval: number | null }
  >
}

export interface DeviceCodeNotice {
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
  /** Seconds the client will wait between polls. */
  interval: number
}

export interface DeviceLoginOptions {
  client: DeviceLoginClient
  /** Called once with the code the user must type/see. */
  onCode: (notice: DeviceCodeNotice) => void | Promise<void>
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const SLOW_DOWN_STEP_SECONDS = 5

export async function runDeviceLogin(options: DeviceLoginOptions): Promise<TokenBundle> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const code = await options.client.requestDeviceCode(options.signal)
  const expiresAt = now() + code.expiresIn * 1_000
  await options.onCode({
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    verificationUriComplete: code.verificationUriComplete,
    expiresAt,
    interval: code.interval,
  })

  let intervalMs = code.interval * 1_000
  // Bounded so a bug can never spin: the server TTL is 600 s and the interval
  // never drops below the server's own minimum.
  for (;;) {
    throwIfAborted(options.signal)
    if (now() >= expiresAt) {
      throw new DeviceLoginError('expired_token', 'the device code expired before it was approved')
    }
    await sleep(intervalMs, options.signal)
    throwIfAborted(options.signal)
    if (now() >= expiresAt) {
      throw new DeviceLoginError('expired_token', 'the device code expired before it was approved')
    }

    const result = await options.client.pollDeviceToken(code.deviceCode, options.signal)
    if (result.ok) return result.token

    switch (result.error) {
      case 'authorization_pending':
        continue
      case 'slow_down': {
        // The server asked us to back off; honour its interval when it sent one,
        // otherwise step up (RFC 8628 §3.5).
        const suggested = result.interval
        intervalMs =
          suggested !== null && suggested > 0 ? suggested * 1_000 : intervalMs + SLOW_DOWN_STEP_SECONDS * 1_000
        continue
      }
      case 'access_denied':
        throw new DeviceLoginError('access_denied', 'the request was denied on the approval page')
      case 'expired_token':
        throw new DeviceLoginError('expired_token', 'the device code expired before it was approved')
      case 'invalid_grant':
        throw new DeviceLoginError('invalid_grant', 'the device code was rejected')
      case 'unsupported_grant_type':
        throw new DeviceLoginError('unsupported_grant_type', 'the server does not support the device-code grant')
      default:
        throw new DeviceLoginError(
          'unexpected_error',
          `the device authorization failed (${result.error})`,
        )
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DeviceLoginError('aborted', 'the device login was cancelled')
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new DeviceLoginError('aborted', 'the device login was cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DeviceLoginError('aborted', 'the device login was cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
