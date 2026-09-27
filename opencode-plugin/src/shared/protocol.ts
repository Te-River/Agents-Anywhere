/**
 * Shared wire contract between the OpenCode plugin (bridge) and the Agents
 * Anywhere Connector. Everything here is mirrored, field for field, by
 * `connector/connector/runtimes/opencode/bridge/*.py` — keep the two in sync.
 */

import { createHash } from 'node:crypto'

export const RUNTIME = 'opencode'
export const PROTOCOL_VERSION = '1.0'
export const PROTOCOL_MAJOR = 1
/** One JSON-RPC frame may not exceed 8 MiB (aligned with the Connector client). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024
export const ENDPOINT_VERSION = 1
export const ENDPOINT_FILENAME_PATTERN = /^\d+-\d+\.json$/

/**
 * C→B methods the bridge serves in P1. Everything else is rejected.
 *
 * `runtime.sync.subscribe` / `runtime.sync.ack` are the push-sync surface
 * (design §2.3): the Connector opens a calibration and the Hub answers the
 * checkpoint ack. Both are requests on the wire (the Connector sends `ack` with
 * an id and expects a result), so they belong to the served-method allowlist.
 */
export const RPC_METHODS = {
  initialize: 'initialize',
  ping: 'ping',
  runtimeGetCapabilities: 'runtime.getCapabilities',
  sessionList: 'session.list',
  sessionGetSnapshot: 'session.getSnapshot',
  sessionGetState: 'session.getState',
  sessionGetNotices: 'session.getNotices',
  runtimeSyncSubscribe: 'runtime.sync.subscribe',
  runtimeSyncAck: 'runtime.sync.ack',
} as const

export type ReadOnlyMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS]

export const READ_ONLY_METHODS: readonly string[] = Object.values(RPC_METHODS)

/**
 * C→B write methods served by the P3 bridge (design §2.3). Each is advertised by
 * a capability row; `session.steerTurn` is served *only* to answer with
 * `UNSUPPORTED_OPERATION` (V2 has no native steer — design rev2 §2.3).
 */
export const WRITE_METHODS = {
  sessionCreateAndStart: 'session.createAndStart',
  sessionStartTurn: 'session.startTurn',
  sessionSteerTurn: 'session.steerTurn',
  sessionInterrupt: 'session.interrupt',
  sessionUpdateSelections: 'session.updateSelections',
  sessionRespondInteraction: 'session.respondInteraction',
} as const

export type WriteMethod = (typeof WRITE_METHODS)[keyof typeof WRITE_METHODS]

export const WRITE_METHOD_LIST: readonly string[] = Object.values(WRITE_METHODS)

/**
 * Methods this runtime *knows* but does not serve (P3 scope). They are answered
 * with `-32601` + `error.data.code == "UNSUPPORTED_OPERATION"` — distinct from an
 * unknown method's `METHOD_NOT_FOUND` — so the Connector can tell "not
 * implemented here" from "you typed the wrong name". Both catalog rows are also
 * advertised as unavailable capabilities.
 */
export const CATALOG_METHODS = {
  listModels: 'catalog.listModels',
  listPermissions: 'catalog.listPermissions',
  /**
   * Agent directory (D3). `params {}` → `{ agents: [{ id, name?, description?,
   * mode, hidden }] }`, `mode ∈ {"primary","subagent","all"}`. Served from
   * `ctx.agent` when the host exposes it; otherwise answered
   * `UNSUPPORTED_OPERATION` like every other known-but-unserved method.
   */
  listAgents: 'catalog.listAgents',
} as const

export const CATALOG_METHOD_LIST: readonly string[] = Object.values(CATALOG_METHODS)

/** Notifications the bridge accepts from the peer (never answered). */
export const NOTIFICATION_METHODS = {
  runtimeSyncAck: 'runtime.sync.ack',
} as const

/** Notifications the bridge emits to the Connector (B→C, never a request). */
export const BRIDGE_NOTIFICATION_METHODS = {
  /** `sync.batch` — paginated history calibration and live updates. */
  syncBatch: 'sync.batch',
  /** `runtime.error` — a crash the Connector should correlate with its logs. */
  runtimeError: 'runtime.error',
  /**
   * `runtime.capability.updated` — the canonical capability-change notification,
   * byte-for-byte with `server/runtime_host.py` (the backend leg) and
   * `dsh-bridge-next/src/host/dsh-runtime/sync.ts`. The Hub would republish
   * `session.discovery` here when the state flips partial→complete, but that flip
   * is **unreachable today** (see README「已知限制」and `session-registry.ts`): the
   * registry only ever sees the global event stream, so no channel proves full
   * coverage. There is deliberately **no** emitter wired to this constant — do not
   * invent a fake trigger for it. It exists so the name has exactly one definition
   * when a full-reconciliation channel finally lands.
   */
  capabilityUpdated: 'runtime.capability.updated',
} as const

