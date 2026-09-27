/**
 * Permission approval policy (§6, security-critical).
 *
 * Two rules live here so the projector, the approval broker and the Hub share a
 * single definition:
 *
 * 1. A remote answer may only ever be `allow_once` or `deny`. `always` would
 *    rewrite the host's persistent permission rules, so it is never exposed as
 *    an action and never accepted as an answer (`unsupported_action`).
 * 2. Only actions that are *provably read-only* may be answered remotely. Every
 *    other action — file writes, arbitrary execution, an unlisted/future tool
 *    name, a missing or empty `action` — is marked `requiresLocalConfirmation`
 *    and stays local-only. This is an allowlist precisely because a denylist is
 *    fail-open: a name the list forgot would silently become remote-answerable.
 *
 * Both predicates are *inputs* to the flow; they never mutate the host's
 * permission effect. The `evaluate` hook stays neutral (returns `undefined`)
 * because A11 — a returned string rewriting `effect` — is unproven.
 */

import type { JsonObject } from './protocol.js'

export const REMOTE_ALLOW_ACTION = 'allow_once'
export const REMOTE_DENY_ACTION = 'deny'
/** The persistent-rule answer. Accepted from nobody; always refused remotely. */
export const PERSISTENT_ACTION = 'always'

/** The only action ids a remote peer is ever allowed to send. */
export const REMOTE_PERMISSION_ACTIONS: readonly string[] = [
  REMOTE_ALLOW_ACTION,
  REMOTE_DENY_ACTION,
]

/**
 * Actions a remote peer may answer WITHOUT a local confirmation: the ones that
 * only read (or fetch) and cannot mutate the host. Compared case-insensitively,
 * after trimming, against `permission.asked`'s `action`.
 *
 * This is deliberately an **allowlist**. A denylist is fail-open: a missing /
 * empty action, a name the list forgot (`write_file`, `multiedit`,
 * `apply_patch`, `bash_write`) or a tool that does not exist yet would all
 * default to "low risk" and become remotely answerable — the exact hole
 * reported as P3 finding 1. Anything not proven read-only stays local-only.
 */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  'read',
  'view',
  'cat',
  'ls',
  'list',
  'glob',
  'grep',
  'search',
  'find',
  'stat',
  'tree',
  'webfetch',
  'fetch',
  'websearch',
])

export function requiresLocalConfirmation(action: string | null): boolean {
  if (action === null) return true
  const normalized = action.trim().toLowerCase()
  if (normalized.length === 0) return true
  return !READ_ONLY_ACTIONS.has(normalized)
}

export function remoteActions(action: string | null): JsonObject[] {
  if (requiresLocalConfirmation(action)) return []
  return [
    { actionId: REMOTE_ALLOW_ACTION, label: 'Allow once' },
    { actionId: REMOTE_DENY_ACTION, label: 'Deny' },
  ]
}

/** True only for the two remote-actionable ids — never for `always`. */
export function isRemoteActionId(actionId: string): boolean {
  return REMOTE_PERMISSION_ACTIONS.includes(actionId)
}
