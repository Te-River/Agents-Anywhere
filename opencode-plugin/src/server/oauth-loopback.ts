/**
 * Loopback OAuth flow (design §5.1) — the interactive half of onboarding.
 *
 * The plugin binds `127.0.0.1:0`, hands the user an authorization URL, and waits
 * for the browser to 302 back to `/oauth/callback`. Security rules encoded here:
 *
 * - the listener is loopback-only and the `Host` header must match our own
 *   origin, so a DNS-rebinding page cannot drive the callback;
 * - `state` is verified in **constant time** — a mismatch answers `400` and
 *   aborts the flow (the caller restarts it);
 * - the code is **consumed exactly once** (`409` on a second hit) and is
 *   stripped from browser navigation by answering before invoking the callback;
 * - a timeout closes the listener instead of leaving it dangling, which also
 *   removes the code from anywhere it could be replayed.
 *
 * The code/verifier never touch a log; only state transitions are logged.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildAuthorizationUrl, createPkcePair, createState, type PkcePair } from '../shared/oauth.js'
import type { Logger } from '../shared/logger.js'

export const LOOPBACK_TIMEOUT_MS = 10 * 60_000
/** How long the listener stays up after consuming the code (so a replay gets 409). */
export const SHUTDOWN_GRACE_MS = 60_000
export const CALLBACK_PATH = '/oauth/callback'

export type LoopbackErrorCode =
  | 'state_mismatch'
  | 'already_consumed'
  | 'missing_code'
  | 'denied'
  | 'timeout'
  | 'aborted'
  | 'closed'
  /** The listener could not even bind — the caller should fall back to the device flow. */
  | 'unavailable'

/**
 * The "this flow never started" code. `auto-login` falls back to the device code
 * on exactly this one: a denial or a timeout is a user decision, and answering it
 * with a fresh short code would just be noise.
 */
export const LOOPBACK_UNAVAILABLE_CODE: LoopbackErrorCode = 'unavailable'

export class LoopbackFlowError extends Error {
  constructor(
    readonly code: LoopbackErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface LoopbackFlowOptions {
  /** Web origin the browser is sent to (`https://…`), no trailing slash needed. */
  webOrigin: string
  timeoutMs?: number
  logger?: Logger
  /** Called once, after the browser has been answered, with the fresh code. */
  onAuthorized?: (code: string, input: { verifier: string; redirectUri: string }) => void | Promise<void>
  /** Called on timeout/denial/abort — the flow is unusable afterwards. */
  onFailed?: (error: LoopbackFlowError) => void
}

export interface LoopbackStart {
  authorizationUrl: string
  redirectUri: string
  port: number
  state: string
  codeChallenge: string
  deadline: number
}

export class LoopbackOAuthFlow {
  readonly #options: LoopbackFlowOptions
  readonly #pkce: PkcePair = createPkcePair()
  readonly #state = createState()
  readonly #server: Server
  #origin = ''
  #port = 0
  #consumed = false
  #settled = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #shutdown: ReturnType<typeof setTimeout> | undefined
  #deadline = 0
  #logger: Logger | undefined

  constructor(options: LoopbackFlowOptions) {
    this.#options = options
    this.#logger = options.logger
    this.#server = createServer((request, response) => {
      this.#handle(request, response)
    })
  }

  get redirectUri(): string {
    return `${this.#origin}${CALLBACK_PATH}`
  }

  get state(): string {
    return this.#state
  }

  get verifier(): string {
    return this.#pkce.verifier
  }

  get codeChallenge(): string {
    return this.#pkce.challenge
  }

  get port(): number {
    return this.#port
  }

  get consumed(): boolean {
    return this.#consumed
  }

