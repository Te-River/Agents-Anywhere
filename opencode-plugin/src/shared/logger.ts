/**
 * Redacting logger.
 *
 * Hard rule: a bridge token, an auth code and a device credential must never
 * reach a log sink. Values whose key looks secret are replaced before anything
 * is emitted, so an accidental `logger.info({ params })` cannot leak them.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogFields {
  readonly [key: string]: unknown
}

export type LogSink = (level: LogLevel, scope: string, message: string, fields: LogFields) => void

const SECRET_KEY = /(token|secret|code|auth|password|credential|verifier|signature|apikey|api_key)/i
const REDACTED = '[redacted]'
const MAX_DEPTH = 6

/** Deep-copy `value`, masking any value held under a secret-looking key. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1))
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : redact(entry, depth + 1)
  }
  return output
}

const defaultSink: LogSink = (level, scope, message, fields) => {
  const line = `[agents-anywhere-opencode] ${level} ${scope} ${message}`
  const payload = redact(fields)
  const text =
    payload && typeof payload === 'object' && Object.keys(payload).length > 0
      ? `${line} ${JSON.stringify(payload)}`
      : line
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

/** Create a scoped logger. `sink` is injectable for tests. */
export function createLogger(scope: string, sink: LogSink = defaultSink): Logger {
  const emit =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      try {
        sink(level, scope, message, redact(fields) as LogFields)
      } catch {
        // Logging must never break the plugin.
      }
    }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  }
}