/**
 * `sync.batch` page phases, byte-for-byte with
 * `connector/runtimes/opencode/bridge/sync.py::PHASES`.
 */
export const SYNC_PHASES = ['begin', 'items', 'commit', 'notifications'] as const
export type SyncPhase = (typeof SYNC_PHASES)[number]

/**
 * Optional `historyHash` prefix digest: 64 lowercase hex, the exact rule the
 * Connector applies to its persisted checkpoint
 * (`bridge/sync.py::_checkpoint`). Anything else is treated as absent, so the
 * Hub falls back to a full snapshot rather than guessing.
 */
export const HISTORY_HASH_PATTERN = /^[0-9a-f]{64}$/

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unauthorized: -32001,
} as const

/** Stable machine-readable error codes carried in `error.data.code`. */
export const RPC_ERROR_DATA = {
  parseError: 'PARSE_ERROR',
  invalidRequest: 'INVALID_REQUEST',
  invalidParams: 'INVALID_PARAMS',
  methodNotFound: 'METHOD_NOT_FOUND',
  internalError: 'INTERNAL_ERROR',
  unauthorized: 'UNAUTHORIZED',
  runtimeMismatch: 'RUNTIME_MISMATCH',
  protocolIncompatible: 'PROTOCOL_INCOMPATIBLE',
  handshakeRequired: 'HANDSHAKE_REQUIRED',
  sessionNotFound: 'SESSION_NOT_FOUND',
  /** A served-but-unsupported operation (e.g. `session.steerTurn`). */
  unsupportedOperation: 'UNSUPPORTED_OPERATION',
  /** The host-side API behind a write method failed or is unavailable. */
  upstreamError: 'UPSTREAM_ERROR',
} as const

/**
 * Business outcomes of `session.respondInteraction` (§6). These are returned in a
 * *successful* JSON-RPC result as `{ok:false, code}` — not as RPC error frames —
 * so the Connector surfaces them as a plain operation result. `unsupported_action`
 * is what a remote `always` receives: the bridge never rewrites persistent rules.
 */
export const INTERACTION_RESULT_CODES = {
  unsupportedAction: 'unsupported_action',
  alreadyAnswered: 'already_answered',
  unknownNotice: 'unknown_notice',
  localConfirmationRequired: 'local_confirmation_required',
  replyUnavailable: 'reply_unavailable',
  /**
   * §6⑤: the notice exists and belongs to this session, but it is bound to a
   * *different* connector device. Distinct from `unknown_notice` so a device can
   * tell "not mine" from "no such notice".
   */
  deviceMismatch: 'device_mismatch',
  /**
   * §6⑤ fail-closed: the notice exists and matches this session, but no device
   * has claimed the session yet, so the notice carries no owner to compare
   * against. Remote answering is refused rather than degraded — a notice must be
   * bound to a claimed device before it can be answered from the wire. Distinct
   * from `unknown_notice` (no such notice) and `device_mismatch` (owned by
   * someone else).
   */
  unboundNotice: 'unbound_notice',
} as const

export type InteractionResultCode =
  (typeof INTERACTION_RESULT_CODES)[keyof typeof INTERACTION_RESULT_CODES]

/** Capability ids the Connector's provider config understands. */
export const CAPABILITY_IDS = {
  catalogModel: 'catalog.model',
  catalogPermission: 'catalog.permission',
  /** Agent directory (D3), derived from `install()`'s `ctx.agent` surface. */
  catalogAgent: 'catalog.agent',
  sessionSendMessage: 'session.send_message',
  sessionSteer: 'session.steer',
  sessionInterrupt: 'session.interrupt',
  sessionCommands: 'session.commands',
  sessionInteractionApproval: 'session.interaction.approval',
  runtimeAttachment: 'runtime.attachment',
  sessionList: 'session.list',
  sessionSnapshot: 'session.getSnapshot',
  sessionState: 'session.getState',
  sessionNotices: 'session.getNotices',
  /**
   * Session-discovery state carrier (rev3 ruling 2). The reported state rides
   * this row's `metadata.discoveryState` ∈ {"complete","partial"} — never a new
   * boolean, and never the old root `sessionDiscovery` field.
   */
  sessionDiscovery: 'session.discovery',
  /**
   * Subagent (opencode `task`-derived child) sessions.
   *
   * Measured (spike 02 §3.1–§3.3): a child session is an ordinary Session whose
   * own events (`session.created`/`renamed`/`agent.selected`, …) reach the global
   * stream carrying **its own** `sessionID`, so it is discovered and projected
   * exactly like any other session. What the runtime does **not** expose is the
   * parent/child linkage: the runtime `session.created` payload has no `info`
   * (hence no `parentID`/`agent`), `ctx.session.get` returns no `parentID`/
   * children, and the SDK's `GET /session/{id}/children` is 404 on this build.
   *
   * The row's boolean therefore means **event visibility only**. The parent/child
   * binding is carried by a separate, TUI-only channel: the TUI plugin enumerates
   * sessions via the host SDK client (`api.client.session.list`, whose v2
   * `Session` type carries `parentID`) and publishes `session-index.json`; the Hub
   * reads it. So `metadata.parentRelation` is `"supported"` (with
   * `metadata.parentRelationSource === "tui-session-index"`) **only while that
   * index is fresh**, and `"unavailable"` with a reason otherwise. Never read
   * `supported:true` here as "subagents can always be attributed to their parent".
   */
  sessionSubagents: 'session.subagents',
} as const