  /** Bind loopback and return everything the caller needs to start the login. */
  async start(): Promise<LoopbackStart> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.#server.once('error', onError)
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', onError)
        resolve()
      })
    })
    const address = this.#server.address() as AddressInfo
    this.#port = address.port
    this.#origin = `http://127.0.0.1:${this.#port}`
    const timeoutMs = this.#options.timeoutMs ?? LOOPBACK_TIMEOUT_MS
    this.#deadline = Date.now() + timeoutMs
    this.#timer = setTimeout(() => {
      this.#fail(new LoopbackFlowError('timeout', 'the loopback login timed out'))
      void this.close()
    }, timeoutMs)
    this.#timer.unref?.()
    this.#logger?.debug('loopback oauth listening', { port: this.#port })
    return {
      authorizationUrl: buildAuthorizationUrl({
        webOrigin: this.#options.webOrigin,
        redirectUri: this.redirectUri,
        state: this.#state,
        codeChallenge: this.#pkce.challenge,
      }),
      redirectUri: this.redirectUri,
      port: this.#port,
      state: this.#state,
      codeChallenge: this.#pkce.challenge,
      deadline: this.#deadline,
    }
  }

  /** Stop listening. Idempotent. */
  async close(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    if (this.#shutdown !== undefined) clearTimeout(this.#shutdown)
    this.#timer = undefined
    this.#shutdown = undefined
    this.#server.closeAllConnections?.()
    if (!this.#server.listening) return
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  /**
   * After the code is consumed the listener keeps answering briefly: the brief
   * requires a **replayed** callback to receive `409`, which is only observable
   * while the listener is still up. It then shuts itself down so no code stays
   * reachable.
   */
  #scheduleShutdown(): void {
    if (this.#shutdown !== undefined) return
    this.#shutdown = setTimeout(() => {
      this.#shutdown = undefined
      void this.close()
    }, SHUTDOWN_GRACE_MS)
    this.#shutdown.unref?.()
  }

  /** Abort an in-flight flow (user cancelled / plugin disposed). */
  abort(reason: string): void {
    this.#fail(new LoopbackFlowError('aborted', reason))
    void this.close()
  }

  #fail(error: LoopbackFlowError): void {
    if (this.#settled) return
    this.#settled = true
    try {
      this.#options.onFailed?.(error)
    } catch {
      // A listener error must never break the flow's own teardown.
    }
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    // A rebound DNS name would carry a foreign Host header; our origin is fixed.
    if (request.headers.host !== new URL(this.#origin).host) {
      response.writeHead(403).end()
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end()
      return
    }
    let url: URL
    try {
      url = new URL(request.url ?? '/', this.#origin)
    } catch {
      response.writeHead(400).end()
      return
    }
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end()
      return
    }

    const incoming = Buffer.from(url.searchParams.get('state') ?? '')
    const expected = Buffer.from(this.#state)
    if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid OAuth state')
      this.#logger?.warn('loopback oauth state mismatch; aborting the flow')
      this.#fail(new LoopbackFlowError('state_mismatch', 'the callback state did not match'))
      void this.close()
      return
    }
    if (this.#consumed) {
      response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OAuth callback already consumed')
      this.#logger?.warn('loopback oauth callback replayed')
      return
    }

    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error === null && (code === null || code.length === 0)) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Missing authorization code')
      return
    }
    // One-shot: mark before answering so a concurrent second hit is a 409.
    this.#consumed = true

    if (error !== null) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultHtml(false, error))
      this.#fail(new LoopbackFlowError('denied', `authorization was not granted (${error})`))
      this.#scheduleShutdown()
      return
    }
    if (code === null) {
      // Unreachable: the guard above already required one of the two.
      response.writeHead(400).end()
      return
    }

    // Answer *before* consuming: the browser lands on a page with no code in its
    // URL or history beyond this navigation, so the code cannot be replayed from
    // the address bar.
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultHtml(true, null))
    if (this.#settled) return
    this.#settled = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#logger?.info('loopback oauth callback accepted')
    try {
      void Promise.resolve(this.#options.onAuthorized?.(code, { verifier: this.#pkce.verifier, redirectUri: this.redirectUri }))
        .catch(() => this.#logger?.warn('loopback oauth token exchange failed'))
        .finally(() => {
          this.#scheduleShutdown()
        })
    } catch {
      this.#logger?.warn('loopback oauth token exchange failed')
      this.#scheduleShutdown()
    }
  }
}

const RESULT_TITLE = '登录 Agents Anywhere'

function resultHtml(ok: boolean, error: string | null): string {
  const heading = ok ? '授权完成' : '授权未完成'
  const detail = ok ? '你可以关闭此页面，回到 OpenCode。' : `原因：${escapeHtml(error ?? 'unknown')}`
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${RESULT_TITLE}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;line-height:1.7">
<h1 style="font-size:1.4rem">${heading}</h1><p style="color:#666">${detail}</p></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;',
  )
}

/** Exported for tests: the exact S256 digest rule used for `code_challenge`. */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
