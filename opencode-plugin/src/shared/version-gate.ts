/**
 * Host (OpenCode) version gate — P6.
 *
 * The host's version drifts faster than our contract probes: the 2.0.x line has
 * been seen as 2.0.6 (download page), 2.0.16 and 2.0.18 (local hosts), while this
 * plugin is written against the V2 `ctx` / permission-hook / TUI contract
 * measured on **2.0.18** (P0/A10 probes). A host outside the supported range must
 * never look healthy: this gate produces an actionable warning naming the current
 * version, the supported range and the likely consequence, and the caller
 * annotates the affected capabilities instead of silently serving a half-working
 * surface (same honest wording as the derived capabilities' `probe:"unverified"`).
 *
 * The range is deliberately a claim we can back:
 *   - floor `2.0.6`  — the oldest 2.0.x published on the download page;
 *   - ceiling `< 3.0.0` — the ctx/hook/TUI contract we depend on is V2-specific;
 *   - measured on `2.0.18` (P0/A10), also observed on a `2.0.16` host.
 *
 * The runtime version is read from `ctx.app.version` (`readServiceVersion`). The
 * Connector-side endpoint record also carries `serviceVersion`, but this plugin
 * writes it from the same value, so it is **not** an independent source; when no
 * version can be obtained the gate is skipped and the fact is recorded, never
 * guessed.
 */

export const OPENCODE_MIN_VERSION = '2.0.6'
export const OPENCODE_MAX_EXCLUSIVE = '3.0.0'
export const OPENCODE_SUPPORTED_RANGE = `>=${OPENCODE_MIN_VERSION} <${OPENCODE_MAX_EXCLUSIVE}`

/** Versions actually measured/observed on a host (basis for the range above). */
export const OPENCODE_VALIDATED_VERSIONS = ['2.0.16', '2.0.18'] as const

export type HostVersionSource = 'ctx.app.version' | 'endpoint.serviceVersion' | 'unknown'

export interface HostVersionGate {
  /** The reported version, or `null` when none could be obtained. */
  readonly version: string | null
  /** Where the version came from; `unknown` when it could not be obtained. */
  readonly source: HostVersionSource
  /** `true` in range, `false` out of range, `null` when the version is unknown. */
  readonly supported: boolean | null
  /** Machine-facing explanation; `null` when the version is in range. */
  readonly reason: string | null
  /** Actionable (user-facing) message for a log sink; `null` unless out of range. */
  readonly warning: string | null
}

type Triple = readonly [number, number, number]

const MIN: Triple = [2, 0, 6]
const MAX: Triple = [3, 0, 0]

/**
 * Parse `2.0.18` / `v2.1` / `2` / `2.1.0-beta.1` into a `[major, minor, patch]`
 * triple. Anything without a leading numeric component (e.g. `nightly`) → `null`.
 */
export function parseVersion(value: unknown): Triple | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^v/i, '')
  if (trimmed.length === 0) return null
  const numbers: number[] = []
  for (const part of trimmed.split('.').slice(0, 3)) {
    const match = /^(\d+)/.exec(part)
    const raw = match?.[1]
    if (raw === undefined) return null
    numbers.push(Number.parseInt(raw, 10))
  }
  const [major, minor, patch] = numbers
  if (major === undefined) return null
  return [major, minor ?? 0, patch ?? 0]
}

/** Compare two parseable version strings: `-1` / `0` / `1`. Throws otherwise. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null) throw new Error(`not an OpenCode version: ${a}`)
  if (right === null) throw new Error(`not an OpenCode version: ${b}`)
  return compareTriples(left, right)
}

function compareTriples(a: Triple, b: Triple): number {
  const [am, ai, ap] = a
  const [bm, bi, bp] = b
  if (am !== bm) return am < bm ? -1 : 1
  if (ai !== bi) return ai < bi ? -1 : 1
  if (ap !== bp) return ap < bp ? -1 : 1
  return 0
}

/**
 * Evaluate a reported host version against the supported range. Never throws:
 * an unavailable or unparseable version yields `supported:null` plus a recorded
 * reason, so the caller can skip the gate honestly instead of assuming `true`.
 */
export function evaluateHostVersion(
  version: string | undefined | null,
  source: HostVersionSource = 'ctx.app.version',
): HostVersionGate {
  if (version === undefined || version === null || version.trim().length === 0) {
    return {
      version: null,
      source: 'unknown',
      supported: null,
      reason: 'host version unavailable; the version gate is skipped',
      warning: null,
    }
  }
  const parsed = parseVersion(version)
  if (parsed === null) {
    return {
      version,
      source,
      supported: null,
      reason: `host version "${version}" is not a semver triple; the version gate is skipped`,
      warning: null,
    }
  }
  if (compareTriples(parsed, MIN) < 0) {
    const reason = `host version ${version} is below the supported minimum ${OPENCODE_MIN_VERSION}`
    return { version, source, supported: false, reason, warning: hostWarning(version, reason) }
  }
  if (compareTriples(parsed, MAX) >= 0) {
    const reason = `host version ${version} is at or above the unsupported ceiling ${OPENCODE_MAX_EXCLUSIVE}`
    return { version, source, supported: false, reason, warning: hostWarning(version, reason) }
  }
  return { version, source, supported: true, reason: null, warning: null }
}

function hostWarning(version: string, reason: string): string {
  return (
    `宿主 OpenCode 版本 ${version} 不在支持范围 ${OPENCODE_SUPPORTED_RANGE}：` +
    `本插件按 V2 的 ctx/hook/TUI 契约实现（已在 ${OPENCODE_VALIDATED_VERSIONS.join('/')} 实测），` +
    `可能出现能力缺失、权限审批失效或 TUI 命令不可用。` +
    `请升级/切换到受支持的 OpenCode 版本；详见 opencode-plugin/README.md「版本门」。(${reason})`
  )
}