/** Timeline item vocabulary (mirrors `runtime_protocol/timeline.py`). */
export const TIMELINE_TYPES = [
  'turn.start',
  'turn.end',
  'message',
  'tool',
  'artifact',
  'marker',
  'system',
] as const
export type TimelineType = (typeof TIMELINE_TYPES)[number]

export const TIMELINE_STATUSES = [
  'pending',
  'inProgress',
  'running',
  'waiting_approval',
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'hidden',
] as const
export type TimelineStatus = (typeof TIMELINE_STATUSES)[number]

export const TIMELINE_ROLES = ['user', 'assistant', 'system', 'tool'] as const
export type TimelineRole = (typeof TIMELINE_ROLES)[number]

export type JsonObject = Record<string, unknown>

/** A canonical, platform-facing timeline item (Connector wire shape). */
export interface TimelineItem {
  id: string
  sessionId: string
  type: TimelineType
  status: TimelineStatus
  orderSeq: number
  contentHash: string
  role: TimelineRole | null
  turnId: string | null
  content: JsonObject
  source: JsonObject
  revision: number
  metadata: JsonObject
}

export interface SessionMetaWire {
  sessionId: string
  externalSessionId: string
  runtime: typeof RUNTIME
  title?: string
  cwd?: string
  orderingTime?: string
  metadata: JsonObject
}

export interface CapabilityWire {
  capabilityId: string
  scope: 'runtime' | 'session'
  runtime: typeof RUNTIME
  version: string
  supported: boolean
  available: boolean
  allowed: boolean
  unavailableReason?: string
  metadata: JsonObject
}

export interface CapabilitySetWire {
  runtime: typeof RUNTIME
  revision: number
  capabilities: CapabilityWire[]
  metadata: JsonObject
}

/** `metadata.discoveryState` values carried by the `session.discovery` row. */
export const DISCOVERY_STATES = ['complete', 'partial'] as const
export type DiscoveryState = (typeof DISCOVERY_STATES)[number]

/** Runtime status vocabulary (mirrors `runtime_protocol/models.py`). */
export const RUNTIME_STATUSES = [
  'idle',
  'waiting',
  'pending',
  'running',
  'stopping',
  'waiting_approval',
  'blocked',
  'error',
  'disconnected',
] as const
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number]

/**
 * Canonical JSON: keys sorted recursively, no whitespace, non-finite numbers
 * rejected. Byte-for-byte compatible with Python's
 * `json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":"))`
 * for the JSON subset used by timeline content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
      return `{${keys
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`
    }
    default:
      // undefined / function / symbol never appear in timeline content.
      return 'null'
  }
}

/**
 * Content hash verified by the Connector (`timeline_content_hash`).
 * `role` participates as JSON `null` when absent, exactly like Python `None`.
 */
export function contentHash(
  type: TimelineType,
  status: TimelineStatus,
  role: TimelineRole | null,
  content: JsonObject,
): string {
  const payload = { content, role: role ?? null, status, type }
  return `sha256:${sha256Hex(canonicalJson(payload))}`
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Platform session identity, mirroring
 * `stable_runtime_session_id` / the DSH host's `platformSessionId`:
 * `sess_opencode_<sha256(namespace:opencode:externalId)[:24]>`.
 */
export function platformSessionId(namespace: string, externalSessionId: string): string {
  return `sess_opencode_${sha256Hex(`${namespace}:${RUNTIME}:${externalSessionId}`).slice(0, 24)}`
}

/** Deterministic, content-addressed item id so snapshots stay stable. */
export function timelineItemId(nativeKey: string): string {
  return `itm_${sha256Hex(nativeKey).slice(0, 24)}`
}

export function protocolMajor(version: unknown): number | null {
  if (typeof version !== 'string') return null
  const [major] = version.split('.')
  if (major === undefined || major.length === 0) return null
  const parsed = Number(major)
  return Number.isInteger(parsed) ? parsed : null
}
