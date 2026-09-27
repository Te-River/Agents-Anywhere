/**
 * Coexistence: report which plugins are loaded in the same host process.
 *
 * Observation only. This module never writes OpenCode config, never claims a
 * hook, and never pre-empts another plugin — an unknown neighbour simply shows
 * up in the report and a startup log line.
 */

export interface CohabitationReport {
  /** Plugin ids/specs observed alongside this plugin, de-duplicated and sorted. */
  plugins: string[]
  /** True when at least one other plugin shares the process. */
  shared: boolean
  observedAt: string
  /**
   * Sources that could not be read. Recorded rather than thrown: a missing
   * config file must not stop the bridge from coming up.
   */
  unavailable: string[]
}

export interface CohabitationInput {
  /** Plugin specs from the merged OpenCode config (if the host exposes them). */
  configured?: readonly unknown[]
  /** Plugin ids discovered on disk (project `.opencode/plugins`, global dirs). */
  discovered?: readonly string[]
  /** Plugin ids the caller already knows about through another channel. */
  reported?: readonly string[]
}

function asPluginId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['id', 'name', 'spec', 'path']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
    }
  }
  return null
}

/** Collect a stable, de-duplicated view of the plugins sharing the process. */
export function observeCohabitation(input: CohabitationInput = {}): CohabitationReport {
  const plugins = new Set<string>()
  const unavailable: string[] = []
  for (const source of [
    ['configured', input.configured],
    ['discovered', input.discovered],
    ['reported', input.reported],
  ] as const) {
    const [label, values] = source
    if (values === undefined) {
      unavailable.push(`${label}:unavailable`)
      continue
    }
    for (const value of values) {
      const id = asPluginId(value)
      if (id !== null) plugins.add(id)
    }
  }
  return {
    plugins: [...plugins].sort(),
    shared: plugins.size > 0,
    observedAt: new Date().toISOString(),
    unavailable,
  }
}

/** One-line summary for the startup log (never includes plugin payloads). */
export function summarizeCohabitation(report: CohabitationReport): string {
  if (report.plugins.length === 0) {
    return 'no co-resident plugins observed (observation only, nothing claimed)'
  }
  return `co-resident plugins observed (observation only): ${report.plugins.join(', ')}`
}
