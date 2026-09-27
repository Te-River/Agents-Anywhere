/** Path normalisation shared by location filtering (rev3 ruling 1). */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * Canonical form for comparing a connection's `location` against
 * `event.location.directory`. Both sides run this exact function, so a
 * degenerate realpath (a path that does not exist yet) falls back to
 * `resolve()` and the comparison stays symmetric.
 *
 * Rule (rev3 ruling 1, applied identically on both sides): realpath + strip
 * trailing separators + backslashes unified to `/`; on win32 additionally
 * casefolded, elsewhere matched exactly.
 */
export function normalizeDirectory(directory: string): string {
  const absolute = realpathOrNull(directory) ?? resolve(directory)
  const unified = absolute.replaceAll('\\', '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

export function sameDirectory(left: string, right: string): boolean {
  return normalizeDirectory(left) === normalizeDirectory(right)
}

/**
 * Is this a usable, absolute `location`? The Hub rejects an opencode
 * handshake whose location is missing, empty or relative (fail-closed).
 */
export function isAbsoluteDirectory(directory: string): boolean {
  return directory.length > 0 && isAbsolute(directory)
}

function realpathOrNull(directory: string): string | null {
  try {
    return realpathSync.native(directory)
  } catch {
    // Missing permissions or a not-yet-created path: fall back to resolve().
    return null
  }
}
