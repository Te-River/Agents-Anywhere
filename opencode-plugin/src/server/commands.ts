/**
 * Command-palette registration (`ctx.command.transform`) — task A.
 *
 * The host's `draft.add` is a **swallowing** API: it returns a `Map` and reports
 * a schema violation by silently dropping the entry, so a malformed payload does
 * not fail here — it poisons the host's command registry, which then answers
 * `GET /api/command` with HTTP 500 (measured on opencode-cli 2.0.18). The plugin
 * therefore treats `add` as a *write to a foreign registry*: every payload is
 * validated **before** it can reach `add`, invalid candidates are reported and
 * dropped, and the only shape that ever crosses the boundary is
 * `{ name, description, execute }` with three checked values.
 *
 * The command names are also reserved process-wide: two plugin instances in one
 * host must not register `aa-login` twice.
 */

import type { Logger } from '../shared/logger.js'
import type { CommandApi, CommandAddPayload, CommandDraft } from './opencode-ctx.js'

/**
 * Host command syntax. Lowercase words separated by `-` / `_` / `.`, leading
 * digit allowed, 64 chars max — the conservative subset of what the host's own
 * built-ins (`init`, `review`) and our `aa-*` family use. Anything outside it is
 * refused rather than gambled on: an illegal name is the 500-risk case.
 */
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * The host's `description` is optional, but a description is what makes a
 * palette entry discoverable. An over-long one is truncated (a long string is
 * not a registry hazard, an absent one is a usability hazard); a non-string one
 * is a validation failure.
 */
const MAX_DESCRIPTION_CHARS = 200

export interface CommandEntry {
  name: string
  description: string
  execute: (ctx?: unknown) => Promise<string> | string
}

export interface CommandValidationIssue {
  /** Position in the caller's candidate array (diagnostics only). */
  index: number
  /** The offending value, stringified defensively — never trusted as a string. */
  name: string
  reason: string
}

export interface CommandRegistrationResult {
  /** Names that were handed to `add` and did not throw. */
  registered: string[]
  /** Candidates refused before `add`; each carries an actionable reason. */
  rejected: CommandValidationIssue[]
}

/**
 * The set of command names already taken in this process. `claim` is the only
 * mutator and answers `false` on a second claim, which is how "命令名唯一" is
 * enforced across plugin instances.
 */
export interface CommandRegistry {
  has(name: string): boolean
  claim(name: string): boolean
}

export function createCommandRegistry(): CommandRegistry {
  const names = new Set<string>()
  return {
    has: (name) => names.has(name),
    claim: (name) => {
      if (names.has(name)) return false
      names.add(name)
      return true
    },
  }
}

/** Process-wide registry shared by every `setup()` in this host process. */
export const processCommandRegistry: CommandRegistry = createCommandRegistry()

export interface RegisterCommandsOptions {
  logger: Logger
  registry?: CommandRegistry
}

/**
 * Validate one candidate. `taken` answers membership for the names already
 * claimed in this process **and** for the ones accepted earlier in the same
 * batch, so uniqueness is checked here rather than discovered from the host
 * afterwards (where duplicate handling is unknown).
 */
export function validateCommandEntry(
  value: unknown,
  index: number,
  taken: { has(name: string): boolean },
): { ok: true; entry: CommandEntry } | { ok: false; issue: CommandValidationIssue } {
  const reject = (name: string, reason: string): { ok: false; issue: CommandValidationIssue } => ({
    ok: false,
    issue: { index, name, reason },
  })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return reject(String(value), '命令候选不是一个对象')
  }
  const record = value as Record<string, unknown>
  const name = record['name']
  if (typeof name !== 'string' || name.length === 0) {
    return reject(describe(name), 'name 必须是字符串且非空')
  }
  if (!COMMAND_NAME_PATTERN.test(name)) {
    return reject(name, `name 不符合宿主命令语法（要求 ${String(COMMAND_NAME_PATTERN)}）`)
  }
  if (taken.has(name)) {
    return reject(name, '命令名在本进程内已被占用（重名会污染注册表）')
  }
  const description = record['description']
  if (typeof description !== 'string') {
    return reject(name, 'description 必须是字符串')
  }
  const execute = record['execute']
  if (typeof execute !== 'function') {
    return reject(name, 'execute 必须是函数')
  }
  return {
    ok: true,
    entry: {
      name,
      description: description.slice(0, MAX_DESCRIPTION_CHARS),
      execute: execute as CommandEntry['execute'],
    },
  }
}

/**
 * Register palette commands. Never throws and never hands an unvalidated value
 * to the host: an absent `ctx.command.transform` (older host, or a non-command
 * context) is reported once and the registration is a no-op.
 */
export function registerCommands(
  api: CommandApi | undefined,
  candidates: readonly unknown[],
  options: RegisterCommandsOptions,
): CommandRegistrationResult {
  const { logger } = options
  const registry = options.registry ?? processCommandRegistry
  const batch = new Set<string>()
  const taken = { has: (name: string): boolean => batch.has(name) || registry.has(name) }

  const accepted: CommandEntry[] = []
  const rejected: CommandValidationIssue[] = []
  candidates.forEach((candidate, index) => {
    const verdict = validateCommandEntry(candidate, index, taken)
    if (!verdict.ok) {
      rejected.push(verdict.issue)
      logger.warn('命令未注册：候选载荷未通过校验（已被拦下，不会进入宿主注册表）', {
        index: verdict.issue.index,
        name: verdict.issue.name,
        reason: verdict.issue.reason,
      })
      return
    }
    batch.add(verdict.entry.name)
    accepted.push(verdict.entry)
  })

  const transform = api?.transform
  if (typeof transform !== 'function') {
    logger.warn('宿主未提供 ctx.command.transform，本次不注册命令面板项（自动登录仍照常工作）')
    return { registered: [], rejected }
  }

  const registered: string[] = []
  try {
    transform((draft) => {
      if (draft === null || typeof draft !== 'object') return
      const add = (draft as CommandDraft).add
      if (typeof add !== 'function') {
        logger.warn('命令草稿未提供 add，本次不注册命令面板项')
        return
      }
      for (const entry of accepted) {
        // The one and only payload shape that crosses into the host.
        const payload: CommandAddPayload = {
          name: entry.name,
          description: entry.description,
          execute: entry.execute,
        }
        try {
          const result = add(payload)
          if (result instanceof Map && !result.has(entry.name)) {
            // `add` swallowed a schema error: the command is NOT in the host's
            // registry, so it must not be reported as registered either.
            rejected.push({ index: -1, name: entry.name, reason: '宿主注册结果中不含该命令（schema 错误被 add 吞掉）' })
            logger.warn('宿主命令注册结果中缺少该命令（宿主 schema 可能吞掉了错误）', { name: entry.name })
            continue
          }
          registered.push(entry.name)
        } catch (error) {
          logger.warn('命令注册被宿主拒绝', { name: entry.name, error: errorName(error) })
        }
      }
    })
  } catch (error) {
    logger.warn('命令注册失败，命令面板项不可用（自动登录仍照常工作）', { error: errorName(error) })
    return { registered, rejected }
  }
  for (const name of registered) registry.claim(name)
  return { registered, rejected }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 80)
  return value === null ? 'null' : typeof value
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
