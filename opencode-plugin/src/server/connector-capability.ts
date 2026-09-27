/**
 * Reuse capability gate (task B).
 *
 * `~/.agents-anywhere/connector-runtime.json` proves a Connector is *running*; it
 * proves nothing about **what that Connector can do**. The Connector shipped
 * inside Agents Anywhere Desktop is an older build that does not know the
 * `opencode` runtime at all (the desktop's "可添加 Runtime" list shows only
 * Codex / Claude / DeepSeek Harness in that case), so reusing it yields a
 * connection with **no working runtime** — "复用了但没有功能".
 *
 * The only trustworthy signal is the one the server holds: the runtime types the
 * Connector itself advertised (`GET /connectors/{id}/runtime-types`, mirrored by
 * `GET /connectors/{id}/runtimes`). Three outcomes, and the conservative one is
 * the default:
 *
 *   - `reuse`        — `opencode` is among the advertised types;
 *   - `incompatible` — it answered, and `opencode` is not there;
 *   - `unknown`      — the query failed / the payload had no recognisable shape.
 *
 * `incompatible` and `unknown` both mean **do not reuse**: the plugin falls back
 * to its own Connector (resolution order `lib/connector` → `../connector`) and
 * logs why. An explicit opt-in (`options.forceReuseConnector`) still wins, so a
 * user who knows better is never locked out.
 */

export const OPENCODE_RUNTIME_TYPE = 'opencode'

export type ConnectorCapabilityVerdict = 'reuse' | 'incompatible' | 'unknown'

export interface ConnectorCapability {
  verdict: ConnectorCapabilityVerdict
  /** The types actually read off the payload; `[]` when nothing was readable. */
  runtimeTypes: string[]
  /** Credential-free, actionable justification for the log line. */
  reason: string
}

/**
 * Pull `runtimeType` values out of either server shape
 * (`{runtimeTypes:[{runtimeType}]}` / `{runtimes:[{runtimeType}]}`) and return
 * `null` when neither array is present — "unrecognisable", never "empty".
 */
export function readRuntimeTypes(payload: unknown): string[] | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  for (const key of ['runtimeTypes', 'runtimes'] as const) {
    const rows = record[key]
    if (!Array.isArray(rows)) continue
    const types: string[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const value = (row as Record<string, unknown>)['runtimeType']
      if (typeof value === 'string' && value.length > 0) types.push(value)
    }
    return types
  }
  return null
}

export interface JudgeConnectorCapabilityInput {
  /** `null` = nothing recognisable came back. */
  runtimeTypes: string[] | null
  /** Failure detail for the `unknown` reason (never a credential). */
  error?: string | null
}

/** Pure verdict, so the policy is testable without any transport. */
export function judgeConnectorCapability(input: JudgeConnectorCapabilityInput): ConnectorCapability {
  if (input.runtimeTypes === null) {
    const detail = input.error !== null && input.error !== undefined && input.error.length > 0 ? `：${input.error}` : ''
    return {
      verdict: 'unknown',
      runtimeTypes: [],
      reason: `无法从服务端确认该 Connector 上报的 runtime 类型${detail}，保守起见不复用它`,
    }
  }
  if (input.runtimeTypes.includes(OPENCODE_RUNTIME_TYPE)) {
    return {
      verdict: 'reuse',
      runtimeTypes: input.runtimeTypes,
      reason: `该 Connector 上报的 runtime 类型包含 ${OPENCODE_RUNTIME_TYPE}`,
    }
  }
  return {
    verdict: 'incompatible',
    runtimeTypes: input.runtimeTypes,
    reason:
      `该 Connector 上报的 runtime 类型为 [${input.runtimeTypes.join(', ') || '空'}]，` +
      `不认识 ${OPENCODE_RUNTIME_TYPE}`,
  }
}

export interface ProbeConnectorCapabilityOptions {
  accessToken: string
  connectorId: string
  /** Injectable transport (production: `AccountClient.listConnectorRuntimeTypes`). */
  listRuntimeTypes: (accessToken: string, connectorId: string) => Promise<unknown>
}

/**
 * Ask the server what this Connector advertises. Any failure — 404, offline
 * Connector, network error, unexpected payload — is `unknown`, which the caller
 * treats as "do not reuse".
 */
export async function probeConnectorCapability(
  options: ProbeConnectorCapabilityOptions,
): Promise<ConnectorCapability> {
  try {
    const payload = await options.listRuntimeTypes(options.accessToken, options.connectorId)
    return judgeConnectorCapability({ runtimeTypes: readRuntimeTypes(payload) })
  } catch (error) {
    return judgeConnectorCapability({
      runtimeTypes: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
