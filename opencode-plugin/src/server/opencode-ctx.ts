/**
 * Structural types for the OpenCode V2 plugin context.
 *
 * The published `@opencode-ai/plugin` types lag the 2.0.x runtime badly (they
 * lack `ctx.permission` / `ctx.event` / `ctx.rpc` and miss 6 emitted event
 * names), so the plugin declares only the surface it actually touches and
 * probes every member at runtime. Nothing here is imported from the host.
 */

/** Event envelope as measured at runtime (P0 spike, opencode-cli 2.0.18). */
export interface OpenCodeEvent {
  id?: string
  created?: string
  type?: string
  durable?: {
    aggregateID?: string
    seq?: number
    version?: number
  }
  location?: {
    directory?: string
    workspaceID?: string
  }
  data?: Record<string, unknown>
}

export type OpenCodeEventStream = AsyncIterable<OpenCodeEvent>

export interface PermissionEvaluatePayload {
  sessionID?: string
  agent?: string
  action?: string
  resources?: unknown
  metadata?: unknown
  source?: unknown
  effect?: string
}

export interface Disposable {
  dispose?: () => void
}

export type PermissionHook = (
  name: string,
  callback: (payload: PermissionEvaluatePayload) => unknown,
) => Disposable | void

export interface PermissionApi {
  hook?: PermissionHook
  reply?: PermissionReply
  list?: unknown
  get?: unknown
}

/**
 * `ctx.permission.reply` shape, measured in the P0 spike (opencode-cli 2.0.18):
 * a single object mirroring the SDK route — `{path:{requestID}, body:{reply}}`
 * with `reply ∈ {"once","always","reject"}`. The bridge only ever sends `once`
 * or `reject`; `always` would rewrite the persistent rules (§6).
 */
export interface PermissionReplyRequest {
  path: { requestID: string }
  body: { reply: 'once' | 'always' | 'reject'; message?: string }
  query?: { directory?: string; workspace?: string }
}

export type PermissionReply = (request: PermissionReplyRequest) => unknown

export interface EventApi {
  subscribe?: (type?: string) => OpenCodeEventStream
}

export interface LocationApi {
  directory?: string
  workspaceID?: string
}

export interface AppApi {
  version?: string
}

/**
 * `ctx.session` write methods. Their arity/shape is **unverified** beyond the
 * measured `ctx.session.context({sessionID})` (research doc 02): the published
 * SDK types lag the runtime, so each method is probed by `typeof === "function"`
 * at call time and invoked with a single options object carrying `sessionID`.
 */
export type SessionMethod = (options: Record<string, unknown>) => unknown

export interface SessionApi {
  create?: SessionMethod
  get?: SessionMethod
  prompt?: SessionMethod
  interrupt?: SessionMethod
  switchModel?: SessionMethod
  switchAgent?: SessionMethod
  update?: SessionMethod
}

/**
 * `ctx.agent` (2.0.18, A10 probe). `list()` returns `{ location, data: [] }` (an
 * object, not an array); `transform(cb)`'s draft exposes
 * `{ list, get, default, update, remove }`. Both are optional so the hub can
 * derive `catalog.agent` availability from what the host really exposes.
 */
export interface AgentV2Info {
  id?: string
  name?: string
  description?: string
  system?: string
  request?: unknown
  /** `"primary" | "subagent" | "all"` per the published AgentV2Info type. */
  mode?: string
  /** Whether the agent is hidden from selection. Filtering semantics unverified. */
  hidden?: boolean
  permissions?: unknown
}

export interface AgentApi {
  list?: () => unknown
  get?: (id: string) => unknown
  transform?: (callback: (draft: unknown) => void) => unknown
  reload?: () => unknown
}

/**
 * `ctx.model` (2.0.18). The A10 probe recorded the domain as an object but did
 * **not** expand its item shape, so no field here is asserted beyond optionality;
 * the hub maps defensively.
 */
export interface ModelV2Info {
  id?: string
  modelID?: string
  name?: string
  title?: string
  description?: string
  providerID?: string
  [key: string]: unknown
}

export interface ModelApi {
  list?: () => unknown
  get?: (id: string) => unknown
  transform?: (callback: (draft: unknown) => void) => unknown
  reload?: () => unknown
}

/**
 * `ctx.command` (measured at runtime on opencode-cli 2.0.18): the service plugin
 * registers palette commands through `transform(draft => draft.add(info))`.
 *
 * Two facts from that measurement shape this type:
 *   1. the draft exposes **only** `add` at runtime, although the published
 *      `dist/v2/effect/command.d.ts` still declares `{list,get,update,remove}` —
 *      the installed types are stale, so nothing but `add` is relied on here;
 *   2. `add` takes a **single object** (`Command.Info = {name, description?}`)
 *      plus the `execute` the command runs, and **swallows schema errors**
 *      instead of throwing. A non-string `name` therefore poisons the whole
 *      registry (the host answers `GET /api/command` with 500). Validation
 *      happens in `commands.ts` *before* anything reaches `add`.
 */
export interface CommandAddPayload {
  name: string
  description?: string
  execute?: (ctx?: unknown) => unknown
}

export interface CommandDraft {
  add?: (info: CommandAddPayload) => unknown
}

export interface CommandApi {
  transform?: (callback: (draft: CommandDraft) => void) => unknown
  /** Present on some hosts; never required (the runtime draft has only `add`). */
  list?: () => unknown
  get?: unknown
}

export interface OpenCodePluginContext {
  app?: AppApi
  location?: LocationApi
  event?: EventApi
  permission?: PermissionApi
  session?: SessionApi
  agent?: AgentApi
  model?: ModelApi
  command?: CommandApi
  options?: unknown
}

export type Cleanup = () => void | Promise<void>

/** The shape the host requires: an object with `id` and `setup`/`effect`. */
export interface OpenCodePluginModule {
  id: string
  setup?: (ctx: OpenCodePluginContext) => Promise<Cleanup> | Cleanup
  effect?: (ctx: OpenCodePluginContext) => Promise<Cleanup> | Cleanup
}

export function readDirectory(ctx: OpenCodePluginContext | undefined): string | null {
  const directory = ctx?.location?.directory
  return typeof directory === 'string' && directory.length > 0 ? directory : null
}

export function readServiceVersion(ctx: OpenCodePluginContext | undefined): string | undefined {
  const version = ctx?.app?.version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}
