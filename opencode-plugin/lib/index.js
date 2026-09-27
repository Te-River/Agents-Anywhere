import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { constants, existsSync, promises, realpathSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { execFile, spawn } from "node:child_process";
import { access, appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer as createServer$1 } from "node:http";
import { promisify } from "node:util";
//#region src/shared/protocol.ts
/**
* Shared wire contract between the OpenCode plugin (bridge) and the Agents
* Anywhere Connector. Everything here is mirrored, field for field, by
* `connector/connector/runtimes/opencode/bridge/*.py` — keep the two in sync.
*/
const RUNTIME = "opencode";
/**
* C→B methods the bridge serves in P1. Everything else is rejected.
*
* `runtime.sync.subscribe` / `runtime.sync.ack` are the push-sync surface
* (design §2.3): the Connector opens a calibration and the Hub answers the
* checkpoint ack. Both are requests on the wire (the Connector sends `ack` with
* an id and expects a result), so they belong to the served-method allowlist.
*/
const RPC_METHODS = {
	initialize: "initialize",
	ping: "ping",
	runtimeGetCapabilities: "runtime.getCapabilities",
	sessionList: "session.list",
	sessionGetSnapshot: "session.getSnapshot",
	sessionGetState: "session.getState",
	sessionGetNotices: "session.getNotices",
	runtimeSyncSubscribe: "runtime.sync.subscribe",
	runtimeSyncAck: "runtime.sync.ack"
};
const READ_ONLY_METHODS = Object.values(RPC_METHODS);
/**
* C→B write methods served by the P3 bridge (design §2.3). Each is advertised by
* a capability row; `session.steerTurn` is served *only* to answer with
* `UNSUPPORTED_OPERATION` (V2 has no native steer — design rev2 §2.3).
*/
const WRITE_METHODS = {
	sessionCreateAndStart: "session.createAndStart",
	sessionStartTurn: "session.startTurn",
	sessionSteerTurn: "session.steerTurn",
	sessionInterrupt: "session.interrupt",
	sessionUpdateSelections: "session.updateSelections",
	sessionRespondInteraction: "session.respondInteraction"
};
const WRITE_METHOD_LIST = Object.values(WRITE_METHODS);
/**
* Methods this runtime *knows* but does not serve (P3 scope). They are answered
* with `-32601` + `error.data.code == "UNSUPPORTED_OPERATION"` — distinct from an
* unknown method's `METHOD_NOT_FOUND` — so the Connector can tell "not
* implemented here" from "you typed the wrong name". Both catalog rows are also
* advertised as unavailable capabilities.
*/
const CATALOG_METHODS = {
	listModels: "catalog.listModels",
	listPermissions: "catalog.listPermissions",
	/**
	* Agent directory (D3). `params {}` → `{ agents: [{ id, name?, description?,
	* mode, hidden }] }`, `mode ∈ {"primary","subagent","all"}`. Served from
	* `ctx.agent` when the host exposes it; otherwise answered
	* `UNSUPPORTED_OPERATION` like every other known-but-unserved method.
	*/
	listAgents: "catalog.listAgents"
};
const CATALOG_METHOD_LIST = Object.values(CATALOG_METHODS);
/** Notifications the bridge emits to the Connector (B→C, never a request). */
const BRIDGE_NOTIFICATION_METHODS = {
	/** `sync.batch` — paginated history calibration and live updates. */
	syncBatch: "sync.batch",
	/** `runtime.error` — a crash the Connector should correlate with its logs. */
	runtimeError: "runtime.error",
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
	capabilityUpdated: "runtime.capability.updated"
};
/**
* Optional `historyHash` prefix digest: 64 lowercase hex, the exact rule the
* Connector applies to its persisted checkpoint
* (`bridge/sync.py::_checkpoint`). Anything else is treated as absent, so the
* Hub falls back to a full snapshot rather than guessing.
*/
const HISTORY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RPC_ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
	unauthorized: -32001
};
/** Stable machine-readable error codes carried in `error.data.code`. */
const RPC_ERROR_DATA = {
	parseError: "PARSE_ERROR",
	invalidRequest: "INVALID_REQUEST",
	invalidParams: "INVALID_PARAMS",
	methodNotFound: "METHOD_NOT_FOUND",
	internalError: "INTERNAL_ERROR",
	unauthorized: "UNAUTHORIZED",
	runtimeMismatch: "RUNTIME_MISMATCH",
	protocolIncompatible: "PROTOCOL_INCOMPATIBLE",
	handshakeRequired: "HANDSHAKE_REQUIRED",
	sessionNotFound: "SESSION_NOT_FOUND",
	/** A served-but-unsupported operation (e.g. `session.steerTurn`). */
	unsupportedOperation: "UNSUPPORTED_OPERATION",
	/** The host-side API behind a write method failed or is unavailable. */
	upstreamError: "UPSTREAM_ERROR"
};
/**
* Business outcomes of `session.respondInteraction` (§6). These are returned in a
* *successful* JSON-RPC result as `{ok:false, code}` — not as RPC error frames —
* so the Connector surfaces them as a plain operation result. `unsupported_action`
* is what a remote `always` receives: the bridge never rewrites persistent rules.
*/
const INTERACTION_RESULT_CODES = {
	unsupportedAction: "unsupported_action",
	alreadyAnswered: "already_answered",
	unknownNotice: "unknown_notice",
	localConfirmationRequired: "local_confirmation_required",
	replyUnavailable: "reply_unavailable",
	/**
	* §6⑤: the notice exists and belongs to this session, but it is bound to a
	* *different* connector device. Distinct from `unknown_notice` so a device can
	* tell "not mine" from "no such notice".
	*/
	deviceMismatch: "device_mismatch",
	/**
	* §6⑤ fail-closed: the notice exists and matches this session, but no device
	* has claimed the session yet, so the notice carries no owner to compare
	* against. Remote answering is refused rather than degraded — a notice must be
	* bound to a claimed device before it can be answered from the wire. Distinct
	* from `unknown_notice` (no such notice) and `device_mismatch` (owned by
	* someone else).
	*/
	unboundNotice: "unbound_notice"
};
/** Capability ids the Connector's provider config understands. */
const CAPABILITY_IDS = {
	catalogModel: "catalog.model",
	catalogPermission: "catalog.permission",
	/** Agent directory (D3), derived from `install()`'s `ctx.agent` surface. */
	catalogAgent: "catalog.agent",
	sessionSendMessage: "session.send_message",
	sessionSteer: "session.steer",
	sessionInterrupt: "session.interrupt",
	sessionCommands: "session.commands",
	sessionInteractionApproval: "session.interaction.approval",
	runtimeAttachment: "runtime.attachment",
	sessionList: "session.list",
	sessionSnapshot: "session.getSnapshot",
	sessionState: "session.getState",
	sessionNotices: "session.getNotices",
	/**
	* Session-discovery state carrier (rev3 ruling 2). The reported state rides
	* this row's `metadata.discoveryState` ∈ {"complete","partial"} — never a new
	* boolean, and never the old root `sessionDiscovery` field.
	*/
	sessionDiscovery: "session.discovery",
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
	sessionSubagents: "session.subagents"
};
/**
* Canonical JSON: keys sorted recursively, no whitespace, non-finite numbers
* rejected. Byte-for-byte compatible with Python's
* `json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":"))`
* for the JSON subset used by timeline content.
*/
function canonicalJson(value) {
	if (value === null) return "null";
	switch (typeof value) {
		case "string": return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) throw new RangeError("canonicalJson: non-finite number");
			return JSON.stringify(value);
		case "boolean": return value ? "true" : "false";
		case "object": {
			if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
			const record = value;
			return `{${Object.keys(record).filter((key) => record[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
		}
		default: return "null";
	}
}
/**
* Content hash verified by the Connector (`timeline_content_hash`).
* `role` participates as JSON `null` when absent, exactly like Python `None`.
*/
function contentHash(type, status, role, content) {
	return `sha256:${sha256Hex(canonicalJson({
		content,
		role: role ?? null,
		status,
		type
	}))}`;
}
function sha256Hex(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
/**
* Platform session identity, mirroring
* `stable_runtime_session_id` / the DSH host's `platformSessionId`:
* `sess_opencode_<sha256(namespace:opencode:externalId)[:24]>`.
*/
function platformSessionId(namespace, externalSessionId) {
	return `sess_opencode_${sha256Hex(`${namespace}:${RUNTIME}:${externalSessionId}`).slice(0, 24)}`;
}
/** Deterministic, content-addressed item id so snapshots stay stable. */
function timelineItemId(nativeKey) {
	return `itm_${sha256Hex(nativeKey).slice(0, 24)}`;
}
function protocolMajor(version) {
	if (typeof version !== "string") return null;
	const [major] = version.split(".");
	if (major === void 0 || major.length === 0) return null;
	const parsed = Number(major);
	return Number.isInteger(parsed) ? parsed : null;
}
//#endregion
//#region src/shared/endpoint-store.ts
/**
* Endpoint registry files: `endpoints/<servicePid>-<port>.json`.
*
* Publication is atomic (tmp → fsync → replace) and the liveness oracle is a
* successful handshake, never the recorded pid, so stale files are only cleaned
* up when a probe says the endpoint is gone.
*/
const DATA_DIR_ENV = "AGENT_CONNECTOR_DATA_DIR";
const DATA_DIR_NAME = ".agents-anywhere";
const BRIDGE_DIR_NAME = "opencode-bridge";
const ENDPOINTS_DIR_NAME = "endpoints";
function endpointFileName(pid, port) {
	return `${pid}-${port}.json`;
}
/**
* Resolve the shared bridge directory (`<base>/opencode-bridge`), honours
* `AGENT_CONNECTOR_DATA_DIR`. Both the endpoint registry and the TUI-written
* session index live here.
*/
function bridgeDirectory(env = process.env) {
	const override = env[DATA_DIR_ENV];
	const base = override && override.trim().length > 0 ? override : join(homedir(), DATA_DIR_NAME);
	return join(base, BRIDGE_DIR_NAME);
}
/** Resolve the endpoints directory; honours `AGENT_CONNECTOR_DATA_DIR`. */
function endpointDirectory(env = process.env) {
	return join(bridgeDirectory(env), ENDPOINTS_DIR_NAME);
}
/** Leaf names of the plugin data dir (mirrors `credentials.PLUGIN_DIR_NAME`). */
const PLUGIN_DIR_NAME$1 = "opencode-plugin";
const CONNECTOR_DIR_NAME = "connector";
/**
* The data directory this plugin hands to the Connector it spawns as
* `AGENT_CONNECTOR_DATA_DIR` (`<base>/opencode-plugin/connector`), mirroring the
* supervisor's spawn env. Derived from `bridgeDirectory` so the
* `AGENT_CONNECTOR_DATA_DIR` override applies identically on both sides.
*/
function connectorDataDirectory(env = process.env) {
	return join(dirname(bridgeDirectory(env)), PLUGIN_DIR_NAME$1, CONNECTOR_DIR_NAME);
}
/**
* The endpoint registry the plugin's own spawned Connector actually scans:
* `<connector data dir>/opencode-bridge/endpoints`. Resolved through the same
* `AGENT_CONNECTOR_DATA_DIR` convention as every other endpoint directory.
*/
function connectorEndpointDirectory(env = process.env) {
	return endpointDirectory({
		...env,
		[DATA_DIR_ENV]: connectorDataDirectory(env)
	});
}
/**
* Every registry this plugin publishes the same record into: the shared
* default (`<base>/opencode-bridge/endpoints`) and the registry of the
* Connector this plugin spawns. Without the second entry a Connector launched
* with `AGENT_CONNECTOR_DATA_DIR=<base>/opencode-plugin/connector` never sees
* the bridge endpoint.
*/
function endpointDirectories(env = process.env) {
	return [.../* @__PURE__ */ new Set([endpointDirectory(env), connectorEndpointDirectory(env)])];
}
/**
* Atomically publish `record`. The reader either sees the previous file or the
* complete new one — never a partial write.
*/
async function publishEndpoint(directory, record) {
	await promises.mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const target = join(directory, endpointFileName(record.pid, record.port));
	const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await promises.open(tmp, "w", 384);
	try {
		await handle.writeFile(JSON.stringify(record), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await promises.rename(tmp, target);
	} catch (error) {
		await promises.rm(tmp, { force: true }).catch(() => void 0);
		throw error;
	}
	await fsyncDirectory(directory);
	return target;
}
async function removeEndpoint(path) {
	await promises.rm(path, { force: true });
}
function makeEndpointRecord(input) {
	return {
		version: 1,
		runtime: RUNTIME,
		protocolVersion: "1.0",
		bridgeId: input.bridgeId,
		host: "127.0.0.1",
		port: input.port,
		token: input.token,
		pid: input.pid,
		...input.serviceVersion !== void 0 ? { serviceVersion: input.serviceVersion } : {},
		locations: [...input.locations],
		startedAt: input.startedAt ?? (/* @__PURE__ */ new Date()).toISOString()
	};
}
async function fsyncDirectory(directory) {
	try {
		const handle = await promises.open(directory, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {}
}
//#endregion
//#region src/shared/session-index.ts
const SESSION_INDEX_FILENAME = "session-index.json";
/** `<bridge dir>/session-index.json` (honours `AGENT_CONNECTOR_DATA_DIR`). */
function sessionIndexPath(env = process.env) {
	return join(bridgeDirectory(env), SESSION_INDEX_FILENAME);
}
/**
* Coerce one raw session entry into an `IndexedSession`. A missing/empty `id`
* makes the entry unusable (`null`) rather than allowing an unattributable row;
* every optional field is copied **only** when it is a non-empty string, so a
* field the runtime did not send is never fabricated.
*/
function toIndexedSession(value) {
	if (value === null || typeof value !== "object") return null;
	const record = value;
	const id = record["id"];
	if (typeof id !== "string" || id.length === 0) return null;
	const session = { id };
	const parentID = record["parentID"];
	if (typeof parentID === "string" && parentID.length > 0) session.parentID = parentID;
	const title = record["title"];
	if (typeof title === "string" && title.length > 0) session.title = title;
	const agent = record["agent"];
	if (typeof agent === "string" && agent.length > 0) session.agent = agent;
	const location = record["directory"] ?? record["location"];
	if (typeof location === "string" && location.length > 0) session.location = location;
	return session;
}
/** Parse an index file; a structurally invalid document returns `null`. */
function parseSessionIndex(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object") return null;
	const record = value;
	const updatedAt = record["updatedAt"];
	if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return null;
	const rawSessions = record["sessions"];
	if (!Array.isArray(rawSessions)) return null;
	const sessions = [];
	for (const entry of rawSessions) {
		const session = toIndexedSession(entry);
		if (session !== null) sessions.push(session);
	}
	return {
		updatedAt,
		sessions
	};
}
/** Build session id → parent id from a snapshot (only entries that have a parent). */
function indexParents(snapshot) {
	const parents = /* @__PURE__ */ new Map();
	for (const session of snapshot.sessions) if (session.parentID !== void 0 && session.parentID !== session.id) parents.set(session.id, session.parentID);
	return parents;
}
/**
* Fail-soft reader for the TUI-written index.
*
* `refresh()` never throws: a missing, unreadable, corrupt or unexpected file
* simply leaves the index unavailable. `state` folds the last load outcome with
* the freshness window, and every consumer (`isChild`, `parentOf`) is gated on
* `available`, so an expired index behaves exactly like no index at all — the
* Hub then reports `parentRelation: "unavailable"` instead of acting on stale
* data.
*/
var SessionIndex = class {
	#path;
	#maxAgeMs;
	#maxSkewMs;
	#reloadIntervalMs;
	#now;
	#logger;
	#snapshot = null;
	#parents = /* @__PURE__ */ new Map();
	#loadState = "missing";
	#lastAttempt = 0;
	#refreshing = false;
	constructor(options = {}) {
		this.#path = options.path ?? sessionIndexPath();
		this.#maxAgeMs = options.maxAgeMs ?? 3e5;
		this.#maxSkewMs = options.maxSkewMs ?? 12e4;
		this.#reloadIntervalMs = options.reloadIntervalMs ?? 3e4;
		this.#now = options.now ?? Date.now;
		this.#logger = options.logger;
	}
	get path() {
		return this.#path;
	}
	/** Freshness verdict: `fresh` is the only state a consumer may act on. */
	get state() {
		if (this.#snapshot === null) return this.#loadState;
		return this.#freshness(this.#snapshot.updatedAt);
	}
	get available() {
		return this.state === "fresh";
	}
	get updatedAt() {
		return this.#snapshot?.updatedAt ?? null;
	}
	/** Sessions the TUI last reported (not necessarily fresh). */
	get sessions() {
		return this.#snapshot?.sessions ?? [];
	}
	/** Child session ids, empty unless the index is usable. */
	get childIds() {
		return this.available ? new Set(this.#parents.keys()) : /* @__PURE__ */ new Set();
	}
	isChild(nativeId) {
		return this.available && this.#parents.has(nativeId);
	}
	parentOf(nativeId) {
		if (!this.available) return null;
		return this.#parents.get(nativeId) ?? null;
	}
	/**
	* Reload the file. Never rejects and never throws synchronously: every failure
	* mode becomes an unavailable state (`missing` / `invalid`), so the Hub's
	* capability row and session list stay honest.
	*/
	async refresh() {
		this.#lastAttempt = this.#now();
		this.#refreshing = true;
		try {
			const snapshot = parseSessionIndex(await promises.readFile(this.#path, "utf8"));
			if (snapshot === null) {
				this.#forget("invalid");
				this.#logger?.debug("session index is unreadable; parent relation stays unavailable", { path: this.#path });
				return;
			}
			this.#snapshot = snapshot;
			this.#parents = indexParents(snapshot);
			this.#logger?.debug("session index loaded", {
				sessions: snapshot.sessions.length,
				children: this.#parents.size
			});
		} catch (error) {
			this.#forget(isMissing$1(error) ? "missing" : "invalid");
		} finally {
			this.#refreshing = false;
		}
	}
	/**
	* Fire-and-forget reload for synchronous request paths, throttled so a burst
	* of requests cannot turn into a burst of reads. Safe to call unconditionally.
	*/
	maybeRefresh() {
		if (this.#refreshing) return;
		if (this.#now() - this.#lastAttempt < this.#reloadIntervalMs) return;
		this.refresh().catch(() => void 0);
	}
	#forget(loadState) {
		this.#snapshot = null;
		this.#parents = /* @__PURE__ */ new Map();
		this.#loadState = loadState;
	}
	#freshness(updatedAt) {
		const parsed = Date.parse(updatedAt);
		if (Number.isNaN(parsed)) return "invalid";
		const age = this.#now() - parsed;
		if (age < -this.#maxSkewMs) return "invalid";
		if (age > this.#maxAgeMs) return "expired";
		return "fresh";
	}
};
function isMissing$1(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
//#endregion
//#region src/shared/logger.ts
const SECRET_KEY = /(token|secret|code|auth|password|credential|verifier|signature|apikey|api_key)/i;
const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
/** Deep-copy `value`, masking any value held under a secret-looking key. */
function redact(value, depth = 0) {
	if (depth > MAX_DEPTH) return "[truncated]";
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
	const output = {};
	for (const [key, entry] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? REDACTED : redact(entry, depth + 1);
	return output;
}
const defaultSink = (level, scope, message, fields) => {
	const line = `[agents-anywhere-opencode] ${level} ${scope} ${message}`;
	const payload = redact(fields);
	const text = payload && typeof payload === "object" && Object.keys(payload).length > 0 ? `${line} ${JSON.stringify(payload)}` : line;
	if (level === "error") console.error(text);
	else if (level === "warn") console.warn(text);
	else console.log(text);
};
/** Create a scoped logger. `sink` is injectable for tests. */
function createLogger(scope, sink = defaultSink) {
	const emit = (level) => (message, fields = {}) => {
		try {
			sink(level, scope, message, redact(fields));
		} catch {}
	};
	return {
		debug: emit("debug"),
		info: emit("info"),
		warn: emit("warn"),
		error: emit("error")
	};
}
//#endregion
//#region src/shared/version-gate.ts
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
const OPENCODE_MIN_VERSION = "2.0.6";
const OPENCODE_MAX_EXCLUSIVE = "3.0.0";
const OPENCODE_SUPPORTED_RANGE = `>=${OPENCODE_MIN_VERSION} <${OPENCODE_MAX_EXCLUSIVE}`;
/** Versions actually measured/observed on a host (basis for the range above). */
const OPENCODE_VALIDATED_VERSIONS = ["2.0.16", "2.0.18"];
const MIN = [
	2,
	0,
	6
];
const MAX = [
	3,
	0,
	0
];
/**
* Parse `2.0.18` / `v2.1` / `2` / `2.1.0-beta.1` into a `[major, minor, patch]`
* triple. Anything without a leading numeric component (e.g. `nightly`) → `null`.
*/
function parseVersion(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().replace(/^v/i, "");
	if (trimmed.length === 0) return null;
	const numbers = [];
	for (const part of trimmed.split(".").slice(0, 3)) {
		const raw = /^(\d+)/.exec(part)?.[1];
		if (raw === void 0) return null;
		numbers.push(Number.parseInt(raw, 10));
	}
	const [major, minor, patch] = numbers;
	if (major === void 0) return null;
	return [
		major,
		minor ?? 0,
		patch ?? 0
	];
}
function compareTriples(a, b) {
	const [am, ai, ap] = a;
	const [bm, bi, bp] = b;
	if (am !== bm) return am < bm ? -1 : 1;
	if (ai !== bi) return ai < bi ? -1 : 1;
	if (ap !== bp) return ap < bp ? -1 : 1;
	return 0;
}
/**
* Evaluate a reported host version against the supported range. Never throws:
* an unavailable or unparseable version yields `supported:null` plus a recorded
* reason, so the caller can skip the gate honestly instead of assuming `true`.
*/
function evaluateHostVersion(version, source = "ctx.app.version") {
	if (version === void 0 || version === null || version.trim().length === 0) return {
		version: null,
		source: "unknown",
		supported: null,
		reason: "host version unavailable; the version gate is skipped",
		warning: null
	};
	const parsed = parseVersion(version);
	if (parsed === null) return {
		version,
		source,
		supported: null,
		reason: `host version "${version}" is not a semver triple; the version gate is skipped`,
		warning: null
	};
	if (compareTriples(parsed, MIN) < 0) {
		const reason = `host version ${version} is below the supported minimum ${OPENCODE_MIN_VERSION}`;
		return {
			version,
			source,
			supported: false,
			reason,
			warning: hostWarning(version, reason)
		};
	}
	if (compareTriples(parsed, MAX) >= 0) {
		const reason = `host version ${version} is at or above the unsupported ceiling ${OPENCODE_MAX_EXCLUSIVE}`;
		return {
			version,
			source,
			supported: false,
			reason,
			warning: hostWarning(version, reason)
		};
	}
	return {
		version,
		source,
		supported: true,
		reason: null,
		warning: null
	};
}
function hostWarning(version, reason) {
	return `宿主 OpenCode 版本 ${version} 不在支持范围 ${OPENCODE_SUPPORTED_RANGE}：本插件按 V2 的 ctx/hook/TUI 契约实现（已在 ${OPENCODE_VALIDATED_VERSIONS.join("/")} 实测），可能出现能力缺失、权限审批失效或 TUI 命令不可用。请升级/切换到受支持的 OpenCode 版本；详见 opencode-plugin/README.md「版本门」。(${reason})`;
}
//#endregion
//#region src/server/opencode-ctx.ts
function readDirectory(ctx) {
	const directory = ctx?.location?.directory;
	return typeof directory === "string" && directory.length > 0 ? directory : null;
}
function readServiceVersion(ctx) {
	const version = ctx?.app?.version;
	return typeof version === "string" && version.length > 0 ? version : void 0;
}
//#endregion
//#region src/server/paths.ts
/** Path normalisation shared by location filtering (rev3 ruling 1). */
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
function normalizeDirectory(directory) {
	const unified = (realpathOrNull(directory) ?? resolve(directory)).replaceAll("\\", "/").replace(/\/+$/, "");
	return process.platform === "win32" ? unified.toLowerCase() : unified;
}
/**
* Is this a usable, absolute `location`? The Hub rejects an opencode
* handshake whose location is missing, empty or relative (fail-closed).
*/
function isAbsoluteDirectory(directory) {
	return directory.length > 0 && isAbsolute(directory);
}
function realpathOrNull(directory) {
	try {
		return realpathSync.native(directory);
	} catch {
		return null;
	}
}
//#endregion
//#region src/shared/permission-policy.ts
const REMOTE_ALLOW_ACTION = "allow_once";
const REMOTE_DENY_ACTION = "deny";
/** The only action ids a remote peer is ever allowed to send. */
const REMOTE_PERMISSION_ACTIONS = [REMOTE_ALLOW_ACTION, REMOTE_DENY_ACTION];
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
const READ_ONLY_ACTIONS = /* @__PURE__ */ new Set([
	"read",
	"view",
	"cat",
	"ls",
	"list",
	"glob",
	"grep",
	"search",
	"find",
	"stat",
	"tree",
	"webfetch",
	"fetch",
	"websearch"
]);
function requiresLocalConfirmation(action) {
	if (action === null) return true;
	const normalized = action.trim().toLowerCase();
	if (normalized.length === 0) return true;
	return !READ_ONLY_ACTIONS.has(normalized);
}
function remoteActions(action) {
	if (requiresLocalConfirmation(action)) return [];
	return [{
		actionId: REMOTE_ALLOW_ACTION,
		label: "Allow once"
	}, {
		actionId: REMOTE_DENY_ACTION,
		label: "Deny"
	}];
}
/** True only for the two remote-actionable ids — never for `always`. */
function isRemoteActionId(actionId) {
	return REMOTE_PERMISSION_ACTIONS.includes(actionId);
}
//#endregion
//#region src/server/permission-bridge.ts
/**
* Neutral permission observer + remote-approval broker (§6, security-critical).
*
* `ctx.permission.hook("evaluate", cb)` is used **only** to record requests. The
* callback always returns `undefined`, which was measured to leave `effect`
* untouched (the request is not auto-allowed). Rewriting the effect by returning
* a string is assumption **A11** and is NOT proven, so no allow/deny decision is
* ever taken through the hook.
*
* The same object owns the remote-answer broker. A remote answer is accepted
* only when it is `allow_once` / `deny`, only once, only from the connection that
* owns the session, and only for a non-high-risk action — the actual decision is
* then applied through `ctx.permission.reply` (`once` / `reject`), never through
* the hook. `always` is refused everywhere: the bridge never rewrites the host's
* persistent permission rules.
*
* Note: `permission.hook` accepts any name without validation, so a successful
* registration must never be read as "this hook name is supported".
*/
var PermissionObserver = class {
	#logger;
	#audit;
	#observations = [];
	#approvals = /* @__PURE__ */ new Map();
	#disposable = null;
	#attached = false;
	#reply = null;
	#replyHost;
	constructor(logger, audit) {
		this.#logger = logger;
		this.#audit = audit;
	}
	/** Attach the evaluate hook. Fail-soft: absence disables remote approval only. */
	install(ctx) {
		const permission = ctx?.permission;
		this.#reply = typeof permission?.reply === "function" ? permission.reply : null;
		this.#replyHost = permission;
		if (this.#attached) return true;
		const hook = permission?.hook;
		if (typeof hook !== "function") {
			this.#logger.warn("permission.hook unavailable; remote approval stays disabled");
			return false;
		}
		try {
			const result = hook.call(permission, "evaluate", (payload) => {
				try {
					this.#record(payload);
				} catch {}
			});
			if (result !== null && typeof result === "object") this.#disposable = result;
			this.#attached = true;
			return true;
		} catch (error) {
			this.#logger.warn("permission hook registration failed", { error: error instanceof Error ? error.name : typeof error });
			return false;
		}
	}
	dispose() {
		try {
			this.#disposable?.dispose?.();
		} catch {}
		this.#disposable = null;
		this.#attached = false;
		this.#approvals.clear();
	}
	get observations() {
		return this.#observations;
	}
	get attached() {
		return this.#attached;
	}
	/** True when the host exposed `permission.reply` (capability derivation). */
	get replyAvailable() {
		return typeof this.#reply === "function";
	}
	/** Read-only view for tests and diagnostics. */
	pending(noticeId) {
		return this.#approvals.get(noticeId);
	}
	get pendingCount() {
		return this.#approvals.size;
	}
	/**
	* Track a native permission event so a remote answer can be validated. Fed from
	* the Hub's `ingest()` — the same accepted-event path the projector uses.
	*
	* @param ownerConnectorId §6⑤: the `initialize` connectorId of the connection
	*   that owns this session (recorded once, first claim wins).
	*/
	observe(event, ownerConnectorId = null) {
		const type = typeof event.type === "string" ? event.type : null;
		const data = event.data;
		if (type === null || data === void 0 || data === null) return;
		if (type === "permission.asked") {
			const requestId = str$2(data["id"]);
			const sessionID = str$2(data["sessionID"]);
			if (requestId === null || sessionID === null) return;
			const key = `notice_${requestId}`;
			if (this.#approvals.has(key)) return;
			const action = str$2(data["action"]);
			this.#approvals.set(key, {
				noticeId: key,
				requestId,
				nativeSessionId: sessionID,
				action,
				requiresLocalConfirmation: requiresLocalConfirmation(action),
				status: "open",
				answeredBy: null,
				answeredAt: null,
				answeredActionId: null,
				ownerConnectorId
			});
			return;
		}
		if (type === "permission.replied") {
			const requestId = str$2(data["requestID"]);
			if (requestId === null) return;
			const record = this.#approvals.get(`notice_${requestId}`);
			if (record !== void 0) record.status = "resolved";
		}
	}
	/**
	* §6⑤ (R4): a notice observed *before* any device had claimed its session was
	* recorded with `ownerConnectorId === null` and, since `observe` only ever
	* binds at ingest time, it could never be answered from the wire — a permanent
	* dead end for any notification that arrived during the cold-start window.
	*
	* When a connection later claims that session we bind those still-open notices
	* to it, exactly once. The trust model is unchanged: the *first* claim wins
	* (the Hub only calls this from `#claim`'s first-writer branch), an
	* already-owned notice is never rebound, and a native-answered/cancelled
	* record is skipped so a resolved interaction cannot be reopened.
	*
	* @returns how many notices were bound (for tests / diagnostics).
	*/
	bindPending(nativeSessionId, connectorId) {
		if (connectorId.length === 0) return 0;
		let bound = 0;
		for (const record of this.#approvals.values()) {
			if (record.nativeSessionId !== nativeSessionId) continue;
			if (record.ownerConnectorId !== null) continue;
			if (record.status !== "open") continue;
			record.ownerConnectorId = connectorId;
			bound += 1;
		}
		return bound;
	}
	/**
	* Apply one remote answer. First answer wins (single-threaded check-then-mark
	* before the await), `always` is always refused, non-read-only actions stay
	* local-only, the notice must be bound to a claimed device and belong to the
	* answering connectorId (§6⑤ — an unclaimed notice fails closed with
	* `unbound_notice`), and nothing is retried or cascaded on failure. Every
	* attempt — accepted or refused — is audited.
	*/
	async answer(input) {
		const record = this.#approvals.get(input.noticeId);
		if (record === void 0 || record.nativeSessionId !== input.nativeSessionId) return this.#refuse(input, INTERACTION_RESULT_CODES.unknownNotice, "unknown or foreign permission notice");
		if (record.ownerConnectorId === null) return this.#refuse(input, INTERACTION_RESULT_CODES.unboundNotice, "this notice is not bound to a claimed device; remote answering is unavailable until the session is claimed");
		if ((input.connectorId ?? null) !== record.ownerConnectorId) return this.#refuse(input, INTERACTION_RESULT_CODES.deviceMismatch, "this notice belongs to another device");
		if (input.actionId === "always") return this.#refuse(input, INTERACTION_RESULT_CODES.unsupportedAction, "always is never accepted remotely");
		if (!isRemoteActionId(input.actionId)) return this.#refuse(input, INTERACTION_RESULT_CODES.unsupportedAction, `unsupported action: ${input.actionId}`);
		if (record.requiresLocalConfirmation) return this.#refuse(input, INTERACTION_RESULT_CODES.localConfirmationRequired, "this action requires a local confirmation");
		if (record.status !== "open") return this.#refuse(input, INTERACTION_RESULT_CODES.alreadyAnswered, "this interaction was already answered");
		const previous = { ...record };
		const ts = (/* @__PURE__ */ new Date()).toISOString();
		record.status = "answered";
		record.answeredBy = input.userId;
		record.answeredAt = ts;
		record.answeredActionId = input.actionId;
		const reply = this.#reply;
		if (typeof reply !== "function") {
			Object.assign(record, previous);
			return this.#refuse(input, INTERACTION_RESULT_CODES.replyUnavailable, "permission.reply is unavailable on this host");
		}
		try {
			const request = {
				path: { requestID: record.requestId },
				body: { reply: input.actionId === "allow_once" ? "once" : "reject" }
			};
			await reply.call(this.#replyHost, request);
		} catch (error) {
			Object.assign(record, previous);
			this.#logger.warn("permission.reply failed", { error: error instanceof Error ? error.name : typeof error });
			return this.#refuse(input, INTERACTION_RESULT_CODES.replyUnavailable, "permission.reply failed");
		}
		this.#audit?.({
			noticeId: input.noticeId,
			userId: input.userId,
			actionId: input.actionId,
			ts,
			source: "remote",
			outcome: input.actionId === "allow_once" ? "allowed" : "denied"
		});
		return {
			ok: true,
			actionId: input.actionId,
			requestId: record.requestId,
			userId: input.userId
		};
	}
	/** Audit a refusal (with its reason) and build the outcome in one place. */
	#refuse(input, code, message) {
		this.#audit?.({
			noticeId: input.noticeId,
			userId: input.userId,
			actionId: input.actionId,
			ts: (/* @__PURE__ */ new Date()).toISOString(),
			source: "remote",
			outcome: "refused",
			reason: code
		});
		return refuse(code, message);
	}
	#record(payload) {
		if (payload === null || typeof payload !== "object") return;
		this.#observations.push({
			requestId: null,
			sessionID: str$2(payload.sessionID),
			action: str$2(payload.action),
			agent: str$2(payload.agent),
			effect: str$2(payload.effect),
			resources: payload.resources,
			source: payload.source,
			observedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		this.#logger.debug("permission evaluate observed (neutral, no effect change)", {
			action: payload.action,
			effect: payload.effect
		});
	}
};
function refuse(code, message) {
	return {
		ok: false,
		code,
		message
	};
}
function str$2(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}
//#endregion
//#region src/server/projector.ts
/**
* OpenCode event → canonical timeline projection.
*
* Source of truth is the runtime event list measured in the P0 spike, **not**
* the published SDK types: six emitted names (`session.step.started`,
* `session.step.ended`, `session.tool.called`, `session.tool.success`,
* `session.reasoning.delta`, `shell.exited`) have zero hits in the SDK types.
* Parsing is therefore defensive by construction — an unknown type or a missing
* field is counted and skipped, never thrown.
*/
const SKIPPED = {
	changed: false,
	skipped: true,
	reason: "skipped"
};
var Projector = class {
	#sessions = /* @__PURE__ */ new Map();
	/** Apply one event. Never throws; returns what happened. */
	apply(nativeId, event) {
		try {
			const projection = this.#session(nativeId);
			this.#advanceCheckpoint(projection, event);
			const type = typeof event.type === "string" ? event.type : null;
			if (type === null) {
				projection.skipped += 1;
				return SKIPPED;
			}
			const outcome = this.#route(projection, type, event);
			if (outcome.skipped) projection.skipped += 1;
			return outcome;
		} catch {
			const projection = this.#sessions.get(nativeId);
			if (projection) projection.skipped += 1;
			return {
				changed: false,
				skipped: true,
				reason: "error"
			};
		}
	}
	#advanceCheckpoint(projection, event) {
		const seq = event.durable?.seq;
		if (typeof seq === "number" && Number.isFinite(seq)) projection.lastDurableSeq = projection.lastDurableSeq === null ? seq : Math.max(projection.lastDurableSeq, seq);
	}
	#route(projection, type, event) {
		const data = asObject$1(event.data);
		switch (type) {
			case "session.next.prompted":
			case "session.inbox.enqueued": return this.#userMessage(projection, event, data);
			case "session.execution.started": return this.#turnMarker(projection, event, "start", "done");
			case "session.text.started":
			case "session.text.delta":
			case "session.step.streamed": return this.#assistantText(projection, event, data, false);
			case "session.reasoning.started":
			case "session.reasoning.delta": return this.#assistantText(projection, event, data, true);
			case "session.step.started": return this.#stepStarted(projection, data);
			case "session.step.ended": return this.#stepEnded(projection, event, data);
			case "session.step.failed": return this.#turnFault(projection, event, "failed", data);
			case "session.execution.interrupted": return this.#turnFault(projection, event, "cancelled", data);
			case "session.error": return this.#turnFault(projection, event, "failed", data);
			case "session.idle": return this.#idle(projection, event);
			case "session.tool.input.started": return this.#toolItem(projection, event, data, "pending", {
				kind: "tool_call",
				title: str$1(data, "name")
			});
			case "session.tool.input.ended": return this.#toolItem(projection, event, data, "pending", { input: json(data["text"]) });
			case "session.tool.called": return this.#toolItem(projection, event, data, "running", {
				input: json(data["input"]),
				executed: data["executed"] === true
			});
			case "session.tool.progress": return this.#toolItem(projection, event, data, "running", { progress: json(data["metadata"]) });
			case "session.tool.success": return this.#toolItem(projection, event, data, "done", {
				output: json(data["content"]),
				executed: data["executed"] === true
			});
			case "session.tool.failed": return this.#toolItem(projection, event, data, "failed", {
				error: json(data["error"]),
				executed: data["executed"] === true
			});
			case "permission.asked": return this.#permissionAsked(projection, event, data);
			case "permission.replied": return this.#permissionReplied(projection, event, data);
			case "shell.created": return this.#shellItem(projection, event, data, "running", null);
			case "shell.exited": return this.#shellItem(projection, event, data, exitStatus(data), data["exit"]);
			case "shell.deleted": return this.#shellItem(projection, event, data, "done", null);
			case "session.created":
			case "session.deleted":
			case "session.usage.updated":
			case "session.status":
			case "session.instructions.updated":
			case "session.inbox.delivered": return this.#bookkeeping(projection, type, data);
			default: {
				const count = projection.unknownTypes.get(type) ?? 0;
				projection.unknownTypes.set(type, count + 1);
				return {
					changed: false,
					skipped: true,
					reason: `unknown:${type}`
				};
			}
		}
	}
	#bookkeeping(projection, type, data) {
		if (type === "session.usage.updated") projection.bookkeeping = {
			...projection.bookkeeping,
			tokens: json(data["tokens"]) ?? null,
			cost: json(data["cost"]) ?? null
		};
		else if (type === "session.status") {
			const status = str$1(data, "status");
			if (status !== null) projection.lastStatusReason = status;
		}
		return {
			changed: false,
			skipped: false,
			reason: `bookkeeping:${type}`
		};
	}
	#userMessage(projection, event, data) {
		const text = firstText(data);
		const key = `user:${event.id ?? `${event.created ?? ""}:${projection.orderSeq}`}`;
		const { item, created } = this.#upsert(projection, key, () => ({
			sessionId: projection.nativeId,
			type: "message",
			status: "done",
			role: "user",
			turnId: projection.currentTurnId,
			content: {
				kind: "markdown",
				text,
				format: "markdown"
			},
			source: {
				runtime: "opencode",
				event: event.type ?? ""
			},
			metadata: {}
		}));
		if (!created && text.length > 0) {
			item.content["text"] = text;
			touch(item);
		}
		projection.turnStatus = "running";
		return {
			changed: created || text.length > 0,
			skipped: false,
			reason: "user-message"
		};
	}
	#turnMarker(projection, event, phase, status) {
		const key = `turn:${phase}:${event.id ?? event.created ?? projection.orderSeq}`;
		const { item } = this.#upsert(projection, key, () => ({
			sessionId: projection.nativeId,
			type: phase === "start" ? "turn.start" : "turn.end",
			status,
			role: phase === "start" ? "user" : null,
			turnId: null,
			content: { kind: phase === "start" ? "turn_start" : "turn_end" },
			source: {
				runtime: "opencode",
				event: event.type ?? ""
			},
			metadata: {}
		}));
		if (phase === "start") projection.currentTurnId = item.id;
		return {
			changed: true,
			skipped: false,
			reason: `turn-${phase}`
		};
	}
	#assistantText(projection, event, data, reasoning) {
		const messageId = str$1(data, "assistantMessageID");
		if (messageId === null) return SKIPPED;
		const ordinal = numberOr(data["ordinal"], 0);
		const key = `${reasoning ? "reasoning" : "text"}:${messageId}:${ordinal}`;
		const delta = str$1(data, "delta") ?? "";
		const { item, created } = this.#upsert(projection, key, () => ({
			sessionId: projection.nativeId,
			type: "message",
			status: "inProgress",
			role: "assistant",
			turnId: projection.currentTurnId,
			content: {
				kind: "markdown",
				text: "",
				format: "markdown"
			},
			source: {
				runtime: "opencode",
				event: event.type ?? "",
				itemId: messageId
			},
			metadata: reasoning ? {
				reasoning: true,
				ordinal
			} : { ordinal }
		}));
		if (reasoning) item.metadata["reasoning"] = true;
		if (delta.length > 0) item.content["text"] = `${String(item.content["text"] ?? "")}${delta}`;
		if (created) refresh(item);
		else touch(item);
		projection.turnStatus = "running";
		return {
			changed: created || delta.length > 0,
			skipped: false,
			reason: reasoning ? "reasoning" : "text"
		};
	}
	#stepStarted(projection, data) {
		const model = str$1(data, "model");
		const agent = str$1(data, "agent");
		if (model !== null) projection.selections = {
			...projection.selections,
			model
		};
		if (agent !== null) projection.selections = {
			...projection.selections,
			agent
		};
		projection.turnStatus = "running";
		projection.lastError = null;
		return {
			changed: true,
			skipped: false,
			reason: "step-started"
		};
	}
	#stepEnded(projection, event, data) {
		const messageId = str$1(data, "assistantMessageID");
		for (const item of projection.items) {
			if (item.status !== "inProgress") continue;
			if (messageId !== null && item.source["itemId"] !== messageId) continue;
			item.status = "done";
			touch(item);
		}
		this.#turnMarker(projection, event, "end", "done");
		projection.bookkeeping = {
			...projection.bookkeeping,
			cost: json(data["cost"]) ?? null,
			tokens: json(data["tokens"]) ?? null
		};
		projection.turnStatus = "idle";
		return {
			changed: true,
			skipped: false,
			reason: "step-ended"
		};
	}
	#turnFault(projection, event, status, data) {
		for (const item of projection.items) if (item.status === "inProgress" || item.status === "pending" || item.status === "running") {
			item.status = status;
			touch(item);
		}
		const marker = this.#turnMarker(projection, event, "end", status);
		const last = projection.items[projection.items.length - 1];
		if (last && last.type === "turn.end" && marker.reason === "turn-end") {
			const error = json(data["error"]) ?? str$1(data, "reason");
			if (error !== void 0) last.metadata["error"] = error;
			touch(last);
		}
		projection.lastError = json(data["error"]) !== void 0 ? asObject$1(json(data["error"])) : str$1(data, "reason") !== null ? { message: str$1(data, "reason") } : null;
		projection.turnStatus = status === "cancelled" ? "cancelled" : "error";
		return {
			changed: true,
			skipped: false,
			reason: `turn-${status}`
		};
	}
	#idle(projection, event) {
		for (const item of projection.items) if (item.status === "inProgress") {
			item.status = "done";
			touch(item);
		}
		this.#turnMarker(projection, event, "end", "done");
		projection.turnStatus = "idle";
		return {
			changed: true,
			skipped: false,
			reason: "idle"
		};
	}
	#toolItem(projection, event, data, status, contentPatch) {
		const id = str$1(data, "id");
		if (id === null) return SKIPPED;
		const key = `tool:${id}`;
		const messageId = str$1(data, "assistantMessageID");
		const { item, created } = this.#upsert(projection, key, () => ({
			sessionId: projection.nativeId,
			type: "tool",
			status,
			role: "tool",
			turnId: projection.currentTurnId,
			content: { kind: "tool_call" },
			source: {
				runtime: "opencode",
				event: event.type ?? "",
				itemId: id
			},
			metadata: messageId === null ? { nativeToolId: id } : {
				nativeToolId: id,
				messageId
			}
		}));
		for (const [patchKey, patchValue] of Object.entries(contentPatch)) {
			if (patchValue === void 0) continue;
			if (patchKey === "executed") {
				item.metadata["executed"] = patchValue;
				continue;
			}
			item.content[patchKey] = patchValue;
		}
		item.status = created ? status : mergeStatus(item.status, status);
		if (created) refresh(item);
		else touch(item);
		projection.turnStatus = "running";
		return {
			changed: true,
			skipped: false,
			reason: `tool:${event.type ?? ""}`
		};
	}
	#shellItem(projection, event, data, status, exitCode) {
		const id = str$1(data, "id");
		if (id === null) return SKIPPED;
		const key = `shell:${id}`;
		const info = json(data["info"]);
		const command = typeof info === "string" ? info : typeof info === "object" && info !== null ? str$1(info, "command") : null;
		const { item, created } = this.#upsert(projection, key, () => ({
			sessionId: projection.nativeId,
			type: "tool",
			status,
			role: "tool",
			turnId: projection.currentTurnId,
			content: {
				kind: "command",
				...command !== null ? { command } : {}
			},
			source: {
				runtime: "opencode",
				event: event.type ?? "",
				itemId: id
			},
			metadata: {
				nativeToolId: id,
				shell: true
			}
		}));
		if (typeof exitCode === "number") item.content["exitCode"] = exitCode;
		item.status = created ? status : mergeStatus(item.status, status);
		if (created) refresh(item);
		else touch(item);
		return {
			changed: true,
			skipped: false,
			reason: `shell:${event.type ?? ""}`
		};
	}
	#permissionAsked(projection, event, data) {
		const id = str$1(data, "id");
		if (id === null) return SKIPPED;
		const action = str$1(data, "action");
		const noticeId = `notice_${id}`;
		const localOnly = requiresLocalConfirmation(action);
		const notice = {
			noticeId,
			sessionId: projection.nativeId,
			type: "interaction",
			title: action ?? "Permission requested",
			message: describeResources(data["resources"]),
			severity: "warning",
			status: "open",
			interactionType: "approval",
			blocking: {
				scope: "session",
				targetId: projection.nativeId
			},
			responseRequired: true,
			actions: remoteActions(action),
			source: {
				runtime: "opencode",
				event: event.type ?? "",
				itemId: id
			},
			context: {
				permission: action,
				requestId: id,
				requiresLocalConfirmation: localOnly,
				...data["source"] !== void 0 ? { source: json(data["source"]) } : {},
				...data["save"] !== void 0 ? { save: json(data["save"]) } : {}
			}
		};
		const existing = projection.noticeIndex.get(noticeId);
		if (existing !== void 0) {
			const current = projection.notices[existing];
			if (current === void 0 || current.status !== "open") return {
				changed: false,
				skipped: false,
				reason: "permission-asked-redelivered"
			};
			projection.notices[existing] = notice;
			projection.openInteractions.set(id, existing);
			return {
				changed: true,
				skipped: false,
				reason: "permission-asked-duplicate"
			};
		}
		projection.noticeIndex.set(noticeId, projection.notices.length);
		projection.openInteractions.set(id, projection.notices.length);
		projection.notices.push(notice);
		return {
			changed: true,
			skipped: false,
			reason: "permission-asked"
		};
	}
	#permissionReplied(projection, event, data) {
		const requestId = str$1(data, "requestID");
		if (requestId === null) return SKIPPED;
		projection.openInteractions.delete(requestId);
		const index = projection.noticeIndex.get(`notice_${requestId}`);
		const notice = index === void 0 ? void 0 : projection.notices[index];
		if (notice === void 0) return {
			changed: true,
			skipped: false,
			reason: "permission-replied-unknown"
		};
		if (notice.status !== "resolved") {
			notice.status = "resolved";
			notice.responseRequired = false;
		}
		notice.context = {
			...notice.context,
			reply: json(data["reply"]) ?? null,
			event: event.type ?? ""
		};
		return {
			changed: true,
			skipped: false,
			reason: "permission-replied"
		};
	}
	snapshot(nativeId, sessionId) {
		const projection = this.#sessions.get(nativeId);
		if (!projection) return null;
		const items = projection.items.map((item) => ({
			...item,
			sessionId
		}));
		return {
			items,
			watermark: projection.lastDurableSeq,
			complete: true,
			totalItems: items.length,
			skippedEvents: projection.skipped
		};
	}
	/**
	* Raw projected items (native session keying). The sync surface re-keys them
	* per connection itself, so it must not pay for `snapshot()`'s copy/re-key.
	*/
	timeline(nativeId) {
		return this.#sessions.get(nativeId)?.items ?? [];
	}
	/** Native events this session could not project (Hub-owned skip counter). */
	skippedEvents(nativeId) {
		return this.#sessions.get(nativeId)?.skipped ?? 0;
	}
	state(nativeId) {
		const projection = this.#sessions.get(nativeId);
		if (!projection) return null;
		return {
			status: projection.openInteractions.size > 0 ? "waiting_approval" : projection.turnStatus === "running" ? "running" : projection.turnStatus === "error" ? "error" : "idle",
			statusReason: projection.turnStatus === "cancelled" ? "interrupted" : projection.lastStatusReason,
			selections: {
				...projection.selections,
				...projection.bookkeeping
			},
			error: projection.lastError,
			openInteractions: projection.openInteractions.size
		};
	}
	notices(nativeId, sessionId) {
		const projection = this.#sessions.get(nativeId);
		if (!projection) return [];
		return projection.notices.map((notice) => ({
			...notice,
			sessionId
		}));
	}
	counters() {
		const unknownTypes = {};
		let skippedEvents = 0;
		for (const projection of this.#sessions.values()) {
			skippedEvents += projection.skipped;
			for (const [type, count] of projection.unknownTypes) unknownTypes[type] = (unknownTypes[type] ?? 0) + count;
		}
		return {
			sessions: this.#sessions.size,
			skippedEvents,
			unknownTypes
		};
	}
	forget(nativeId) {
		this.#sessions.delete(nativeId);
	}
	#session(nativeId) {
		const existing = this.#sessions.get(nativeId);
		if (existing) return existing;
		const created = {
			nativeId,
			orderSeq: 0,
			currentTurnId: null,
			turnStatus: "idle",
			items: [],
			byKey: /* @__PURE__ */ new Map(),
			lastDurableSeq: null,
			openInteractions: /* @__PURE__ */ new Map(),
			noticeIndex: /* @__PURE__ */ new Map(),
			notices: [],
			selections: {},
			lastError: null,
			lastStatusReason: null,
			bookkeeping: {},
			skipped: 0,
			unknownTypes: /* @__PURE__ */ new Map()
		};
		this.#sessions.set(nativeId, created);
		return created;
	}
	#upsert(projection, key, init) {
		const index = projection.byKey.get(key);
		if (index !== void 0) {
			const existing = projection.items[index];
			if (existing) return {
				item: existing,
				created: false
			};
		}
		const item = {
			...init(),
			id: timelineItemId(`${projection.nativeId}:${key}`),
			orderSeq: ++projection.orderSeq,
			revision: 1,
			contentHash: ""
		};
		refresh(item);
		projection.items.push(item);
		projection.byKey.set(key, projection.items.length - 1);
		return {
			item,
			created: true
		};
	}
};
function refresh(item) {
	item.contentHash = contentHash(item.type, item.status, item.role, item.content);
}
/** An in-place update: bump the revision, then re-address the content. */
function touch(item) {
	item.revision += 1;
	refresh(item);
}
const STATUS_RANK = {
	pending: 0,
	inProgress: 1,
	running: 2,
	waiting_approval: 3,
	done: 4,
	failed: 4,
	cancelled: 4,
	interrupted: 4,
	hidden: 5
};
/** Never regress a terminal status back to a transient one. */
function mergeStatus(current, next) {
	const currentRank = STATUS_RANK[current] ?? 0;
	return (STATUS_RANK[next] ?? 0) >= currentRank ? next : current;
}
function asObject$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function str$1(source, key) {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}
function numberOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** JSON-safe projection of an arbitrary event field (undefined stays undefined). */
function json(value) {
	if (value === void 0) return void 0;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
}
function firstText(data) {
	for (const key of [
		"text",
		"content",
		"message"
	]) {
		const value = data[key];
		if (typeof value === "string") return value;
	}
	const item = json(data["item"]);
	if (typeof item === "string") return item;
	if (item !== null && typeof item === "object") {
		const nested = firstText(item);
		if (nested.length > 0) return nested;
	}
	return "";
}
function describeResources(resources) {
	const value = json(resources);
	if (value === void 0 || value === null) return null;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string").join(", ") || null;
	return null;
}
function exitStatus(data) {
	const exit = data["exit"];
	if (typeof exit === "number") return exit === 0 ? "done" : "failed";
	const status = data["status"];
	return typeof status === "string" && status !== "exited" ? "failed" : "done";
}
//#endregion
//#region src/server/registry.ts
var EndpointRegistry = class {
	#options;
	/** Published path per directory, kept so `remove()` cleans up what we wrote even after a later republish failed. */
	#published = /* @__PURE__ */ new Map();
	#primaryPath = null;
	#locations = [];
	#startedAt = (/* @__PURE__ */ new Date()).toISOString();
	constructor(options) {
		this.#options = options;
	}
	get path() {
		return this.#primaryPath;
	}
	/** Paths currently published, one per registry that accepted the record. */
	get publishedPaths() {
		return [...this.#published.values()];
	}
	get locations() {
		return this.#locations;
	}
	/**
	* Publish (or republish) the endpoint file into every configured directory.
	* A directory that cannot be written is logged and skipped — the remaining
	* directories must still serve the endpoint — but an all-directory failure
	* rejects, exactly like the single-directory contract did.
	*/
	async publish(locations) {
		this.#locations = [...new Set(locations)].sort();
		const record = this.#record();
		const failures = [];
		let primaryPath = null;
		for (const directory of this.#options.directories) try {
			const path = await publishEndpoint(directory, record);
			this.#published.set(directory, path);
			primaryPath ??= path;
		} catch (error) {
			failures.push({
				directory,
				error: errorName$2(error)
			});
		}
		if (primaryPath === null) throw new Error(`failed to publish the bridge endpoint into every configured directory: ${failures.map((failure) => `${failure.directory} (${failure.error})`).join(", ")}`);
		for (const failure of failures) this.#options.logger.warn("failed to publish the bridge endpoint into one directory", {
			directory: failure.directory,
			error: failure.error
		});
		this.#primaryPath = primaryPath;
		return primaryPath;
	}
	/** Update the advertised location set; no-op before the first publish. */
	async setLocations(locations) {
		this.#locations = [...new Set(locations)].sort();
		if (this.#primaryPath === null) return;
		await this.publish(this.#locations);
	}
	/** Lease renewal: rewrite with a fresh timestamp so the file looks alive. */
	async renew() {
		if (this.#primaryPath === null) return;
		this.#startedAt = (/* @__PURE__ */ new Date()).toISOString();
		await this.publish(this.#locations);
	}
	/** Remove every file this registry published — all directories, only ours. */
	async remove() {
		const paths = [...this.#published.values()];
		this.#published.clear();
		this.#primaryPath = null;
		for (const path of paths) try {
			await removeEndpoint(path);
		} catch (error) {
			this.#options.logger.warn("failed to remove bridge endpoint file", { error: errorName$2(error) });
		}
	}
	#record() {
		return makeEndpointRecord({
			bridgeId: this.#options.bridgeId,
			port: this.#options.port,
			token: this.#options.token,
			pid: this.#options.pid,
			locations: this.#locations,
			...this.#options.serviceVersion !== void 0 ? { serviceVersion: this.#options.serviceVersion } : {},
			startedAt: this.#startedAt
		});
	}
};
function errorName$2(error) {
	return error instanceof Error ? error.name : typeof error;
}
//#endregion
//#region src/server/session-registry.ts
/**
* Incremental session registry.
*
* One subscription over the process-wide event stream feeds this table. Session
* discovery is therefore *partial* by construction: sessions that existed before
* the plugin loaded stay invisible until they emit an event (cold-start blind
* spot), and the subscription does not replay — a session created before the
* subscribe point permanently loses its `session.created`, so a session we do
* see still has an unknown creation and an incomplete prefix. `partial` is
* reported to the Connector instead of being hidden.
*
* Discovery is therefore anchored on **any** event carrying the session id, not
* on `session.created` specifically: the first successor event we see for an
* unknown session establishes its record (reason `discovered`), because the
* creation event may never arrive.
*/
/**
* Namespaces the projector understands. The global stream also carries unrelated
* domain events (`provider.updated`, `models-dev.refreshed`, …) which are dropped
* here, before any projection work.
*/
const ACCEPTED_PREFIXES = [
	"session.",
	"permission.",
	"shell."
];
var SessionRegistry = class {
	#records = /* @__PURE__ */ new Map();
	#allowedDirectories;
	#logger;
	#filteredByType = 0;
	#filteredByLocation = 0;
	constructor(options) {
		this.#logger = options.logger;
		this.#allowedDirectories = new Set([...options.allowedDirectories ?? []].map((directory) => normalizeDirectory(directory)));
	}
	/**
	* Always `true`: the `complete` state is **unreachable by design**.
	*
	* The registry is filled exclusively by the global event stream (rev3 session
	* discovery scheme ①). Two measured facts (spike 02 §3.5) make `partial`
	* inescapable, and neither is a bug to "wait out":
	*
	* - **cold-start blind spot** — sessions that already existed when the plugin
	*   loaded and never emit another event stay invisible, and the platform
	*   exposes no enumeration/snapshot API to reconcile them;
	* - **no replay** — `event.subscribe()` delivers only post-subscribe events, so
	*   a session created before the subscribe point permanently loses its
	*   `session.created`. Even a session we *do* discover (via a later event) is
	*   missing its creation and the prefix of its history.
	*
	* With no full-coverage channel, no event sequence proves every session is
	* known — a `complete` report could only ever be a false claim. Reporting
	* `partial` forever is the honest state; rev3 records the missing
	* reconciliation channel as the open item A10.
	*
	* Do NOT "fix" this by flipping the flag once the stream goes quiet or after N
	* events: quietness is not coverage, and advertising `complete` would make the
	* Connector stop surfacing the blind spot to the platform.
	*/
	get partial() {
		return true;
	}
	get filtered() {
		return {
			byType: this.#filteredByType,
			byLocation: this.#filteredByLocation
		};
	}
	allowDirectory(directory) {
		this.#allowedDirectories.add(normalizeDirectory(directory));
	}
	revokeDirectory(directory) {
		this.#allowedDirectories.delete(normalizeDirectory(directory));
	}
	/** Double filter: `event.type` namespace AND `event.location.directory`. */
	ingest(event) {
		const type = typeof event.type === "string" ? event.type : null;
		if (type === null || !isAcceptedType(type)) {
			this.#filteredByType += 1;
			return rejected("type");
		}
		const directory = event.location?.directory;
		if (typeof directory === "string" && this.#allowedDirectories.size > 0 && !this.#allowedDirectories.has(normalizeDirectory(directory))) {
			this.#filteredByLocation += 1;
			return rejected("location");
		}
		const nativeId = extractSessionId(event);
		if (nativeId === null) return {
			accepted: true,
			nativeId: null,
			created: false,
			deleted: false,
			reason: "no-session-id"
		};
		const existing = this.#records.get(nativeId);
		const resolvedDirectory = typeof directory === "string" && directory.length > 0 ? directory : existing?.directory ?? "";
		const activity = typeof event.created === "string" ? event.created : null;
		if (type === "session.deleted") {
			if (!existing) {
				this.#records.set(nativeId, {
					nativeId,
					directory: resolvedDirectory,
					title: null,
					createdAt: null,
					lastActivityAt: activity,
					deleted: true
				});
				return {
					accepted: true,
					nativeId,
					created: true,
					deleted: true,
					reason: "deleted"
				};
			}
			existing.deleted = true;
			existing.lastActivityAt = activity ?? existing.lastActivityAt;
			return {
				accepted: true,
				nativeId,
				created: false,
				deleted: true,
				reason: "deleted"
			};
		}
		if (!existing) {
			const fromCreation = type === "session.created";
			this.#records.set(nativeId, {
				nativeId,
				directory: resolvedDirectory,
				title: extractTitle(event),
				createdAt: fromCreation ? activity : null,
				lastActivityAt: activity,
				deleted: false
			});
			this.#logger.debug("session discovered from event stream", { event: type });
			return {
				accepted: true,
				nativeId,
				created: true,
				deleted: false,
				reason: fromCreation ? "created" : "discovered"
			};
		}
		existing.lastActivityAt = activity ?? existing.lastActivityAt;
		if (resolvedDirectory.length > 0 && existing.directory.length === 0) existing.directory = resolvedDirectory;
		const title = extractTitle(event);
		if (title !== null) existing.title = title;
		return {
			accepted: true,
			nativeId,
			created: false,
			deleted: false,
			reason: "touched"
		};
	}
	list(limit, directory) {
		const filter = directory === void 0 ? null : normalizeDirectory(directory);
		const records = [...this.#records.values()].filter((record) => !record.deleted && (filter === null || recordMatchesLocation(record, filter)));
		records.sort((left, right) => (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));
		if (limit !== void 0 && limit >= 0 && records.length > limit) return records.slice(0, limit);
		return records;
	}
	get(nativeId) {
		return this.#records.get(nativeId);
	}
	/**
	* Reverse lookup: platform session id → native OpenCode session id, scoped to
	* the connection's location (rev3 ruling 1: another location's session is
	* *invisible*, not merely unlisted).
	*/
	findByPlatformId(sessionId, namespace, directory) {
		const filter = directory === void 0 ? null : normalizeDirectory(directory);
		for (const record of this.#records.values()) {
			if (filter !== null && !recordMatchesLocation(record, filter)) continue;
			if (platformSessionId(namespace, record.nativeId) === sessionId) return record;
		}
	}
	get size() {
		return this.#records.size;
	}
};
function isAcceptedType(type) {
	return ACCEPTED_PREFIXES.some((prefix) => type.startsWith(prefix));
}
/**
* The session an event is attributed to. Measured (spike 02 §3.1/§3.2): every
* session-scoped event we accepted carries `data.sessionID`, equal to
* `durable.aggregateID`. We deliberately read only `data.sessionID` — using the
* aggregate id as a fallback would risk inventing a session from an unrelated
* aggregate, and no measured accepted event needs it. An event with no
* `sessionID` is left unattributed rather than guessed.
*/
function extractSessionId(event) {
	const data = event.data;
	if (data === void 0 || data === null) return null;
	const value = data["sessionID"];
	return typeof value === "string" && value.length > 0 ? value : null;
}
function asString(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function extractTitle(event) {
	const data = event.data;
	if (data === void 0) return null;
	return asString(data["title"]) ?? asString(data["name"]);
}
function rejected(reason) {
	return {
		accepted: false,
		nativeId: null,
		created: false,
		deleted: false,
		reason
	};
}
/**
* Per-connection view filter (rev3 ruling 1). `normalized` MUST already be the
* output of `normalizeDirectory`, so both sides of the comparison use the exact
* same canonical form. A session with no observed directory never matches.
*/
function recordMatchesLocation(record, normalized) {
	return record.directory.length > 0 && normalizeDirectory(record.directory) === normalized;
}
//#endregion
//#region src/server/sync.ts
/**
* Push-sync tracker for the Bridge Hub (design §2.3 subscribe/ack + `sync.batch`).
*
* One tracker per Hub owns, per native session:
*
* - the **durable-history hash chain** (`historyHash`): `sha256` folded over
*   each new maximum `durable.seq`, so a reconnect can be calibrated to an
*   exact prefix. Only a strictly increasing `durable.seq` advances the chain —
*   the same monotonic rule the projection checkpoint uses.
* - the **per-item durable seq**, so a calibrated resume pushes only the delta
*   rather than replaying the whole timeline.
* - the diff signatures behind `phase:"notifications"` live updates.
*
* `throughSeq` is the largest `durable.seq` the Hub has projected. The Connector
* cannot observe native OpenCode events, so the Hub alone owns this value
* (rev3 §2.6 and the §4.1 ownership split); the Connector persists it verbatim.
*/
/** Genesis digest of the empty durable history (`throughSeq === 0`). */
const GENESIS_HISTORY_HASH = sha256Hex("opencode/history/v1");
/**
* Retained sequence→chain entries. A `fromSeq` older than the window is
* treated as unknown → full snapshot, which is always safe.
*/
const MAX_RETAINED_SEQUENCES = 4096;
var SyncTracker = class {
	#sessions = /* @__PURE__ */ new Map();
	/**
	* Fold one projected event into the session's sync state and report what a
	* subscribed peer would need to be told.
	*/
	observe(nativeId, event, view) {
		const state = this.#state(nativeId);
		this.#advanceChain(state, event);
		const itemIds = this.#diffItems(state, view.items, durableSeq(event));
		const meta = this.#diffMeta(state, view.meta);
		const stateChange = this.#diffState(state, view.state);
		const notices = this.#diffNotices(state, view.notices);
		return {
			head: {
				throughSeq: state.throughSeq,
				historyHash: state.chain
			},
			skippedEventCount: view.skippedEventCount,
			itemIds,
			state: stateChange,
			notices,
			meta
		};
	}
	head(nativeId) {
		const state = this.#sessions.get(nativeId);
		return state ? {
			throughSeq: state.throughSeq,
			historyHash: state.chain
		} : {
			throughSeq: 0,
			historyHash: GENESIS_HISTORY_HASH
		};
	}
	/**
	* Resolve the requested resume point. The Hub NEVER resumes on `fromSeq`
	* alone (rev3 ruling 3): a missing, mistyped, mismatched or out-of-window
	* `historyHash` degrades to a full snapshot.
	*/
	select(nativeId, fromSeq, historyHash) {
		const state = this.#state(nativeId);
		const head = {
			throughSeq: state.throughSeq,
			historyHash: state.chain
		};
		if (fromSeq !== null && historyHash !== null && state.sequences.get(fromSeq) === historyHash) {
			const itemIds = [];
			for (const [id, seq] of state.itemSeq) if (seq === null || seq > fromSeq) itemIds.push(id);
			return {
				mode: "incremental",
				fromSeq,
				itemIds,
				...head
			};
		}
		return {
			mode: "snapshot",
			fromSeq: null,
			itemIds: null,
			...head
		};
	}
	forget(nativeId) {
		this.#sessions.delete(nativeId);
	}
	#state(nativeId) {
		const existing = this.#sessions.get(nativeId);
		if (existing) return existing;
		const created = {
			throughSeq: 0,
			chain: GENESIS_HISTORY_HASH,
			sequences: /* @__PURE__ */ new Map([[0, GENESIS_HISTORY_HASH]]),
			itemHash: /* @__PURE__ */ new Map(),
			itemSeq: /* @__PURE__ */ new Map(),
			stateSig: null,
			metaSig: null,
			noticeSigs: /* @__PURE__ */ new Map()
		};
		this.#sessions.set(nativeId, created);
		return created;
	}
	#advanceChain(state, event) {
		const seq = durableSeq(event);
		if (seq === null || seq <= state.throughSeq) return;
		const entry = sha256Hex(canonicalJson({
			aggregateID: event.durable?.aggregateID ?? null,
			seq,
			type: event.type ?? null
		}));
		state.chain = sha256Hex(`${state.chain}:${entry}`);
		state.throughSeq = seq;
		state.sequences.set(seq, state.chain);
		while (state.sequences.size > MAX_RETAINED_SEQUENCES) {
			const oldest = state.sequences.keys().next().value;
			if (oldest === void 0) break;
			state.sequences.delete(oldest);
		}
	}
	#diffItems(state, items, seq) {
		const changed = [];
		for (const item of items) {
			if (state.itemHash.get(item.id) === item.contentHash) continue;
			state.itemHash.set(item.id, item.contentHash);
			state.itemSeq.set(item.id, seq);
			changed.push(item.id);
		}
		return changed;
	}
	#diffMeta(state, meta) {
		const signature = canonicalJson(meta);
		if (state.metaSig === signature) return null;
		state.metaSig = signature;
		return meta;
	}
	#diffState(state, value) {
		if (value === null) return null;
		const signature = canonicalJson({
			status: value.status,
			statusReason: value.statusReason,
			selections: value.selections,
			error: value.error,
			openInteractions: value.openInteractions
		});
		if (state.stateSig === signature) return null;
		state.stateSig = signature;
		return value;
	}
	#diffNotices(state, notices) {
		const changed = [];
		const seen = /* @__PURE__ */ new Set();
		for (const notice of notices) {
			seen.add(notice.noticeId);
			const signature = `${notice.status}|${notice.responseRequired}`;
			if (state.noticeSigs.get(notice.noticeId) === signature) continue;
			state.noticeSigs.set(notice.noticeId, signature);
			changed.push(notice);
		}
		for (const id of state.noticeSigs.keys()) if (!seen.has(id)) state.noticeSigs.delete(id);
		return changed;
	}
};
function durableSeq(event) {
	const seq = event.durable?.seq;
	return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? seq : null;
}
//#endregion
//#region src/server/bridge-hub.ts
/**
* Bridge Hub — one per OpenCode service process.
*
* Listens on `127.0.0.1:0` (random port), speaks NDJSON JSON-RPC 2.0 with a hard
* 8 MiB frame cap, and publishes a loopback endpoint file for the local
* Connector to attach to. The hub is a JSON-RPC *server*: it serves the P1
* read-only surface plus the P3 write surface (`session.createAndStart` /
* `startTurn` / `interrupt` / `updateSelections` / `respondInteraction`, and a
* fail-closed `steerTurn`), rejects every unknown method with `-32601`, and
* itself only ever emits notifications (never requests).
*/
const HUB_GLOBAL_KEY = "agents-anywhere.opencode.hub";
const DEFAULT_HOST = "127.0.0.1";
/** Gate state before any version is known (skipped, recorded as `unknown`). */
const UNKNOWN_VERSION_GATE = evaluateHostVersion(void 0);
var BridgeHub = class {
	#logger;
	#host;
	#endpointsDirectory;
	#serviceVersion;
	/**
	* Host version gate (P6). Re-evaluated on every `install(ctx)` so a hub
	* created without a version can still learn it from a later plugin instance.
	*/
	#hostVersion = UNKNOWN_VERSION_GATE;
	#versionWarned = false;
	#versionUnknownLogged = false;
	#bridgeId = randomUUID();
	#locations = /* @__PURE__ */ new Map();
	#connections = /* @__PURE__ */ new Set();
	#sessions;
	/**
	* TUI-written session index (parent/child linkage). Read fail-soft; when no
	* fresh index is available the Hub reports `parentRelation: "unavailable"`
	* and never filters on a stale one.
	*/
	#sessionIndex;
	#projector = new Projector();
	#sync = new SyncTracker();
	#syncPageItems;
	#permission;
	/** The host's `ctx.session` write surface, captured on first `install()`. */
	#sessionApi = void 0;
	/** `ctx.agent` / `ctx.model` directory surfaces, captured on first `install()`. */
	#agentApi = void 0;
	#modelApi = void 0;
	/**
	* §6⑤: native session id → connectorId of the connection that claimed it
	* (first claim wins). Populated when a connection materialises/or drives a
	* session, so a notice can be bound to the device that owns it.
	*/
	#sessionOwners = /* @__PURE__ */ new Map();
	#server = null;
	#registry = null;
	#port = 0;
	#token = "";
	#refs = 0;
	#bound = false;
	#stopped = false;
	#metrics = {
		acceptedEvents: 0,
		filteredEvents: 0,
		unattributedEvents: 0,
		incomingNotifications: 0,
		handshakeFailures: 0,
		ignoredResponses: 0,
		rejectedRequests: 0,
		connections: 0
	};
	constructor(options = {}) {
		this.#logger = options.logger ?? createLogger("bridge-hub");
		this.#host = options.host ?? DEFAULT_HOST;
		this.#endpointsDirectory = options.endpointsDirectory;
		this.#serviceVersion = options.serviceVersion;
		this.#setHostVersion(options.serviceVersion, "ctx.app.version");
		this.#syncPageItems = options.syncPageItems ?? 500;
		this.#sessions = new SessionRegistry({ logger: this.#logger });
		this.#sessionIndex = new SessionIndex({
			path: options.sessionIndexPath ?? (options.endpointsDirectory !== void 0 ? join(options.endpointsDirectory, "session-index.json") : sessionIndexPath()),
			...options.sessionIndexMaxAgeMs !== void 0 ? { maxAgeMs: options.sessionIndexMaxAgeMs } : {},
			logger: this.#logger
		});
		this.#permission = new PermissionObserver(this.#logger, (entry) => {
			this.#logger.info("remote permission answer", { ...entry });
		});
	}
	get port() {
		return this.#port;
	}
	get token() {
		return this.#token;
	}
	get bridgeId() {
		return this.#bridgeId;
	}
	get endpointPath() {
		return this.#registry?.path ?? null;
	}
	get stopped() {
		return this.#stopped;
	}
	/**
	* Evaluate the host version against the supported range (P6). Warns **once**
	* per hub when the host is out of range — naming the current version, the
	* supported range and the likely consequence — and records once when the
	* version cannot be obtained. It never flips the gate silently.
	*/
	#setHostVersion(version, source) {
		this.#hostVersion = evaluateHostVersion(version, source);
		if (this.#hostVersion.supported === false) {
			if (this.#versionWarned) return;
			this.#versionWarned = true;
			this.#logger.warn(this.#hostVersion.warning ?? "host version is outside the supported range", {
				hostVersion: this.#hostVersion.version,
				hostVersionSource: this.#hostVersion.source,
				reason: this.#hostVersion.reason
			});
			return;
		}
		if (this.#hostVersion.supported === null && !this.#versionUnknownLogged) {
			this.#versionUnknownLogged = true;
			this.#logger.info("宿主 OpenCode 版本获取失败，版本门已跳过（能力不改标，仅记录）", { reason: this.#hostVersion.reason });
		}
	}
	get sessions() {
		return this.#sessions;
	}
	/** Fail-soft TUI session index (parent/child linkage). */
	get sessionIndex() {
		return this.#sessionIndex;
	}
	get projector() {
		return this.#projector;
	}
	get metrics() {
		return {
			...this.#metrics,
			connections: this.#connections.size
		};
	}
	async start() {
		if (this.#server !== null) return;
		this.#stopped = false;
		const server = createServer((socket) => this.#accept(socket));
		await new Promise((resolvePromise, rejectPromise) => {
			const onError = (error) => rejectPromise(error);
			server.once("error", onError);
			server.listen(0, this.#host, () => {
				server.off("error", onError);
				resolvePromise();
			});
		});
		server.on("error", (error) => {
			this.#logger.warn("bridge server error", { error: error.name });
		});
		this.#server = server;
		const address = server.address();
		if (address === null || typeof address === "string") {
			await this.stop();
			throw new Error("bridge server did not bind a TCP port");
		}
		this.#port = address.port;
		this.#token = randomBytes(32).toString("base64url");
		this.#registry = new EndpointRegistry({
			directories: this.#endpointsDirectory !== void 0 ? [this.#endpointsDirectory] : endpointDirectories(),
			pid: process.pid,
			port: this.#port,
			bridgeId: this.#bridgeId,
			token: this.#token,
			...this.#serviceVersion !== void 0 ? { serviceVersion: this.#serviceVersion } : {},
			logger: this.#logger
		});
		await this.#registry.publish([...this.#locations.values()]);
		await this.#sessionIndex.refresh();
		this.#logger.info("bridge hub listening", {
			port: this.#port,
			locations: this.#locations.size
		});
	}
	async stop() {
		this.#stopped = true;
		for (const connection of this.#connections) connection.close();
		this.#connections.clear();
		try {
			await this.#registry?.remove();
		} catch {}
		this.#registry = null;
		const server = this.#server;
		this.#server = null;
		if (server !== null) await new Promise((resolvePromise) => server.close(() => resolvePromise()));
		this.#permission.dispose();
	}
	/**
	* Adopt this hub for a plugin instance. The first call performs the one-time
	* wiring (single full event subscription, one permission hook); every call
	* increments a refcount and returns an idempotent cleanup.
	*/
	async install(ctx) {
		if (this.#stopped) throw new Error("bridge hub has been stopped");
		this.#setHostVersion(readServiceVersion(ctx), "ctx.app.version");
		const rawDirectory = readDirectory(ctx);
		if (rawDirectory !== null) {
			this.#locations.set(normalizeDirectory(rawDirectory), rawDirectory);
			this.#sessions.allowDirectory(rawDirectory);
		}
		if (!this.#bound) {
			this.#bound = true;
			this.#bindContext(ctx);
			await this.#sessionIndex.refresh();
		}
		this.#refs += 1;
		try {
			await this.#registry?.setLocations([...this.#locations.values()]);
		} catch (error) {
			this.#logger.warn("failed to advertise bridge locations", { error: error instanceof Error ? error.name : typeof error });
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#refs -= 1;
			if (rawDirectory !== null) {
				this.#locations.delete(normalizeDirectory(rawDirectory));
				this.#sessions.revokeDirectory(rawDirectory);
			}
			if (this.#refs <= 0) return this.stop();
		};
	}
	/**
	* Feed one event through the double filter and, when accepted, the projector.
	* Returns whether the event reached the projection.
	*/
	ingest(event) {
		const decision = this.#sessions.ingest(event);
		if (!decision.accepted) {
			this.#metrics.filteredEvents += 1;
			return false;
		}
		if (decision.nativeId === null) {
			this.#metrics.unattributedEvents += 1;
			return false;
		}
		try {
			this.#projector.apply(decision.nativeId, event);
		} catch (error) {
			this.#logger.warn("projection failed", { error: error instanceof Error ? error.name : typeof error });
			return false;
		}
		try {
			this.#permission.observe(event, this.#sessionOwners.get(decision.nativeId) ?? null);
		} catch {}
		this.#metrics.acceptedEvents += 1;
		this.#publishSessionChange(decision.nativeId, event);
		return true;
	}
	/**
	* Fold an accepted event into the sync tracker and push the resulting
	* `phase:"notifications"` batch to every connection subscribed to this
	* session. Runs even with no subscribers so a later resume is calibrated.
	*/
	#publishSessionChange(nativeId, event) {
		const record = this.#sessions.get(nativeId);
		if (record === void 0) return;
		const change = this.#sync.observe(nativeId, event, this.#view(record, nativeId));
		if (change.itemIds.length === 0 && change.state === null && change.notices.length === 0 && change.meta === null) return;
		for (const connection of this.#connections) {
			const location = connection.location;
			if (location === null || !recordMatchesLocation(record, location)) continue;
			const sessionId = platformSessionId(connection.namespace, nativeId);
			const streamId = connection.subscriptions.get(sessionId);
			if (streamId === void 0) continue;
			this.#pushNotifications(connection, record, sessionId, streamId, change);
		}
	}
	#pushNotifications(connection, record, sessionId, streamId, change) {
		const notifications = [];
		if (change.itemIds.length > 0) {
			const wanted = new Set(change.itemIds);
			for (const item of this.#projector.timeline(record.nativeId)) {
				if (!wanted.has(item.id)) continue;
				notifications.push({
					method: "timeline.itemUpsert",
					params: {
						sessionId,
						item: {
							...item,
							sessionId
						}
					}
				});
			}
		}
		if (change.meta !== null) notifications.push({
			method: "session.meta.upsert",
			params: this.#metaWire(connection, record)
		});
		if (change.state !== null) notifications.push({
			method: "session.state.updated",
			params: this.#stateWire(connection, record, change.state)
		});
		for (const notice of change.notices) notifications.push({
			method: "notice.upsert",
			params: this.#noticeWire(notice, sessionId)
		});
		this.#sendSyncBatch(connection, {
			sessionId,
			streamId,
			phase: "notifications",
			notifications,
			throughSeq: change.head.throughSeq,
			diagnostics: { skippedEventCount: change.skippedEventCount }
		});
	}
	#view(record, nativeId) {
		return {
			items: this.#projector.timeline(nativeId),
			state: this.#projector.state(nativeId),
			notices: this.#projector.notices(nativeId, ""),
			meta: {
				title: record.title,
				directory: record.directory,
				lastActivityAt: record.lastActivityAt
			},
			skippedEventCount: this.#projector.skippedEvents(nativeId)
		};
	}
	#bindContext(ctx) {
		const subscribe = ctx?.event?.subscribe;
		if (typeof subscribe === "function") try {
			const stream = subscribe.call(ctx.event);
			if (isAsyncIterable(stream)) this.#consume(stream);
			else this.#logger.warn("event.subscribe returned a non-async-iterable; discovery stays partial(empty)");
		} catch (error) {
			this.#logger.warn("event.subscribe failed; discovery stays partial(empty)", { error: error instanceof Error ? error.name : typeof error });
		}
		else this.#logger.warn("event.subscribe unavailable; discovery stays partial(empty)");
		this.#sessionApi = ctx?.session;
		this.#agentApi = ctx?.agent;
		this.#modelApi = ctx?.model;
		this.#permission.install(ctx);
	}
	async #consume(stream) {
		try {
			for await (const event of stream) {
				if (this.#stopped) break;
				try {
					this.ingest(event);
				} catch {}
			}
		} catch (error) {
			if (!this.#stopped) this.#logger.warn("event stream ended", { error: error instanceof Error ? error.name : typeof error });
		}
	}
	#accept(socket) {
		socket.setNoDelay(true);
		this.#metrics.connections += 1;
		const connection = new BridgeConnection(socket, {
			onMessage: (message) => this.#onMessage(connection, message),
			onError: () => {
				this.#connections.delete(connection);
				socket.destroy();
			},
			onClose: () => {
				this.#connections.delete(connection);
			}
		});
		socket.on("error", () => socket.destroy());
		this.#connections.add(connection);
	}
	#onMessage(connection, message) {
		if (message === null || typeof message !== "object" || Array.isArray(message)) {
			sendError(connection, null, RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, "invalid JSON-RPC frame");
			return;
		}
		const frame = message;
		if (frame["jsonrpc"] !== "2.0") {
			sendError(connection, idOrNull(frame), RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, "jsonrpc must be \"2.0\"");
			return;
		}
		if (typeof frame["method"] === "string") {
			const id = frame["id"];
			if (id === void 0 || id === null) this.#onNotification(connection, frame["method"]);
			else if (typeof id === "string" || typeof id === "number") this.#onRequest(connection, id, frame["method"], frame["params"]);
			else sendError(connection, null, RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, "invalid request id");
			return;
		}
		if ("result" in frame || "error" in frame) {
			this.#metrics.ignoredResponses += 1;
			return;
		}
		sendError(connection, idOrNull(frame), RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, "not a JSON-RPC request or notification");
	}
	#onNotification(connection, method) {
		if (!connection.initialized) return;
		this.#metrics.incomingNotifications += 1;
		this.#logger.debug("bridge notification received", { method });
	}
	#onRequest(connection, id, method, params) {
		if (!connection.initialized) {
			if (method !== RPC_METHODS.initialize) {
				this.#metrics.handshakeFailures += 1;
				sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.handshakeRequired, "initialize must be the first frame");
				connection.close();
				return;
			}
			this.#initialize(connection, id, params);
			return;
		}
		if (method === RPC_METHODS.initialize) {
			sendError(connection, id, RPC_ERROR_CODES.invalidRequest, RPC_ERROR_DATA.invalidRequest, "already initialized");
			return;
		}
		if (WRITE_METHOD_LIST.includes(method)) {
			this.#dispatchWrite(connection, id, method, params);
			return;
		}
		if (CATALOG_METHOD_LIST.includes(method)) {
			this.#dispatchCatalog(connection, id, method, params);
			return;
		}
		if (!READ_ONLY_METHODS.includes(method)) {
			this.#metrics.rejectedRequests += 1;
			sendError(connection, id, RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.methodNotFound, `method not found: ${method}`);
			return;
		}
		this.#dispatch(connection, id, method, params);
	}
	#initialize(connection, id, params) {
		const values = asObject(params);
		const token = values["authToken"];
		if (typeof token !== "string" || !constantTimeEquals(token, this.#token)) {
			this.#metrics.handshakeFailures += 1;
			sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.unauthorized, "invalid auth token");
			connection.close();
			return;
		}
		if (values["runtime"] !== "opencode") {
			this.#metrics.handshakeFailures += 1;
			sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.runtimeMismatch, "runtime must be \"opencode\"");
			connection.close();
			return;
		}
		if (protocolMajor(values["protocolVersion"]) !== 1) {
			this.#metrics.handshakeFailures += 1;
			sendError(connection, id, RPC_ERROR_CODES.unauthorized, RPC_ERROR_DATA.protocolIncompatible, `protocol major must be 1`);
			connection.close();
			return;
		}
		const rawLocation = firstString(values["location"]);
		if (rawLocation === null || !isAbsoluteDirectory(rawLocation)) {
			this.#metrics.handshakeFailures += 1;
			sendError(connection, id, RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, "location must be an absolute directory for the opencode runtime");
			connection.close();
			return;
		}
		const namespace = firstString(values["sessionNamespace"]) ?? firstString(values["connectorId"]) ?? "";
		connection.initialized = true;
		connection.namespace = namespace;
		connection.connectorId = firstString(values["connectorId"]) ?? "";
		connection.userId = readClientUserId(values["clientInfo"]) ?? connection.connectorId;
		connection.location = normalizeDirectory(rawLocation);
		connection.send({
			jsonrpc: "2.0",
			id,
			result: {
				identity: {
					runtime: RUNTIME,
					protocolVersion: "1.0",
					runtimeVersion: this.#serviceVersion ?? "unknown",
					displayName: "OpenCode"
				},
				features: {
					syncMode: "events",
					readOnly: false
				},
				capabilities: this.#capabilities()
			}
		});
	}
	#dispatch(connection, id, method, params) {
		try {
			const values = asObject(params);
			let result;
			switch (method) {
				case RPC_METHODS.ping:
					result = {
						ok: true,
						runtime: RUNTIME,
						protocolVersion: "1.0"
					};
					break;
				case RPC_METHODS.runtimeGetCapabilities:
					result = this.#capabilities();
					break;
				case RPC_METHODS.sessionList:
					result = this.#sessionList(connection, values);
					break;
				case RPC_METHODS.sessionGetSnapshot:
					result = this.#sessionSnapshot(connection, values);
					break;
				case RPC_METHODS.sessionGetState:
					result = this.#sessionState(connection, values);
					break;
				case RPC_METHODS.sessionGetNotices:
					result = this.#sessionNotices(connection, values);
					break;
				case RPC_METHODS.runtimeSyncSubscribe:
					result = this.#syncSubscribe(connection, values);
					break;
				case RPC_METHODS.runtimeSyncAck:
					result = this.#syncAck(values);
					break;
				default:
					sendError(connection, id, RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.methodNotFound, `method not found: ${method}`);
					return;
			}
			connection.send({
				jsonrpc: "2.0",
				id,
				result
			});
		} catch (error) {
			if (error instanceof RpcFault) {
				sendError(connection, id, error.rpcCode, error.dataCode, error.message);
				return;
			}
			this.#logger.warn("bridge method failed", {
				method,
				error: error instanceof Error ? error.name : typeof error
			});
			sendError(connection, id, RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.internalError, "bridge method failed");
		}
	}
	/**
	* Directory surface (D3/D4). Answers asynchronously because a host `list()`
	* may be a promise; a missing surface becomes `UNSUPPORTED_OPERATION`, never
	* an internal error, so the Connector can attribute it correctly.
	*/
	async #dispatchCatalog(connection, id, method, params) {
		try {
			const values = asObject(params);
			let result;
			switch (method) {
				case CATALOG_METHODS.listAgents:
					result = await this.#listAgents(values);
					break;
				case CATALOG_METHODS.listModels:
					result = await this.#listModels(values);
					break;
				default: throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, `method not supported by this runtime: ${method}`);
			}
			connection.send({
				jsonrpc: "2.0",
				id,
				result
			});
		} catch (error) {
			if (error instanceof RpcFault) {
				sendError(connection, id, error.rpcCode, error.dataCode, error.message);
				return;
			}
			this.#logger.warn("bridge catalog method failed", {
				method,
				error: error instanceof Error ? error.name : typeof error
			});
			sendError(connection, id, RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.upstreamError, "bridge catalog method failed");
		}
	}
	/**
	* `catalog.listAgents` → `{ agents: [{ id, name?, description?, mode, hidden }] }`
	* (`mode ∈ {"primary","subagent","all"}`). Sourced from `ctx.agent.list()` (an
	* object `{ location, data }`) or, when only `transform` exists, from the
	* draft's `list()` inside `ctx.agent.transform(cb)`.
	*/
	async #listAgents(values) {
		const items = await collectCatalogItems(this.#agentApi);
		if (items === null) throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "the host exposes no agent catalog (ctx.agent.list/transform)");
		const agents = [];
		const seenAgentIds = /* @__PURE__ */ new Set();
		const duplicateAgentIds = [];
		for (const raw of items) {
			const agentId = firstString(raw["id"]);
			if (agentId === null) continue;
			if (seenAgentIds.has(agentId)) {
				duplicateAgentIds.push(agentId);
				continue;
			}
			seenAgentIds.add(agentId);
			const name = firstString(raw["name"]);
			const description = firstString(raw["description"]);
			agents.push({
				id: agentId,
				...name !== null ? { name } : {},
				...description !== null ? { description } : {},
				mode: normalizeAgentMode(raw["mode"]),
				hidden: raw["hidden"] === true
			});
		}
		if (duplicateAgentIds.length > 0) this.#logger.warn("agent catalog repeats an id; kept the first entry per id", { duplicates: [...new Set(duplicateAgentIds)] });
		return { agents };
	}
	/**
	* `catalog.listModels` → the envelope `models.model_catalog` decodes
	* (`{ runtime, revision, models: [{ id, title, ... }] }`). `ctx.model`'s item
	* shape is unverified (A10 probe did not expand it), so fields are read
	* defensively and a title falls back to the id, which the Connector requires.
	*
	* One row per id: the server's `validate_model_catalog` rejects the **whole**
	* catalog over a repeated `id` or `selectionId`, and the host legitimately
	* lists the same model id under two providers. Without collapsing them here a
	* single repeat poisons the catalog and every notification queued behind it —
	* observed on the real machine as 16× `duplicate model id` with the runtime
	* stuck before `running`. The first entry wins; its id doubles as the
	* selection id, which is still what the host needs to switch to that model.
	*/
	async #listModels(values) {
		const items = await collectCatalogItems(this.#modelApi);
		if (items === null) throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "the host exposes no model catalog (ctx.model.list/transform)");
		const models = [];
		const seenModelIds = /* @__PURE__ */ new Set();
		const duplicateModelIds = [];
		for (const raw of items) {
			const fallbackId = firstString(raw["modelID"]);
			const rawId = firstString(raw["id"]);
			const name = firstString(raw["name"]);
			const modelId = rawId ?? fallbackId ?? name;
			if (modelId === null) continue;
			const providerId = firstString(raw["providerID"]);
			const id = rawId === null && providerId !== null ? `${providerId}/${modelId}` : modelId;
			if (seenModelIds.has(id)) {
				duplicateModelIds.push(id);
				continue;
			}
			seenModelIds.add(id);
			const title = firstString(raw["title"]) ?? name ?? id;
			const description = firstString(raw["description"]);
			models.push({
				id,
				title,
				...description !== null ? { description } : {},
				selectionId: id
			});
		}
		if (duplicateModelIds.length > 0) this.#logger.warn("model catalog repeats an id; kept the first entry per id", { duplicates: [...new Set(duplicateModelIds)] });
		return {
			runtime: RUNTIME,
			revision: 1,
			models
		};
	}
	/**
	* Write surface (design §2.3, P3). Answers asynchronously because every method
	* awaits the host. Failures map to the same fault vocabulary as reads, plus
	* `UNSUPPORTED_OPERATION` when the host lacks the API.
	*/
	async #dispatchWrite(connection, id, method, params) {
		try {
			const values = asObject(params);
			let result;
			switch (method) {
				case WRITE_METHODS.sessionCreateAndStart:
					result = await this.#createAndStart(connection, values);
					break;
				case WRITE_METHODS.sessionStartTurn:
					result = await this.#startTurn(connection, values);
					break;
				case WRITE_METHODS.sessionSteerTurn: throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "session.steer is not supported by this runtime");
				case WRITE_METHODS.sessionInterrupt:
					result = await this.#interrupt(connection, values);
					break;
				case WRITE_METHODS.sessionUpdateSelections:
					result = await this.#updateSelections(connection, values);
					break;
				case WRITE_METHODS.sessionRespondInteraction:
					result = await this.#respondInteraction(connection, values);
					break;
				default: throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.methodNotFound, `method not found: ${method}`);
			}
			connection.send({
				jsonrpc: "2.0",
				id,
				result
			});
		} catch (error) {
			if (error instanceof RpcFault) {
				sendError(connection, id, error.rpcCode, error.dataCode, error.message);
				return;
			}
			this.#logger.warn("bridge write method failed", {
				method,
				error: error instanceof Error ? error.name : typeof error
			});
			sendError(connection, id, RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.upstreamError, "bridge write method failed");
		}
	}
	#sessionWriteApi() {
		const session = this.#sessionApi;
		if (session === void 0) throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "the host exposes no session write surface");
		return session;
	}
	async #createAndStart(connection, values) {
		const session = this.#sessionWriteApi();
		requireString(values["content"], "content");
		rejectAttachments(values["attachments"]);
		const cwd = firstString(values["cwd"]);
		const create = session.create;
		const prompt = session.prompt;
		if (typeof create !== "function" || typeof prompt !== "function") throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "session.create/prompt unavailable on this host");
		const createOptions = {};
		if (cwd !== null) createOptions["directory"] = cwd;
		const nativeId = readNativeSessionId(await create.call(session, createOptions));
		if (nativeId === null) throw new RpcFault(RPC_ERROR_CODES.internalError, RPC_ERROR_DATA.upstreamError, "session.create returned no session id");
		this.#claim(nativeId, connection.connectorId);
		await prompt.call(session, promptOptions(nativeId, values, cwd));
		return {
			ok: true,
			runtime: RUNTIME,
			sessionId: platformSessionId(connection.namespace, nativeId),
			externalSessionId: nativeId
		};
	}
	async #startTurn(connection, values) {
		const session = this.#sessionWriteApi();
		requireString(values["content"], "content");
		rejectAttachments(values["attachments"]);
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		this.#claim(record.nativeId, connection.connectorId);
		const prompt = session.prompt;
		if (typeof prompt !== "function") throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "session.prompt unavailable on this host");
		await prompt.call(session, promptOptions(record.nativeId, values, firstString(values["cwd"])));
		return {
			ok: true,
			runtime: RUNTIME,
			sessionId,
			externalSessionId: record.nativeId
		};
	}
	async #interrupt(connection, values) {
		const session = this.#sessionWriteApi();
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		const interrupt = session.interrupt;
		if (typeof interrupt !== "function") throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "session.interrupt unavailable on this host");
		const reason = firstString(values["reason"]);
		const options = { sessionID: record.nativeId };
		if (reason !== null) options["reason"] = reason;
		await interrupt.call(session, options);
		return {
			ok: true,
			runtime: RUNTIME,
			sessionId,
			externalSessionId: record.nativeId
		};
	}
	async #updateSelections(connection, values) {
		const session = this.#sessionWriteApi();
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		const selections = asObject(values["selections"]);
		const applied = [];
		const ignored = [];
		for (const [key, raw] of Object.entries(selections)) {
			const target = selectionTarget(key);
			if (target === null) {
				ignored.push(key);
				continue;
			}
			const selection = typeof raw === "string" ? raw : null;
			const method = session[target];
			if (typeof method !== "function") throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, `session.${target} unavailable on this host`);
			await method.call(session, {
				sessionID: record.nativeId,
				[target === "switchModel" ? "model" : "agent"]: selection
			});
			applied.push(key);
		}
		return {
			ok: true,
			runtime: RUNTIME,
			sessionId,
			externalSessionId: record.nativeId,
			applied,
			ignored
		};
	}
	async #respondInteraction(connection, values) {
		const sessionId = requireSessionId(values);
		const noticeId = requireString(values["noticeId"], "noticeId");
		const actionId = requireString(values["actionId"], "actionId");
		const record = this.#resolve(connection, sessionId);
		const outcome = await this.#permission.answer({
			noticeId,
			actionId,
			userId: connection.userId,
			nativeSessionId: record.nativeId,
			connectorId: connection.connectorId
		});
		if (outcome.ok) return {
			ok: true,
			runtime: RUNTIME,
			sessionId,
			noticeId,
			actionId,
			result: {
				requestId: outcome.requestId,
				actionId: outcome.actionId
			}
		};
		return {
			ok: false,
			runtime: RUNTIME,
			sessionId,
			noticeId,
			actionId,
			code: outcome.code,
			message: outcome.message
		};
	}
	#sessionList(connection, values) {
		const limit = optionalLimit(values["limit"]) ?? void 0;
		this.#sessionIndex.maybeRefresh();
		const records = this.#sessions.list(void 0, connection.location ?? void 0).filter((record) => !this.#sessionIndex.isChild(record.nativeId));
		const page = limit !== void 0 && limit >= 0 ? records.slice(0, limit) : records;
		return {
			runtime: RUNTIME,
			partial: this.#sessions.partial,
			sessions: page.map((record) => this.#sessionMeta(connection, record))
		};
	}
	#sessionMeta(connection, record) {
		return {
			sessionId: platformSessionId(connection.namespace, record.nativeId),
			externalSessionId: record.nativeId,
			runtime: RUNTIME,
			...record.title !== null ? { title: record.title } : {},
			...record.directory.length > 0 ? { cwd: record.directory } : {},
			...record.lastActivityAt !== null ? { orderingTime: record.lastActivityAt } : {},
			metadata: {
				partial: true,
				discovery: "event-stream",
				directory: record.directory
			}
		};
	}
	#sessionSnapshot(connection, values) {
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		const snapshot = this.#projector.snapshot(record.nativeId, sessionId);
		if (snapshot === null) throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.sessionNotFound, "session has no projected timeline yet");
		return {
			sessionId,
			externalSessionId: record.nativeId,
			runtime: RUNTIME,
			items: snapshot.items,
			watermark: snapshot.watermark,
			snapshotComplete: snapshot.complete,
			metadata: {
				totalItems: snapshot.totalItems,
				partial: true,
				skippedEvents: snapshot.skippedEvents,
				limit: optionalLimit(values["limit"])
			}
		};
	}
	#sessionState(connection, values) {
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		const state = this.#projector.state(record.nativeId) ?? {
			status: "idle",
			statusReason: null,
			selections: {},
			error: null,
			openInteractions: 0
		};
		return {
			sessionId,
			externalSessionId: record.nativeId,
			runtime: RUNTIME,
			status: state.status,
			selections: state.selections,
			...state.statusReason !== null ? { statusReason: state.statusReason } : {},
			...state.error !== null ? { error: state.error } : {},
			metadata: {
				partial: true,
				openInteractions: state.openInteractions
			}
		};
	}
	#sessionNotices(connection, values) {
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		const notices = this.#projector.notices(record.nativeId, sessionId).map((notice) => this.#noticeWire(notice, sessionId));
		return {
			runtime: RUNTIME,
			notices
		};
	}
	/**
	* Re-key one projected notice onto the peer's platform session id. The
	* projector only knows the native id, so `blocking.targetId` (AA
	* `{scope:'session', targetId}`) is rewritten here to the wire session id.
	*/
	#noticeWire(notice, sessionId) {
		const blocking = notice.blocking;
		return {
			...notice,
			sessionId,
			runtime: RUNTIME,
			blocking: blocking !== null && blocking["scope"] === "session" ? {
				...blocking,
				targetId: sessionId
			} : blocking
		};
	}
	/**
	* Open a push-sync calibration (design §2.3 / rev3 ruling 3). The response is
	* the subscription handle; the history itself follows as `sync.batch` frames
	* (begin → items → commit), exactly the page protocol the Connector's
	* `SyncRelay` reassembles.
	*/
	#syncSubscribe(connection, values) {
		const sessionId = requireSessionId(values);
		const record = this.#resolve(connection, sessionId);
		this.#claim(record.nativeId, connection.connectorId);
		const selection = this.#sync.select(record.nativeId, optionalSequence(values["fromSeq"]), historyHashOrNull(values["historyHash"]));
		const streamId = randomUUID();
		connection.subscriptions.set(sessionId, streamId);
		const diagnostics = { skippedEventCount: this.#projector.skippedEvents(record.nativeId) };
		const selected = selection.itemIds;
		const items = selected === null ? this.#projector.timeline(record.nativeId) : this.#projector.timeline(record.nativeId).filter((item) => selected.includes(item.id));
		this.#sendSyncBatch(connection, {
			sessionId,
			streamId,
			phase: "begin",
			resume: selection.mode,
			...selection.fromSeq !== null ? { fromSeq: selection.fromSeq } : {},
			throughSeq: selection.throughSeq,
			historyHash: selection.historyHash,
			meta: this.#metaWire(connection, record),
			diagnostics
		});
		for (let index = 0; index < items.length; index += this.#syncPageItems) {
			const page = items.slice(index, index + this.#syncPageItems);
			this.#sendSyncBatch(connection, {
				sessionId,
				streamId,
				phase: "items",
				items: page.map((item) => ({
					...item,
					sessionId
				}))
			});
		}
		this.#sendSyncBatch(connection, {
			sessionId,
			streamId,
			phase: "commit",
			complete: selection.mode === "snapshot",
			externalSessionId: record.nativeId,
			throughSeq: selection.throughSeq,
			historyHash: selection.historyHash,
			diagnostics
		});
		return {
			sessionId,
			streamId,
			resume: selection.mode,
			throughSeq: selection.throughSeq,
			historyHash: selection.historyHash
		};
	}
	/**
	* Checkpoint ack. `throughSeq` is Hub-owned (rev3 §4.1): this only confirms
	* that the Connector's ingest completed, it never moves the value itself.
	* The Connector sends this as a request, so it must be answered.
	*/
	#syncAck(values) {
		const sessionId = requireSessionId(values);
		const throughSeq = values["throughSeq"];
		if (typeof throughSeq !== "number" || !Number.isInteger(throughSeq) || throughSeq < -1) throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, "throughSeq is required");
		return {
			ok: true,
			sessionId,
			throughSeq
		};
	}
	#metaWire(connection, record) {
		return {
			sessionId: platformSessionId(connection.namespace, record.nativeId),
			externalSessionId: record.nativeId,
			runtime: RUNTIME,
			...record.title !== null ? { title: record.title } : {},
			...record.directory.length > 0 ? { cwd: record.directory } : {},
			...record.lastActivityAt !== null ? { orderingTime: record.lastActivityAt } : {},
			metadata: {
				partial: true,
				discovery: "event-stream",
				directory: record.directory
			}
		};
	}
	#stateWire(connection, record, state) {
		return {
			sessionId: platformSessionId(connection.namespace, record.nativeId),
			externalSessionId: record.nativeId,
			runtime: RUNTIME,
			status: state.status,
			selections: state.selections,
			...state.statusReason !== null ? { statusReason: state.statusReason } : {},
			...state.error !== null ? { error: state.error } : {},
			metadata: {
				partial: true,
				openInteractions: state.openInteractions
			}
		};
	}
	#sendSyncBatch(connection, params) {
		connection.send({
			jsonrpc: "2.0",
			method: BRIDGE_NOTIFICATION_METHODS.syncBatch,
			params
		});
	}
	#resolve(connection, sessionId) {
		const record = this.#sessions.findByPlatformId(sessionId, connection.namespace, connection.location ?? void 0);
		if (record === void 0) throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.sessionNotFound, "unknown session");
		return record;
	}
	/**
	* §6⑤: record the first device to claim a session. First claim wins so a
	* later connection cannot steal a notice already bound to another device.
	*/
	#claim(nativeId, connectorId) {
		if (connectorId.length === 0) return;
		if (!this.#sessionOwners.has(nativeId)) {
			this.#sessionOwners.set(nativeId, connectorId);
			this.#permission.bindPending(nativeId, connectorId);
		}
	}
	#capabilities() {
		const discoveryState = this.#sessions.partial ? "partial" : "complete";
		this.#sessionIndex.maybeRefresh();
		const session = this.#sessionApi;
		const canCreate = typeof session?.create === "function";
		const canPrompt = typeof session?.prompt === "function";
		const canInterrupt = typeof session?.interrupt === "function";
		const canListAgents = hasCatalogSurface(this.#agentApi);
		const canListModels = hasCatalogSurface(this.#modelApi);
		const rows = [
			capability(CAPABILITY_IDS.sessionList),
			capability(CAPABILITY_IDS.sessionSnapshot),
			capability(CAPABILITY_IDS.sessionState),
			capability(CAPABILITY_IDS.sessionNotices),
			discoveryRow(discoveryState),
			subagentsRow(discoveryState, this.#sessionIndex),
			derived(CAPABILITY_IDS.sessionSendMessage, canCreate && canPrompt, "host exposes no session.create/prompt"),
			derived(CAPABILITY_IDS.sessionInterrupt, canInterrupt, "host exposes no session.interrupt"),
			derived(CAPABILITY_IDS.sessionInteractionApproval, this.#permission.replyAvailable && this.#permission.attached, "host exposes no permission.reply / evaluate hook"),
			unavailable(CAPABILITY_IDS.catalogPermission),
			derived(CAPABILITY_IDS.catalogModel, canListModels, "host exposes no model.list/transform"),
			derived(CAPABILITY_IDS.catalogAgent, canListAgents, "host exposes no agent.list/transform"),
			unavailable(CAPABILITY_IDS.sessionSteer),
			unavailable(CAPABILITY_IDS.sessionCommands),
			unavailable(CAPABILITY_IDS.runtimeAttachment)
		];
		const capabilities = this.#hostVersion.supported === false ? rows.map((row) => markVersionUnverified(row)) : rows;
		return {
			runtime: RUNTIME,
			revision: 1,
			capabilities,
			metadata: {
				readOnly: false,
				syncMode: "events",
				discoveryState,
				filtered: this.#sessions.filtered,
				hostVersion: this.#hostVersion.version,
				hostVersionSource: this.#hostVersion.source,
				hostVersionSupported: this.#hostVersion.supported,
				...this.#hostVersion.reason !== null ? { hostVersionReason: this.#hostVersion.reason } : {}
			}
		};
	}
};
var RpcFault = class extends Error {
	rpcCode;
	dataCode;
	constructor(rpcCode, dataCode, message) {
		super(message);
		this.rpcCode = rpcCode;
		this.dataCode = dataCode;
	}
};
/** One NDJSON connection: line framing with an 8 MiB per-frame ceiling. */
var BridgeConnection = class {
	socket;
	initialized = false;
	namespace = "";
	connectorId = "";
	/** Handshake-bound answering identity (§6 ①⑤); never re-read from later frames. */
	userId = "";
	/** Normalised `location` this connection may see (rev3 ruling 1). */
	location = null;
	/** Platform sessionId → live `sync.batch` streamId for this connection. */
	subscriptions = /* @__PURE__ */ new Map();
	#handlers;
	#buffer = Buffer.alloc(0);
	#closed = false;
	constructor(socket, handlers) {
		this.socket = socket;
		this.#handlers = handlers;
		socket.on("data", (chunk) => this.#push(chunk));
		socket.on("close", () => {
			this.#closed = true;
			this.#handlers.onClose();
		});
		socket.on("error", () => this.#handlers.onError());
	}
	send(frame) {
		if (this.#closed || this.socket.destroyed) return;
		let encoded;
		try {
			encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
		} catch {
			return;
		}
		if (encoded.length > 8388608) {
			this.close();
			return;
		}
		try {
			this.socket.write(encoded);
		} catch {}
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.socket.end();
		} catch {
			this.socket.destroy();
		}
	}
	#push(chunk) {
		if (this.#closed) return;
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		if (this.#buffer.length > 8388608 && this.#buffer.indexOf(10) === -1) {
			this.send(errorFrame(null, RPC_ERROR_CODES.parseError, RPC_ERROR_DATA.parseError, "frame exceeds 8 MiB"));
			this.socket.destroy();
			return;
		}
		let index = this.#buffer.indexOf(10);
		while (index !== -1) {
			const line = this.#buffer.subarray(0, index);
			this.#buffer = this.#buffer.subarray(index + 1);
			if (index > 8388608) {
				this.send(errorFrame(null, RPC_ERROR_CODES.parseError, RPC_ERROR_DATA.parseError, "frame exceeds 8 MiB"));
				this.socket.destroy();
				return;
			}
			if (line.length > 0) this.#handleLine(line);
			index = this.#buffer.indexOf(10);
		}
	}
	#handleLine(line) {
		let parsed;
		try {
			parsed = JSON.parse(line.toString("utf8"));
		} catch {
			this.send(errorFrame(null, RPC_ERROR_CODES.parseError, RPC_ERROR_DATA.parseError, "invalid JSON"));
			return;
		}
		this.#handlers.onMessage(parsed);
	}
};
function sendError(connection, id, code, dataCode, message) {
	connection.send(errorFrame(id, code, dataCode, message));
}
function errorFrame(id, code, dataCode, message) {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			data: {
				code: dataCode,
				retryable: false
			}
		}
	};
}
function capability(capabilityId) {
	return {
		capabilityId,
		scope: "runtime",
		runtime: RUNTIME,
		version: "1",
		supported: true,
		available: true,
		allowed: true,
		metadata: {}
	};
}
/**
* A capability whose support is derived at `install()` time. `probe:'unverified'`
* records that the host surface itself is not confirmed (research doc 02): the
* row reflects what `ctx.session` currently exposes, not a guarantee.
*/
function derived(capabilityId, ok, reason) {
	if (ok) return {
		capabilityId,
		scope: "runtime",
		runtime: RUNTIME,
		version: "1",
		supported: true,
		available: true,
		allowed: true,
		metadata: { probe: "unverified" }
	};
	return {
		capabilityId,
		scope: "runtime",
		runtime: RUNTIME,
		version: "1",
		supported: false,
		available: false,
		allowed: false,
		unavailableReason: reason,
		metadata: { probe: "unverified" }
	};
}
function unavailable(capabilityId) {
	return {
		capabilityId,
		scope: "runtime",
		runtime: RUNTIME,
		version: "1",
		supported: false,
		available: false,
		allowed: false,
		unavailableReason: "not implemented by this runtime",
		metadata: {}
	};
}
/**
* P6: when the host version is out of the supported range the surface may still
* answer, but we cannot vouch for it. Annotate the row `probe:"unverified"`
* (same wording as `derived`) and flag the cause — never silently healthy.
*/
function markVersionUnverified(row) {
	return {
		...row,
		metadata: {
			...row.metadata,
			probe: "unverified",
			hostVersionOutOfRange: true
		}
	};
}
/**
* `session.discovery` row (rev3 ruling 2). The row stays a normal boolean
* capability — the Connector's `opencode_capabilities` gates on
* supported/available/allowed — while the partial/complete state rides
* `metadata.discoveryState`, never a root `sessionDiscovery` field.
*/
function discoveryRow(state) {
	return {
		capabilityId: CAPABILITY_IDS.sessionDiscovery,
		scope: "runtime",
		runtime: RUNTIME,
		version: "1",
		supported: true,
		available: true,
		allowed: true,
		metadata: {
			discoveryState: state,
			...state === "partial" ? { reason: "cold-start blind spot: sessions are discovered from the global event stream only" } : {}
		}
	};
}
/**
* `session.subagents` row — honest subagent coverage.
*
* Measured (spike 02 §3.1–§3.3): a subagent session's own events reach the
* global stream with its own `sessionID`, so such a session is discovered and
* projected exactly like any other — that is the *only* thing the row's
* `supported:true` claims.
*
* The parent/child linkage comes from a **separate, TUI-only channel**: the TUI
* plugin enumerates sessions through the host SDK client (`api.client`, whose v2
* `Session` type carries `parentID`) and writes `session-index.json`; the Hub
* reads that file. The row therefore reports `parentRelation: "supported"` with
* `parentRelationSource: "tui-session-index"` **only while the index is fresh**,
* and falls back to `"unavailable"` with a reason when it is missing, corrupt or
* expired. It never claims more than the channel can back: the runtime's own
* surface (`session.created` payload, `ctx.session.get`, `/session/{id}/children`)
* still exposes no parentID, and the TUI channel itself is not yet verified on a
* real host (A10).
*
* `discoveryState` mirrors `session.discovery`: child events are visible only
* from the subscribe point (no replay).
*/
function subagentsRow(state, index) {
	const base = {
		capabilityId: CAPABILITY_IDS.sessionSubagents,
		scope: "runtime",
		runtime: RUNTIME,
		version: "1",
		supported: true,
		available: true,
		allowed: true
	};
	if (index.available) return {
		...base,
		metadata: {
			eventVisibility: "supported",
			parentRelation: "supported",
			parentRelationSource: "tui-session-index",
			parentRelationReason: "parent/child linkage read from the TUI-written session index (host client api.client.session.list). The TUI channel itself is not yet verified on a real host (A10), so this follows the index only while it is fresh",
			sessionIndexState: index.state,
			sessionIndexUpdatedAt: index.updatedAt,
			discoveryState: state,
			evidence: "session-index.json (TUI write) + spike 02 §3.1-§3.3, §4"
		}
	};
	return {
		...base,
		metadata: {
			eventVisibility: "supported",
			parentRelation: "unavailable",
			parentRelationReason: `no usable TUI session index (state=${index.state}): the runtime exposes no parentID (session.created payload has no info field, ctx.session.get has no parentID/children, and /session/{id}/children is 404 on this build), and the TUI channel has not published a fresh index`,
			sessionIndexState: index.state,
			discoveryState: state,
			evidence: "spike 02 §3.1-§3.3, §4"
		}
	};
}
function asObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function idOrNull(frame) {
	const id = frame["id"];
	return typeof id === "string" || typeof id === "number" ? id : null;
}
function firstString(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}
/**
* Normalize an agent's `mode`. An unknown/absent value becomes `"all"`, which
* callers treat as switchable — never silently dropped from the directory.
*/
function normalizeAgentMode(value) {
	return value === "primary" || value === "subagent" || value === "all" ? value : "all";
}
/** Does the host domain expose a way to enumerate its catalog? */
function hasCatalogSurface(api) {
	return typeof api?.list === "function" || typeof api?.transform === "function";
}
/**
* Collect catalog items from `ctx.<domain>`, tolerating all three observed
* shapes: a bare array, a `{ data: [] }` envelope (the A10-measured
* `ctx.agent.list()` shape), or a `transform(cb)` draft with a `list()` method.
* Returns `null` when the host exposes neither surface (→ UNSUPPORTED).
*/
async function collectCatalogItems(api) {
	if (api === void 0) return null;
	if (typeof api.list === "function") {
		const items = readCatalogItems(await api.list.call(api));
		if (items !== null) return items;
	}
	if (typeof api.transform === "function") {
		const holder = { items: null };
		await api.transform.call(api, (draft) => {
			const list = asObject(draft)["list"];
			if (typeof list === "function") {
				const items = readCatalogItems(list.call(draft));
				if (items !== null) holder.items = items;
			}
		});
		if (holder.items !== null) return holder.items;
	}
	return null;
}
function readCatalogItems(snapshot) {
	if (Array.isArray(snapshot)) return snapshot.filter(isJsonObject);
	if (snapshot !== null && typeof snapshot === "object") {
		const data = snapshot["data"];
		if (Array.isArray(data)) return data.filter(isJsonObject);
	}
	return null;
}
function isJsonObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function optionalLimit(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
/** `fromSeq`: a known durable sequence, or `null` (treated as absent). */
function optionalSequence(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
/** A malformed/absent `historyHash` degrades to a full snapshot (rev3 ruling 3). */
function historyHashOrNull(value) {
	return typeof value === "string" && HISTORY_HASH_PATTERN.test(value) ? value : null;
}
function requireSessionId(values) {
	const sessionId = firstString(values["sessionId"]);
	if (sessionId === null) throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, "sessionId is required");
	return sessionId;
}
/**
* The Hub advertises `runtime.attachment` as unavailable (P3 scope) and the
* Connector refuses attachments too — this keeps the two ends consistent: a
* non-empty attachment list is refused loudly, never silently dropped.
*/
function rejectAttachments(value) {
	if (Array.isArray(value) && value.length > 0) throw new RpcFault(RPC_ERROR_CODES.methodNotFound, RPC_ERROR_DATA.unsupportedOperation, "attachments are not supported by this runtime");
}
function requireString(value, label) {
	const text = firstString(value);
	if (text === null) throw new RpcFault(RPC_ERROR_CODES.invalidParams, RPC_ERROR_DATA.invalidParams, `${label} is required`);
	return text;
}
/** The `ctx.session.prompt` options object (session method shapes are unverified; see opencode-ctx). */
function promptOptions(nativeId, values, cwd) {
	const options = { sessionID: nativeId };
	if (typeof values["content"] === "string") options["content"] = values["content"];
	if (values["selections"] !== void 0) options["selections"] = asObject(values["selections"]);
	const clientMessageId = firstString(values["clientMessageId"]);
	if (clientMessageId !== null) options["clientMessageId"] = clientMessageId;
	if (cwd !== null) options["cwd"] = cwd;
	return options;
}
/** `ctx.session.create` returns `{id}` (SDK style); accept a bare string too. */
function readNativeSessionId(value) {
	if (typeof value === "string" && value.length > 0) return value;
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value;
		return firstString(record["id"]) ?? firstString(record["sessionID"]) ?? firstString(record["sessionId"]);
	}
	return null;
}
const MODEL_SELECTION_KEYS = /* @__PURE__ */ new Set([
	"model",
	"modelId",
	"modelID"
]);
const AGENT_SELECTION_KEYS = /* @__PURE__ */ new Set([
	"agent",
	"agentId",
	"agentID"
]);
function selectionTarget(key) {
	if (MODEL_SELECTION_KEYS.has(key)) return "switchModel";
	if (AGENT_SELECTION_KEYS.has(key)) return "switchAgent";
	return null;
}
/** `clientInfo.userId` from the initialize handshake (§6 device identity). */
function readClientUserId(clientInfo) {
	if (clientInfo === null || typeof clientInfo !== "object" || Array.isArray(clientInfo)) return null;
	const record = clientInfo;
	return firstString(record["userId"]) ?? firstString(record["user"]) ?? firstString(record["id"]);
}
function isAsyncIterable(value) {
	return value !== null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";
}
function constantTimeEquals(candidate, expected) {
	const left = Buffer.from(candidate, "utf8");
	const right = Buffer.from(expected, "utf8");
	if (left.length !== right.length) {
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}
const NOOP_CLEANUP$1 = () => void 0;
/**
* Entry point used by `server/index.ts`. Adopts an existing hub when a previous
* `setup()` already started one (hot reload / second location), so the listener,
* the event subscription and the permission hook are created exactly once.
*/
async function installPlugin(ctx) {
	const key = Symbol.for(HUB_GLOBAL_KEY);
	const globals = globalThis;
	const existing = globals[key];
	let hub;
	if (existing instanceof BridgeHub) hub = existing;
	else {
		const serviceVersion = readServiceVersion(ctx);
		const created = new BridgeHub(serviceVersion === void 0 ? {} : { serviceVersion });
		try {
			await created.start();
		} catch (error) {
			createLogger("bridge-hub").error("failed to start the bridge hub; plugin disabled", { error: error instanceof Error ? error.name : typeof error });
			return NOOP_CLEANUP$1;
		}
		globals[key] = created;
		hub = created;
	}
	let release;
	try {
		release = await hub.install(ctx);
	} catch (error) {
		createLogger("bridge-hub").error("failed to adopt the bridge hub for this location", { error: error instanceof Error ? error.name : typeof error });
		return NOOP_CLEANUP$1;
	}
	return async () => {
		await release();
		if (hub.stopped && globals[key] === hub) delete globals[key];
	};
}
//#endregion
//#region src/shared/credentials.ts
/**
* On-disk credential + settings store (design §5.3, §1「凭据三层分离」).
*
* Layout under `~/.agents-anywhere/opencode-plugin/` (base honours
* `AGENT_CONNECTOR_DATA_DIR`, the same override the endpoint registry uses):
*
*   settings.json                      only `apiBaseUrl` — never a secret
*   account.json                       账号层: server / account id / access token
*   bindings/<serverKey>/<accountId>.json  设备层: connector_id + connector token
*   pending-flow.json                  进行中的回环 OAuth, 非凭据
*
* The layout mirrors the DSH/Connector convention (`~/.agents-anywhere`) so a
* Desktop or DSH install can reuse the same identities.
*
* **Three credential layers never substitute for one another**: the account
* token (account.json) is not the device token (bindings/…), and neither is the
* 32-byte loopback endpoint token (`endpoint-store`, memory only). This module
* owns the first two exclusively and never reads or writes the third.
*
* Every write is atomic (tmp → fsync → rename) and `0600` inside a `0700`
* directory. Tokens/codes never reach a log: callers pass only paths and ids.
*/
const PLUGIN_DIR_NAME = "opencode-plugin";
const SETTINGS_FILE = "settings.json";
const ACCOUNT_FILE = "account.json";
const BINDINGS_DIR = "bindings";
const PENDING_FLOW_FILE = "pending-flow.json";
const CONNECTOR_RUNTIME_FILE = "connector-runtime.json";
/** An access token is treated as spent this long before its stated expiry. */
const ACCOUNT_EXPIRY_SKEW_MS = 6e4;
/** `<data-dir>/opencode-plugin`. */
function pluginDataDir(env = process.env) {
	const override = env[DATA_DIR_ENV];
	const base = override && override.trim().length > 0 ? override : join(homedir(), DATA_DIR_NAME);
	return join(base, PLUGIN_DIR_NAME);
}
function settingsPath(dataDir) {
	return join(dataDir, SETTINGS_FILE);
}
function accountPath(dataDir) {
	return join(dataDir, ACCOUNT_FILE);
}
function pendingFlowPath(dataDir) {
	return join(dataDir, PENDING_FLOW_FILE);
}
/** The shared lease file lives one level *above* the plugin dir (Connector-owned). */
function connectorRuntimePath(env = process.env) {
	const override = env[DATA_DIR_ENV];
	const base = override && override.trim().length > 0 ? override : join(homedir(), DATA_DIR_NAME);
	return join(base, CONNECTOR_RUNTIME_FILE);
}
/**
* Stable directory key for one server origin. Hashing keeps a URL with odd
* characters out of the path and makes the directory name fixed-length.
*/
function serverKey(apiBaseUrl) {
	const normalized = normalizeOrigin(apiBaseUrl);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}
function accountKey(userId) {
	const safe = userId.replace(/[^A-Za-z0-9._-]/g, "_");
	if (safe.length === 0 || safe === "." || safe === "..") return `acct_${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
	return safe.slice(0, 128);
}
function bindingPath(dataDir, apiBaseUrl, userId) {
	return join(dataDir, BINDINGS_DIR, serverKey(apiBaseUrl), `${accountKey(userId)}.json`);
}
/** Bare origin (`scheme://host[:port]`) used as the identity of a server. */
function normalizeOrigin(apiBaseUrl) {
	try {
		return new URL(apiBaseUrl).origin;
	} catch {
		return apiBaseUrl.trim().replace(/\/+$/, "");
	}
}
/** Read + JSON-parse a file; a missing file is `null`, a corrupt file throws. */
async function readJsonFile(path) {
	let raw;
	try {
		raw = await promises.readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`corrupt JSON at ${path}`);
	}
}
/**
* Write JSON atomically: a `0600` temp file in a `0700` directory, fsynced, then
* renamed over the target. A reader sees either the old file or the complete new
* one — never a partial write.
*/
async function writeJsonAtomic(path, value) {
	await promises.mkdir(join(path, ".."), {
		recursive: true,
		mode: 448
	});
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await promises.open(tmp, "w", 384);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await promises.rename(tmp, path);
	} catch (error) {
		await promises.rm(tmp, { force: true }).catch(() => void 0);
		throw error;
	}
}
async function removeFile(path) {
	await promises.rm(path, { force: true });
}
async function readSettings(dataDir) {
	const value = await readJsonFile(settingsPath(dataDir));
	if (value === null || typeof value !== "object") return null;
	if (typeof value.apiBaseUrl !== "string" || value.apiBaseUrl.length === 0) return null;
	return {
		version: 1,
		apiBaseUrl: value.apiBaseUrl
	};
}
async function readAccount(dataDir) {
	const value = await readJsonFile(accountPath(dataDir));
	if (value === null || typeof value !== "object") return null;
	if (typeof value.accessToken !== "string" || value.accessToken.length === 0) return null;
	if (typeof value.userId !== "string" || value.userId.length === 0) return null;
	if (typeof value.apiBaseUrl !== "string" || value.apiBaseUrl.length === 0) return null;
	if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
	return {
		version: 1,
		apiBaseUrl: value.apiBaseUrl,
		userId: value.userId,
		displayName: typeof value.displayName === "string" ? value.displayName : value.userId,
		email: typeof value.email === "string" ? value.email : null,
		accessToken: value.accessToken,
		expiresAt: value.expiresAt
	};
}
async function saveAccount(dataDir, account) {
	await writeJsonAtomic(accountPath(dataDir), account);
}
async function clearAccount(dataDir) {
	await removeFile(accountPath(dataDir));
}
/** Reuse-first gate: an unexpired token with a 60 s safety skew. */
function accountIsUsable(account, nowMs = Date.now(), skewMs = ACCOUNT_EXPIRY_SKEW_MS) {
	return account !== null && account.expiresAt - skewMs > nowMs;
}
async function readBinding(dataDir, apiBaseUrl, userId) {
	const value = await readJsonFile(bindingPath(dataDir, apiBaseUrl, userId));
	if (value === null || typeof value !== "object") return null;
	if (typeof value.connectorId !== "string" || value.connectorId.length === 0) return null;
	if (typeof value.connectorToken !== "string" || value.connectorToken.length === 0) return null;
	return {
		version: 1,
		connectorId: value.connectorId,
		connectorToken: value.connectorToken,
		name: typeof value.name === "string" ? value.name : "OpenCode",
		installationId: typeof value.installationId === "string" && value.installationId.length > 0 ? value.installationId : value.connectorId
	};
}
async function saveBinding(dataDir, apiBaseUrl, userId, binding) {
	await writeJsonAtomic(bindingPath(dataDir, apiBaseUrl, userId), binding);
}
async function clearBinding(dataDir, apiBaseUrl, userId) {
	await removeFile(bindingPath(dataDir, apiBaseUrl, userId));
}
const PENDING_REGISTRATION_SUFFIX = ".pending.json";
function pendingRegistrationPath(dataDir, apiBaseUrl, userId) {
	return `${bindingPath(dataDir, apiBaseUrl, userId)}${PENDING_REGISTRATION_SUFFIX}`;
}
async function readPendingRegistration(dataDir, apiBaseUrl, userId) {
	const value = await readJsonFile(pendingRegistrationPath(dataDir, apiBaseUrl, userId));
	if (value === null || typeof value !== "object") return null;
	if (typeof value.installationId !== "string" || value.installationId.length === 0) return null;
	return {
		version: 1,
		installationId: value.installationId,
		name: typeof value.name === "string" && value.name.length > 0 ? value.name : "OpenCode",
		createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : 0
	};
}
async function savePendingRegistration(dataDir, apiBaseUrl, userId, pending) {
	await writeJsonAtomic(pendingRegistrationPath(dataDir, apiBaseUrl, userId), pending);
}
async function clearPendingRegistration(dataDir, apiBaseUrl, userId) {
	await removeFile(pendingRegistrationPath(dataDir, apiBaseUrl, userId));
}
async function readPendingFlow(dataDir) {
	const value = await readJsonFile(pendingFlowPath(dataDir));
	if (value === null || typeof value !== "object") return null;
	if (typeof value.state !== "string" || value.state.length === 0) return null;
	if (typeof value.verifier !== "string" || value.verifier.length === 0) return null;
	if (typeof value.deadline !== "number" || !Number.isFinite(value.deadline)) return null;
	return {
		version: 1,
		apiBaseUrl: typeof value.apiBaseUrl === "string" ? value.apiBaseUrl : "",
		state: value.state,
		verifier: value.verifier,
		redirectUri: typeof value.redirectUri === "string" ? value.redirectUri : "",
		createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
		deadline: value.deadline
	};
}
/** A pending flow is only resumable while it is unexpired and still matched. */
function pendingFlowIsLive(flow, nowMs = Date.now()) {
	return flow !== null && flow.deadline > nowMs;
}
async function savePendingFlow(dataDir, flow) {
	await writeJsonAtomic(pendingFlowPath(dataDir), flow);
}
async function clearPendingFlow(dataDir) {
	await removeFile(pendingFlowPath(dataDir));
}
/**
* Read the shared `connector-runtime.json`. Any malformed/absent file is `null`
* (reuse is an optimisation, never a hard dependency).
*/
async function readConnectorRuntime(env = process.env) {
	return readConnectorRuntimeAt(connectorRuntimePath(env));
}
/** Same parse, from an explicit path (the Connector's mutex ignores overrides). */
async function readConnectorRuntimeAt(path) {
	let value;
	try {
		value = await readJsonFile(path);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object") return null;
	const ids = Array.isArray(value.connectorIds) ? value.connectorIds.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
	return {
		...value,
		connectorIds: ids
	};
}
/**
* True when the shared lease record already knows this device id, i.e. another
* Agents-Anywhere host has the same Connector identity on this machine. The
* actual liveness oracle is the Connector's own OS lease (`connector_already_running`),
* never a pid probe — a Windows pid can be reused.
*/
function runtimeMentionsConnector(runtime, connectorId) {
	return runtime !== null && connectorId.length > 0 && runtime.connectorIds.includes(connectorId);
}
function isMissing(error) {
	return typeof error === "object" && error !== null && error.code === "ENOENT";
}
//#endregion
//#region src/server/connector-reuse.ts
/**
* Reuse-first Connector discovery (design §5.1 step 2; user decision: when a
* usable Connector already runs on this machine, **reuse it and never spawn a
* second one**).
*
* The Python Connector owns exactly ONE per-user record — the OS-lease mutex at
* `<home>/.agents-anywhere/connector-runtime.json` — and every launch source
* (CLI, AA Desktop, DSH bridge, this plugin) shares it (DSH README:164, contract
* local-machine/2.0). Desktop and DSH do **not** write a different file, so a
* single read of that record covers all three sources named in the brief.
*
* A live owner pid that already lists our device id is the reuse signal; a live
* pid bound to another device is `occupied` (the machine-wide lease cannot be
* taken twice); no live owner is `none`. The pid probe is deliberately a
* heuristic — a Windows pid can be recycled — so the Connector's own TCP-port
* lease stays the authoritative oracle: `occupied` still falls through to a
* spawn attempt whose `connector_already_running` reply is treated as success.
*/
/** Conservative liveness probe: an unknown result (`EPERM`) counts as alive. */
function defaultPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/**
* The Connector's own mutex path may not be relocated, so the canonical file is
* always checked; the plugin's override-derived path is checked too, because a
* self-hosted base directory relocates the whole `~/.agents-anywhere` tree.
*/
function candidateRuntimePaths(env = process.env) {
	const canonical = join(homedir(), DATA_DIR_NAME, CONNECTOR_RUNTIME_FILE);
	const derived = connectorRuntimePath(env);
	return derived === canonical ? [canonical] : [derived, canonical];
}
function liveOwner(record, alive) {
	const owner = record?.runtime;
	if (owner === void 0) return null;
	const candidates = [];
	if (typeof owner.childPid === "number" && owner.childPid > 0) candidates.push(owner.childPid);
	if (typeof owner.pid === "number" && owner.pid > 0) candidates.push(owner.pid);
	for (const pid of candidates) if (alive(pid)) return {
		kind: typeof owner.kind === "string" && owner.kind.length > 0 ? owner.kind : null,
		pid
	};
	return null;
}
async function probeExistingConnector(options) {
	const alive = options.pidAlive ?? defaultPidAlive;
	const paths = options.runtimePaths ?? candidateRuntimePaths(options.env);
	for (const path of paths) {
		const record = await readConnectorRuntimeAt(path);
		const live = liveOwner(record, alive);
		if (live === null || record === null) continue;
		if (record.connectorIds.includes(options.connectorId)) return {
			decision: "reuse",
			reason: `本机记录已绑定本设备且进程存活（kind=${live.kind ?? "unknown"}, pid=${live.pid}）`,
			kind: live.kind,
			pid: live.pid
		};
		return {
			decision: "occupied",
			reason: `本机已有存活的 Connector（kind=${live.kind ?? "unknown"}, pid=${live.pid}）但未绑定本设备`,
			kind: live.kind,
			pid: live.pid
		};
	}
	return {
		decision: "none",
		reason: "本机未发现存活的 Connector",
		kind: null,
		pid: null
	};
}
//#endregion
//#region src/server/connector-ownership.ts
/**
* Our own Connector ownership record — the half of the reuse probe the plugin
* did not have.
*
* `connector-reuse.ts` reads the *shared* `~/.agents-anywhere/connector-runtime.json`
* lease, which names whichever host claimed the machine-wide Connector (AA
* Desktop, the DSH bridge, another OpenCode). A Connector **this plugin** spawned
* is invisible in that record whenever the lease belongs to a different device —
* the real-machine case that produced the duplicate `uv` trees: that record read
* `connectorIds: ['conn_q4KVr_R8ywQn4w']`, `kind: 'desktop-workbench'`,
* `serverUrl: 'https://web.agents-anywhere.com'`, while our device is
* `conn_958d7523…` on `http://127.0.0.1:8000`. Every `resume()` therefore decided
* `occupied` and spawned yet another Connector for the same device id.
*
* This module owns the record only we write — `<plugin data dir>/connector/
* owner.json` — so a later `setup()` (hot reload, a second location, a fresh
* process) can *adopt* the child that is already running instead of spawning a
* second one, and an explicit stop can name exactly the pid we started.
*
* Two independent fields, both optional:
*   `child`   — the pid of the Connector tree we launched.
*   `blocked` — we tried to spawn and the machine-wide lease is held by another
*               host, so every further spawn attempt is known-doomed until that
*               pid goes away (`connector/core/control.py:112` refuses `start`
*               with `connector_already_running` in exactly this state).
*
* Nothing in this file signals a process; killing stays in
* `connector-supervisor.ts`.
*/
const OWNERSHIP_FILE = "owner.json";
function ownershipPath(dataDir) {
	return join(dataDir, OWNERSHIP_FILE);
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveInt(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
function readChild(value) {
	if (!isRecord(value)) return null;
	const pid = positiveInt(value["pid"]);
	const connectorId = value["connectorId"];
	if (pid === null || typeof connectorId !== "string" || connectorId.length === 0) return null;
	return {
		pid,
		connectorId,
		childStatePath: typeof value["childStatePath"] === "string" ? value["childStatePath"] : "",
		spawnedAt: typeof value["spawnedAt"] === "number" ? value["spawnedAt"] : 0
	};
}
function readBlocked(value) {
	if (!isRecord(value)) return null;
	return {
		kind: typeof value["kind"] === "string" && value["kind"].length > 0 ? value["kind"] : null,
		pid: positiveInt(value["pid"]),
		connectorId: typeof value["connectorId"] === "string" ? value["connectorId"] : "",
		at: typeof value["at"] === "number" ? value["at"] : 0
	};
}
/**
* Read our record. Fail-soft by design: this file only ever *optimises* a
* decision, so a missing/corrupt/half-written file degrades to "no record"
* instead of breaking a connect attempt.
*/
async function readOwnership(dataDir) {
	try {
		const raw = await readJsonFile(ownershipPath(dataDir));
		if (raw === null) return {
			child: null,
			blocked: null
		};
		return {
			child: readChild(raw["child"]),
			blocked: readBlocked(raw["blocked"])
		};
	} catch {
		return {
			child: null,
			blocked: null
		};
	}
}
async function mergeState(dataDir, apply) {
	const next = apply(await readOwnership(dataDir));
	await writeJsonAtomic(ownershipPath(dataDir), next);
}
/** Record the child we just launched (keeps any `blocked` marker). */
async function setOwnChild(dataDir, child) {
	await mergeState(dataDir, (state) => ({
		...state,
		child
	}));
}
/** Drop the child record; when `pid` is given, only that pid's record is dropped. */
async function clearOwnChild(dataDir, pid) {
	await mergeState(dataDir, (state) => {
		if (pid !== void 0 && state.child !== null && state.child.pid !== pid) return state;
		return {
			...state,
			child: null
		};
	});
}
/** Remember that the machine-wide lease is held by another host. */
async function setBlocked(dataDir, blocked) {
	await mergeState(dataDir, (state) => ({
		...state,
		blocked
	}));
}
/**
* Is a Connector *we* started already running for this device? This is the
* reuse signal that survives a hot reload, a second `setup()` and a process
* restart — the shared lease record cannot answer it (see the module header).
*/
async function probeOwnConnector(options) {
	const alive = options.pidAlive ?? defaultPidAlive;
	const { child } = await readOwnership(options.dataDir);
	if (child === null) return {
		own: false,
		pid: null,
		reason: "未发现本插件自己启动的 Connector 记录"
	};
	if (child.connectorId !== options.connectorId) return {
		own: false,
		pid: child.pid,
		reason: `本插件的 Connector 记录属于别的设备（${child.connectorId}）`
	};
	if (!alive(child.pid)) return {
		own: false,
		pid: child.pid,
		reason: `本插件启动的 Connector（pid=${child.pid}）已退出`
	};
	return {
		own: true,
		pid: child.pid,
		reason: `本插件启动的 Connector 仍在运行（pid=${child.pid}）`
	};
}
/**
* Is a spawn attempt known-doomed because another host holds the machine-wide
* Connector lease? Only a *live* holder blocks: as soon as its pid is gone the
* marker is stale and the caller may try again.
*/
async function probeForeignBlock(options) {
	const alive = options.pidAlive ?? defaultPidAlive;
	const { blocked } = await readOwnership(options.dataDir);
	const idle = {
		blocked: false,
		kind: null,
		pid: null,
		reason: "没有其它 Connector 占用本机租约"
	};
	if (blocked === null) return idle;
	const kind = blocked.kind;
	if (blocked.pid === null) return {
		...idle,
		kind,
		reason: "占用记录缺少 pid，无法确认，按可重试处理"
	};
	if (!alive(blocked.pid)) return {
		...idle,
		kind,
		pid: blocked.pid,
		reason: `上次占用的 Connector（pid=${blocked.pid}）已退出，可以重试`
	};
	return {
		blocked: true,
		kind,
		pid: blocked.pid,
		reason: `本机 Connector 租约仍被占用（kind=${kind ?? "unknown"}, pid=${blocked.pid}）`
	};
}
//#endregion
//#region src/server/connector-supervisor.ts
/**
* Connector supervisor — spawn the Agents Anywhere Connector as a child process
* and keep it alive (design §5.1 step 6, §2.6 recovery).
*
* The Connector is the only outbound party: it dials the AA server **and** every
* local bridge endpoint. The plugin never calls into it over the network; it owns
* the process and speaks NDJSON JSON-RPC 2.0 over stdio, mirroring
* `dsh-bridge-next/src/host/connector/process.ts` (methods `connector.getState` /
* `connector.start` / `connector.stop`, notification `connector/state`).
*
* Zero runtime dependencies: `uv` is located on `PATH` at runtime. The Connector
* source is either the copy bundled into this package at build time
* (`lib/connector/` — the only form a Git-spec install can carry, because the
* installer ships just this subdirectory and never runs a build; dist report 03)
* or, in a development checkout, the sibling `../connector/`. Neither is an npm
* dependency.
*
* Everything that touches the machine (spawn, uv resolution, retry scheduling,
* the package directory) is injectable so the whole lifecycle is testable
* against a **fake connector script** — tests must never spawn the real
* Connector, and this module never does so on its own either.
*/
const CONNECTOR_SOURCE_ENV$1 = "AGENT_CONNECTOR_SOURCE";
/**
* Where `scripts/bundle-connector.ts` copies the Connector at build time. This is
* the first default source: a package (Git-spec / npm) install has no sibling
* checkout, so this copy is what makes it self-contained.
*/
const BUNDLED_CONNECTOR_SUBDIR = join("lib", "connector");
/** Wall-clock bound for the first RPC: `uv` may still be installing wheels. */
const DEFAULT_FIRST_REQUEST_TIMEOUT_MS = 36e5;
const DEFAULT_REQUEST_TIMEOUT_MS = 15e3;
const DEFAULT_RECONNECT_DELAY_MS = 5e3;
const DEFAULT_MAX_RESTART_ATTEMPTS = 5;
const MAX_FRAME_BYTES = 1048576;
/** The Connector source could not be located (actionable, never silent). */
var ConnectorSourceError = class extends Error {
	code = "connector_source_missing";
};
/** `uv` could not be located (actionable, never silent). */
var UvUnavailableError = class extends Error {
	code = "uv_unavailable";
};
/** Another Connector already holds the machine-wide OS lease. */
var ConnectorOwnershipError = class extends Error {
	code = "connector_already_running";
	/** Who holds the lease (from the Connector's RPC error), so a caller can record it. */
	owner;
	constructor(message, owner = {
		kind: null,
		pid: null
	}) {
		super(message);
		this.owner = owner;
	}
};
/** The Connector rejected our stored device credential. */
var ConnectorCredentialError = class extends Error {
	code = "connector_auth_failed";
};
var ConnectorSupervisor = class {
	#logger;
	#env;
	#sourceDir;
	#uvPath;
	#packageDir;
	#launch;
	#resolveUvFn;
	#firstRequestTimeoutMs;
	#requestTimeoutMs;
	#reconnectDelayMs;
	#maxRestartAttempts;
	#scheduleRetry;
	#onState;
	#onRuntimeError;
	#onChild;
	#child = null;
	/** In-flight spawn, so concurrent `start()` calls share exactly one launch. */
	#starting = null;
	#nextId = 0;
	#pending = /* @__PURE__ */ new Map();
	#buffer = "";
	#failure = null;
	/** The Connector's own `lastError` (why it is not running), surfaced to the user. */
	#remoteError = null;
	#state = {
		running: false,
		authFailed: false
	};
	#stopping = null;
	#lastConfig = null;
	#attempt = 0;
	#cancelRetry = null;
	#desired = false;
	#closed = /* @__PURE__ */ new WeakSet();
	constructor(options = {}) {
		this.#logger = options.logger ?? createLogger("connector-supervisor");
		this.#env = options.env ?? process.env;
		this.#sourceDir = options.sourceDir;
		this.#uvPath = options.uvPath;
		this.#packageDir = options.packageDir ?? defaultPackageDir();
		this.#launch = options.spawn ?? spawn;
		this.#resolveUvFn = options.resolveUv ?? ((command) => resolveUvOnPath(command, this.#env));
		this.#firstRequestTimeoutMs = options.firstRequestTimeoutMs ?? DEFAULT_FIRST_REQUEST_TIMEOUT_MS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
		this.#maxRestartAttempts = options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS;
		this.#scheduleRetry = options.scheduleRetry ?? ((callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			timer.unref?.();
			return () => clearTimeout(timer);
		});
		this.#onState = options.onState;
		this.#onRuntimeError = options.onRuntimeError;
		this.#onChild = options.onChild;
	}
	get state() {
		return { ...this.#state };
	}
	/**
	* Late-bound state listener, so the plugin's credential-health reporter can
	* attach to an already-constructed supervisor (including one a caller
	* injected). Replaces any listener passed via `options.onState`.
	*/
	attachStateListener(listener) {
		this.#onState = listener;
	}
	get running() {
		return this.#child !== null && this.#state.running && !this.#state.authFailed;
	}
	get lastError() {
		return this.#failure?.message ?? this.#remoteError;
	}
	get attempts() {
		return this.#attempt;
	}
	/**
	* Resolution order (design §5; dist report 03):
	*   ① explicit `sourceDir` option or `AGENT_CONNECTOR_SOURCE` — an override
	*      always wins, so an operator can point at any checkout;
	*   ② the copy bundled into this package (`lib/connector/`) — the only source
	*      that survives a Git-spec install;
	*   ③ the development sibling `../connector/`;
	*   ④ an actionable error — never a silent skip.
	*/
	resolveSourceDir() {
		return this.sourceCandidates()[0];
	}
	/** Candidate paths checked by `prepare()`, in the order they were resolved. */
	sourceCandidates() {
		const explicit = this.#sourceDir ?? nonEmpty$1(this.#env["AGENT_CONNECTOR_SOURCE"]);
		if (explicit !== void 0) return [explicit];
		return [join(this.#packageDir, BUNDLED_CONNECTOR_SUBDIR), join(dirname(this.#packageDir), "connector")];
	}
	async resolveUv() {
		const command = this.#uvPath ?? nonEmpty$1(this.#env["AGENT_CONNECTOR_UV"]) ?? "uv";
		return await this.#resolveUvFn(command);
	}
	/**
	* Verify both prerequisites before spawning. Throws an actionable error naming
	* the exact remedy — the alternative (a silent no-op) is what makes a broken
	* install invisible.
	*/
	async prepare() {
		const candidates = this.sourceCandidates();
		let found = false;
		for (const candidate of candidates) if (await isConnectorSource(candidate)) {
			found = true;
			break;
		}
		if (!found) throw new ConnectorSourceError(`未找到 Connector 源码。本插件包内应自带 ${BUNDLED_CONNECTOR_SUBDIR}（随包分发，安装包损坏或版本不对时会缺失）；也可设置 ${CONNECTOR_SOURCE_ENV$1} 指向包含 pyproject.toml 与 connector/cli.py 的目录，或把本仓库的 connector/ 放在插件包同级。已尝试：${candidates.join(", ")}。`);
		if (await this.resolveUv() === null) throw new UvUnavailableError("未找到 uv 可执行文件。请安装 uv（https://docs.astral.sh/uv/），或设置 AGENT_CONNECTOR_UV 指向 uv 的绝对路径。");
	}
	async start(config) {
		this.#attempt = 0;
		this.#desired = true;
		this.#lastConfig = config;
		this.#starting ??= this.#spawnChild(config).finally(() => {
			this.#starting = null;
		});
		await this.#starting;
	}
	async #spawnChild(config) {
		if (this.#stopping !== null) await this.#stopping;
		if (this.running) return;
		if (this.#child !== null) await this.#stopChild();
		this.#cancelRetry?.();
		this.#cancelRetry = null;
		const sourceDir = await firstSource(this.sourceCandidates());
		if (sourceDir === null) throw new ConnectorSourceError(`未找到 Connector 源码。请设置 ${CONNECTOR_SOURCE_ENV$1}，或安装自带 ${BUNDLED_CONNECTOR_SUBDIR} 的正式插件包（开发期可用同级 connector/）。`);
		const uv = await this.resolveUv();
		if (uv === null) throw new UvUnavailableError("未找到 uv 可执行文件；请安装 uv 或设置 AGENT_CONNECTOR_UV。");
		await mkdir(config.dataDir, {
			recursive: true,
			mode: 448
		});
		const configPath = join(config.dataDir, "connector.json");
		await writeJsonAtomic(configPath, {
			serverUrl: config.apiBaseUrl.replace(/\/+$/, ""),
			connectorId: config.connectorId,
			connectorToken: config.connectorToken,
			statePath: join(config.dataDir, `${config.connectorId}.sqlite3`),
			heartbeatSeconds: config.heartbeatSeconds ?? 20,
			reconnectSeconds: config.reconnectSeconds ?? 3,
			syncExistingOnConnect: true,
			syncIntervalSeconds: config.syncIntervalSeconds ?? 30
		});
		this.#failure = null;
		this.#buffer = "";
		this.#setState({
			running: false,
			authFailed: false
		});
		const child = this.#launch(uv, [
			"run",
			"--directory",
			sourceDir,
			"anywhere-cli",
			"rpc",
			"--config",
			configPath
		], {
			cwd: sourceDir,
			windowsHide: true,
			detached: process.platform !== "win32",
			env: connectorEnv(this.#env, config.dataDir)
		});
		this.#child = child;
		const childPid = typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
		if (childPid !== null) {
			await setOwnChild(config.dataDir, {
				pid: childPid,
				connectorId: config.connectorId,
				childStatePath: join(config.dataDir, `${config.connectorId}.sqlite3`),
				spawnedAt: Date.now()
			}).catch(() => void 0);
			try {
				this.#onChild?.({
					pid: childPid,
					config
				});
			} catch {}
		}
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (this.#child === child) this.#receive(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			this.#logger.debug("connector stderr", { bytes: chunk.length });
			this.#recordStderr(config.dataDir, chunk, config.connectorToken);
		});
		child.stdin.on("error", () => {
			if (this.#child === child) this.#fail(/* @__PURE__ */ new Error("Connector 输入连接已关闭。"));
		});
		child.on("error", () => {
			if (this.#child === child) this.#fail(/* @__PURE__ */ new Error("Connector 进程启动失败，请检查 uv 与源码运行环境。"));
		});
		child.on("close", (code) => {
			this.#closed.add(child);
			if (childPid !== null) clearOwnChild(config.dataDir, childPid).catch(() => void 0);
			if (this.#child === child) {
				this.#child = null;
				this.#fail(/* @__PURE__ */ new Error(`Connector 已退出（${code ?? "signal"}）。`));
				this.#scheduleReconnect();
			}
		});
		try {
			await this.#call("connector.getState", this.#firstRequestTimeoutMs);
			await this.#call("connector.start");
		} catch (error) {
			this.#desired = false;
			const pendingRetry = this.#cancelRetry;
			this.#cancelRetry = null;
			pendingRetry?.();
			await this.#stopChild();
			throw error;
		}
	}
	/** Healthy only when the Connector reports `running` and not auth-failed. */
	async assertHealthy() {
		if (this.#state.authFailed) throw new ConnectorCredentialError("本机设备连接已失效，请在插件中重新登录。");
		if (this.#failure !== null) throw this.#failure;
		const state = await this.#call("connector.getState");
		this.#applyState(state);
		if (this.#state.authFailed) throw new ConnectorCredentialError("本机设备连接已失效，请在插件中重新登录。");
		if (!this.#state.running) throw new Error("Connector 尚未运行，请重试。");
	}
	stop() {
		if (this.#stopping !== null) return this.#stopping;
		this.#desired = false;
		this.#attempt = 0;
		this.#cancelRetry?.();
		this.#cancelRetry = null;
		this.#stopping = this.#stopChild().finally(() => {
			this.#failure = null;
			this.#stopping = null;
		});
		return this.#stopping;
	}
	async #stopChild() {
		const child = this.#child;
		if (child === null) return;
		try {
			await this.#call("connector.stop", 3e3);
		} catch {}
		const ended = new Promise((resolve) => {
			if (this.#closed.has(child) || child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("close", () => resolve());
		});
		try {
			child.stdin.end();
		} catch {}
		await Promise.race([ended, delay$1(1e3)]);
		if (!this.#closed.has(child)) this.#terminate(child, false);
		await Promise.race([ended, delay$1(3e3)]);
		if (!this.#closed.has(child)) this.#terminate(child, true);
		await Promise.race([ended, delay$1(5e3)]);
		if (!this.#closed.has(child) && child.exitCode === null && child.signalCode === null) this.#logger.warn("connector did not report exit after a forced stop");
		if (this.#child === child) this.#child = null;
		const childPid = typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
		if (childPid !== null && this.#lastConfig !== null) await clearOwnChild(this.#lastConfig.dataDir, childPid).catch(() => void 0);
	}
	/** Persist stderr (token redacted) so a failure leaves a user-readable trace. */
	async #recordStderr(dataDir, chunk, token) {
		try {
			const text = token.length > 0 ? chunk.split(token).join("[redacted]") : chunk;
			await appendFile(join(dataDir, "connector.log"), text, { mode: 384 });
		} catch {}
	}
	#terminate(child, force) {
		if (typeof child.pid !== "number" || child.pid <= 0) return;
		if (process.platform === "win32") {
			try {
				const killer = spawn("taskkill", windowsTreeKillArgs(child.pid, force), {
					windowsHide: true,
					stdio: "ignore"
				});
				killer.on("error", () => directKill(child, force));
				killer.unref();
				return;
			} catch {
				directKill(child, force);
			}
			return;
		}
		try {
			process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
			return;
		} catch {}
		directKill(child, force);
	}
	#scheduleReconnect() {
		const config = this.#lastConfig;
		if (!this.#desired || config === null || this.#stopping !== null) return;
		this.#attempt += 1;
		const retryable = this.#attempt <= this.#maxRestartAttempts;
		this.#onRuntimeError?.({
			code: "runtime_error",
			retryable,
			attempt: this.#attempt
		});
		this.#logger.warn("connector exited; scheduling a reconnect", {
			attempt: this.#attempt,
			retryable
		});
		if (!retryable) return;
		this.#cancelRetry = this.#scheduleRetry(() => {
			this.#cancelRetry = null;
			this.#spawnChild(config).catch((error) => {
				this.#logger.warn("connector reconnect failed", { error: error instanceof Error ? error.name : typeof error });
				this.#scheduleReconnect();
			});
		}, this.#reconnectDelayMs);
	}
	#call(method, timeoutMs = this.#requestTimeoutMs) {
		const child = this.#child;
		if (child === null || this.#failure !== null) return Promise.reject(this.#failure ?? /* @__PURE__ */ new Error("Connector 未启动。"));
		const id = this.#nextId += 1;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(/* @__PURE__ */ new Error("Connector 响应超时，请检查 Python 依赖安装与网络连接。"));
			}, timeoutMs);
			timer.unref?.();
			this.#pending.set(id, {
				resolve,
				reject,
				timer
			});
			child.stdin.write(`${JSON.stringify({
				jsonrpc: "2.0",
				id,
				method
			})}\n`);
		});
	}
	#receive(chunk) {
		this.#buffer += chunk;
		if (this.#buffer.length > MAX_FRAME_BYTES) {
			this.#fail(/* @__PURE__ */ new Error("Connector 返回了过大的消息。"));
			return;
		}
		let newline;
		while ((newline = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim().length === 0) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				this.#fail(/* @__PURE__ */ new Error("Connector 返回了无效的协议消息。"));
				return;
			}
			if (frame.method === "connector/state" && frame.id === void 0) {
				this.#applyState(frame.params);
				continue;
			}
			if (typeof frame.id !== "number") continue;
			const pending = this.#pending.get(frame.id);
			if (pending === void 0) continue;
			this.#pending.delete(frame.id);
			clearTimeout(pending.timer);
			if (frame.error) pending.reject(mapRpcError(frame.error));
			else pending.resolve(frame.result);
		}
	}
	#fail(error) {
		this.#failure = error;
		this.#setState({
			...this.#state,
			running: false
		});
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
	/** Only the two booleans feed the lifecycle state; the failure reason is logged. */
	#applyState(value) {
		if (value === null || typeof value !== "object") return;
		const state = value;
		if (typeof state.running !== "boolean" || typeof state.authFailed !== "boolean") return;
		const remoteError = typeof state.lastError === "string" && state.lastError.length > 0 ? state.lastError : null;
		if (remoteError !== this.#remoteError) {
			this.#remoteError = remoteError;
			if (remoteError !== null) this.#logger.warn("Connector 报告了失败原因", {
				status: typeof state.status === "string" ? state.status : void 0,
				error: remoteError
			});
		}
		this.#setState({
			running: state.running,
			authFailed: state.authFailed
		});
	}
	#setState(next) {
		if (next.running === this.#state.running && next.authFailed === this.#state.authFailed) return;
		this.#state = next;
		try {
			this.#onState?.({ ...next });
		} catch {}
	}
};
function mapRpcError(error) {
	const record = error ?? {};
	const reason = typeof record.data?.reason === "string" ? record.data.reason : null;
	if (record.code === -32009 && reason === "connector_already_running") {
		const raw = record.data?.owner;
		const ownerRecord = raw !== null && typeof raw === "object" ? raw : {};
		return new ConnectorOwnershipError("本机已有另一个 Connector 在运行，正在复用它的连接。", {
			kind: typeof ownerRecord.kind === "string" && ownerRecord.kind.length > 0 ? ownerRecord.kind : null,
			pid: typeof ownerRecord.pid === "number" && Number.isInteger(ownerRecord.pid) && ownerRecord.pid > 0 ? ownerRecord.pid : null
		});
	}
	return /* @__PURE__ */ new Error("Connector 操作失败，请检查本机运行环境后重试。");
}
/** Env handed to the child: never a credential on the command line, never an npm dep. */
function connectorEnv(env, dataDir) {
	return {
		...env,
		AA_CONNECTOR_OWNER_KIND: "opencode-plugin",
		AGENT_CONNECTOR_DATA_DIR: dataDir,
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONUNBUFFERED: "1",
		UV_HTTP_TIMEOUT: env["UV_HTTP_TIMEOUT"] ?? "60"
	};
}
/**
* `taskkill` args that terminate an entire Windows process tree: `/T` walks from
* the given pid to its children (uv → python), `/F` forces when the graceful
* signal was ignored. Exported so the tree-kill wiring is unit-testable without
* spawning a real Connector.
*/
function windowsTreeKillArgs(pid, force) {
	return force ? [
		"/pid",
		String(pid),
		"/T",
		"/F"
	] : [
		"/pid",
		String(pid),
		"/T"
	];
}
/** Signal only the direct child; already-gone is not an error. */
function directKill(child, force) {
	try {
		child.kill(force ? "SIGKILL" : "SIGTERM");
	} catch {}
}
/**
* Terminate a whole process tree by pid, cross-platform: a POSIX process group
* kill when the leader owns one, `taskkill /T` on Windows, a direct signal as
* the last resort. Used by the supervisor's own teardown and by the explicit
* cleanup path (which never owns a `ChildProcess` handle).
*/
function killProcessTree(pid, force = true) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", windowsTreeKillArgs(pid, force), {
				windowsHide: true,
				stdio: "ignore"
			}).unref();
		} catch {}
		return;
	}
	try {
		process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
		return;
	} catch {}
	try {
		process.kill(pid, force ? "SIGKILL" : "SIGTERM");
	} catch {}
}
async function isConnectorSource(dir) {
	return await exists(join(dir, "pyproject.toml")) && await exists(join(dir, "connector", "cli.py"));
}
async function firstSource(candidates) {
	for (const candidate of candidates) if (await isConnectorSource(candidate)) return candidate;
	return null;
}
async function exists(path) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}
/** Locate `uv` on `PATH` plus the usual per-user install dirs. */
async function resolveUvOnPath(command, env = process.env) {
	if (isAbsolute(command)) return await isExecutable(command) ? command : null;
	const home = env["USERPROFILE"] ?? env["HOME"] ?? "";
	const entries = [...(env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter((entry) => entry.length > 0), ...home.length > 0 ? [
		join(home, ".local", "bin"),
		join(home, ".cargo", "bin"),
		join(home, "AppData", "Local", "Programs", "uv")
	] : []];
	const names = process.platform === "win32" && !command.endsWith(".exe") ? [command, `${command}.exe`] : [command];
	for (const entry of new Set(entries)) for (const name of names) {
		const candidate = join(entry, name);
		if (await isExecutable(candidate)) return candidate;
	}
	return null;
}
async function isExecutable(path) {
	try {
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/** Walk up from this module to the package root (handles `src/` and `lib/`). */
function defaultPackageDir() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 4; depth += 1) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirname(fileURLToPath(import.meta.url));
}
function nonEmpty$1(value) {
	return value !== void 0 && value.trim().length > 0 ? value.trim() : void 0;
}
function delay$1(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}
//#endregion
//#region src/server/cleanup.ts
/**
* Explicit uninstall / cleanup path (audit M3).
*
* The plugin owns no CLI and the TUI entry's load form is unproven (A10), so the
* one reliably reachable switch is an environment flag honoured at plugin
* startup: `AGENT_AA_CLEANUP=1`. It stops a Connector this plugin owns (whole
* process tree), then deletes this plugin's own data directory
* (`<base>/opencode-plugin`): settings, the account token, the device bindings,
* the in-flight OAuth record, and the Connector's `connector.json` — which
* carries the device token in plaintext — plus its sqlite state. It also removes
* the `opencode-bridge/` endpoint directory this plugin published.
*
* It deliberately does NOT delete the machine-wide `connector-runtime.json`
* (shared with AA Desktop / the CLI, per the local-machine/2.0 contract) nor the
* installed plugin package under `~/.cache/opencode/packages/…`. Deleting those
* from inside a running plugin would either corrupt another product's state or
* delete the running code; the README's residue list carries the manual steps.
*
* Nothing here ever logs a token: the result is booleans, paths and pids only.
*/
const CLEANUP_ENV = "AGENT_AA_CLEANUP";
function cleanupRequested(env = process.env) {
	const raw = env[CLEANUP_ENV]?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}
/** Device ids this plugin registered, read from its own binding files. */
async function ownedConnectorIds(pluginDir) {
	const dir = join(pluginDir, BINDINGS_DIR);
	let entries;
	try {
		entries = await promises.readdir(dir, {
			recursive: true,
			encoding: "utf8"
		});
	} catch {
		return [];
	}
	const ids = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const id = (await readJsonFile(join(dir, entry)).catch(() => null))?.["connectorId"];
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}
async function runCleanup(options = {}) {
	const env = options.env ?? process.env;
	const logger = options.logger ?? createLogger("cleanup");
	const pluginDir = pluginDataDir(env);
	const bridgeDir = dirname(endpointDirectory(env));
	let stoppedConnectorPid = null;
	const owned = await ownedConnectorIds(pluginDir);
	if (owned.length > 0) {
		const record = await readConnectorRuntime(env);
		const owner = record?.runtime;
		const pid = typeof owner?.childPid === "number" && owner.childPid > 0 ? owner.childPid : typeof owner?.pid === "number" && owner.pid > 0 ? owner.pid : null;
		if (record !== null && pid !== null && defaultPidAlive(pid) && record.connectorIds.some((id) => owned.includes(id))) {
			await (options.stopProcess ?? ((target) => killProcessTree(target, true)))(pid);
			stoppedConnectorPid = pid;
			logger.info("已停止本插件启动的 Connector", { pid });
		}
	}
	return {
		pluginDataDir: pluginDir,
		bridgeDir,
		removedPluginData: await removeTree(pluginDir),
		removedBridgeDir: await removeTree(bridgeDir),
		stoppedConnectorPid,
		notes: ["未删除机器级 connector-runtime.json（与 AA Desktop / CLI 共用），如需清理请手动删除 ~/.agents-anywhere/connector-runtime.json", "未删除已安装的插件包缓存（~/.cache/opencode/packages/<spec>/），请在 OpenCode 卸载插件后手动删除"]
	};
}
/** Remove a directory tree; `false` when it did not exist. */
async function removeTree(path) {
	try {
		await promises.access(path);
	} catch {
		return false;
	}
	await promises.rm(path, {
		recursive: true,
		force: true
	});
	return true;
}
//#endregion
//#region src/shared/login-prompt.ts
const LOGIN_PROMPT_FILE = "login.json";
function loginPromptPath(dataDir) {
	return join(dataDir, LOGIN_PROMPT_FILE);
}
async function writeLoginPrompt(dataDir, prompt) {
	const path = loginPromptPath(dataDir);
	await writeJsonAtomic(path, prompt);
	return path;
}
/** `HH:MM`-precision local time — hand-formatted so a test never depends on a locale. */
function expiryText(epochMs) {
	const date = new Date(epochMs);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** The `logging_in` line for the browser flow — header, URL, where else to read it. */
function formatLoopbackPrompt(prompt, path) {
	return [
		"需要你点一次「授权」完成登录。请在浏览器打开以下地址（已尝试自动打开；未打开就复制这一行）：",
		`  ${prompt.authorizationUrl ?? "(授权地址缺失)"}`,
		sourceLine(path, prompt.expiresAt)
	].join("\n");
}
/** The `logging_in` line for the headless flow — URL, short code, where else to read it. */
function formatDevicePrompt(prompt, path) {
	return [
		`无头/远程环境：请在任意设备的浏览器打开 ${prompt.verificationUri ?? "(验证地址缺失)"}，并输入短码 ${prompt.userCode ?? "(短码缺失)"}`,
		`（直接打开、免手动输入的链接：${prompt.verificationUriComplete ?? "(缺失)"}）`,
		sourceLine(path, prompt.expiresAt)
	].join("\n");
}
/** The log line matching the record, so callers never re-branch on `kind`. */
function formatLoginPrompt(prompt, path) {
	return prompt.kind === "loopback" ? formatLoopbackPrompt(prompt, path) : formatDevicePrompt(prompt, path);
}
function sourceLine(path, expiresAt) {
	const validity = `有效期至 ${expiryText(expiresAt)}。`;
	return path === null ? `（登录信息文件不可用，请直接复制上面的地址/短码。）${validity}` : `同一份信息也在文件里，可直接打开复制：${path}。${validity}`;
}
//#endregion
//#region src/shared/oauth.ts
/**
* OAuth wire constants and the pure crypto/URL helpers shared by the loopback
* (design §5.1) and headless (design §5.2) flows.
*
* Kept dependency-free and side-effect-free so both the server plugin and the
* TUI plugin can use it and every branch is unit-testable without a socket.
*/
/** The built-in OAuth client the server registers for this plugin (P5). */
const OAUTH_CLIENT_ID = "agents-anywhere-opencode-plugin";
const OAUTH_SCOPE = "profile";
const OAUTH_RESPONSE_TYPE = "code";
/** RFC 8628 device-code grant type the server's `/oauth/device/token` requires. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** 32 random bytes, base64url — the OAuth `state` (design §5.1). */
function createState() {
	return randomBytes(32).toString("base64url");
}
/**
* PKCE S256: a 48-byte verifier (RFC 7636 allows 43–128 chars; base64url of 48
* bytes is 64) and its SHA-256 challenge.
*/
function createPkcePair() {
	const verifier = randomBytes(48).toString("base64url");
	return {
		verifier,
		challenge: s256Challenge(verifier),
		method: "S256"
	};
}
function s256Challenge(verifier) {
	return createHash("sha256").update(verifier).digest("base64url");
}
/**
* `${webOrigin}/#/plugin-oauth?...` exactly as design §5.1 spells it. Built with
* `URL` so encoding is never hand-rolled; the query lives in the **hash** the
* Web app reads.
*/
function buildAuthorizationUrl(input) {
	const url = new URL(`${trimSlash(input.webOrigin)}/`);
	url.hash = `/plugin-oauth?${new URLSearchParams({
		response_type: OAUTH_RESPONSE_TYPE,
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: input.redirectUri,
		code_challenge: input.codeChallenge,
		code_challenge_method: "S256",
		scope: OAUTH_SCOPE,
		state: input.state
	}).toString()}`;
	return url.href;
}
/** Loopback hosts: their locally-developed Web app listens on a different port. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"localhost",
	"127.0.0.1",
	"::1"
]);
/** A local self-hosted instance answers the API on this port… */
const LOCAL_SERVER_PORT = "8000";
/** …and serves the Web/OAuth app on this one (design §5.1 / Desktop parity). */
const LOCAL_WEB_PORT = "5174";
/** `URL#hostname` keeps IPv6 brackets, so compare with and without them. */
function isLoopbackHostname(hostname) {
	const host = hostname.trim().toLowerCase();
	return LOOPBACK_HOSTS.has(host) || host.startsWith("[") && LOOPBACK_HOSTS.has(host.slice(1, -1));
}
/**
* Scheme for a schemeless address. Loopback is plain HTTP — assuming HTTPS
* there is what made a self-hosted `127.0.0.1:8000` unreachable — everything
* else keeps the documented `https://` default.
*/
function assumedScheme(input) {
	const authority = input.split(/[/?#]/, 1)[0] ?? "";
	const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
	return isLoopbackHostname(hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : hostPort.split(":")[0] ?? "") ? "http" : "https";
}
/** Normalise a server origin for API calls: `scheme://host[:port]`, no path. */
function apiBaseUrl(value) {
	try {
		const input = value.trim();
		if (input.length === 0) return null;
		const url = new URL(input.includes("://") ? input : `${assumedScheme(input)}://${input}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username !== "" || url.password !== "") return null;
		if (url.search !== "" || url.hash !== "") return null;
		const path = url.pathname.replace(/\/+$/, "");
		if (path !== "" && path !== "/api/v2") return null;
		return url.origin;
	} catch {
		return null;
	}
}
function trimSlash(value) {
	return value.replace(/\/+$/, "");
}
/**
* The Web/OAuth origin for a server address (design §5.1, the same rule the
* Desktop app and DSH use). A remote server serves its Web app same-origin; a
* locally developed instance answers the API on `8000` but serves the Web app
* on `5174`, while any other local port is kept as written. Accepts the same
* shorthand as {@link apiBaseUrl} (missing scheme, trailing `/api/v2`).
*/
function webOrigin(serverUrl) {
	const base = apiBaseUrl(serverUrl);
	if (base === null) return null;
	const url = new URL(base);
	if (isLoopbackHostname(url.hostname) && url.port === LOCAL_SERVER_PORT) url.port = LOCAL_WEB_PORT;
	return url.origin;
}
//#endregion
//#region src/shared/plugin-options.ts
/**
* Plugin configuration (V2 `ctx.options`) — the settings surface that replaced
* "export an environment variable before you start OpenCode".
*
* OpenCode V2 hands a plugin its own config object as `ctx.options`
* (`{ "package": "…", "options": { … } }` in `opencode.json`), so the user can
* configure this plugin exactly where every other plugin is configured. The
* environment stays supported as an **override for advanced / headless use**
* (a shell profile, a service unit, CI), never as a requirement.
*
* Precedence, per setting: `options.*` > matching env var > built-in default.
* This module is a leaf — no file, socket or child process — so an unusable
* value comes back as `null`/the default instead of being guessed, and the
* caller (`server/index.ts`) decides what to log about it.
*/
/** Server address; the same name the Connector and the Docker images use. */
const SERVER_URL_ENV = "AGENT_SERVER_URL";
/**
* Advanced/headless: force one flow instead of letting the plugin pick.
* `device` (RFC 8628) or `loopback` (browser). Unset is the normal case.
*/
const LOGIN_MODE_ENV = "AGENT_AA_LOGIN";
/** Advanced/headless: turn the automatic login off (`0`/`false`/`off`) or on. */
const AUTO_LOGIN_ENV = "AGENT_AA_AUTO_LOGIN";
/**
* Connector source dir override. The literal is repeated here on purpose: this
* module is compiled into the TUI build too, and importing
* `server/connector-supervisor.ts` would drag `node:child_process` along.
* Keep in sync with `src/server/connector-supervisor.ts` (`CONNECTOR_SOURCE_ENV`).
*/
const CONNECTOR_SOURCE_ENV = "AGENT_CONNECTOR_SOURCE";
/**
* Advanced escape hatch (task B): reuse whatever Connector is already running
* even though its advertised runtime types do not include `opencode`. Default
* (`false`) is the safe direction: an unrecognised Connector is not reused.
* Keep in sync with `server/onboarding.ts` (which logs this name).
*/
const FORCE_REUSE_CONNECTOR_ENV = "AGENT_AA_FORCE_REUSE_CONNECTOR";
const TRUE_WORDS = /* @__PURE__ */ new Set([
	"1",
	"true",
	"yes",
	"on"
]);
const FALSE_WORDS = /* @__PURE__ */ new Set([
	"0",
	"false",
	"no",
	"off"
]);
/**
* Tolerant boolean: a real boolean, `1`/`0`, or the words a JSON/env author
* writes. Anything else is "no opinion" (`null`) rather than an error, so a
* typo in one setting cannot take the whole plugin down.
*/
function parseBooleanOption(value) {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	if (TRUE_WORDS.has(text)) return true;
	if (FALSE_WORDS.has(text)) return false;
	return null;
}
/** `device` / `loopback` only; anything else means "decide automatically". */
function parseLoginMode(value) {
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	return text === "device" || text === "loopback" ? text : null;
}
/**
* The options object, narrowed without trusting its shape. A host that hands
* back the whole `opencode.json` entry (`{ package, options }`) is unwrapped
* too, so both spellings configure the same plugin.
*/
function optionBag(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
	const nested = raw["options"];
	if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) return nested;
	return raw;
}
function resolvePluginOptions(raw, env = process.env) {
	const bag = optionBag(raw);
	const server = pick(apiBaseUrl(nonEmptyString(bag["serverUrl"]) ?? ""), apiBaseUrl(env["AGENT_SERVER_URL"] ?? ""), null);
	const autoLogin = pick(parseBooleanOption(bag["autoLogin"]), parseBooleanOption(env[AUTO_LOGIN_ENV]), true);
	const loginMode = pick(parseLoginMode(bag["loginMode"]), parseLoginMode(env[LOGIN_MODE_ENV]), null);
	const connectorSource = pick(nonEmptyString(bag["connectorSource"]), nonEmptyString(env[CONNECTOR_SOURCE_ENV]), null);
	const forceReuse = pick(parseBooleanOption(bag["forceReuseConnector"]), parseBooleanOption(env[FORCE_REUSE_CONNECTOR_ENV]), false);
	return {
		serverUrl: server.value,
		autoLogin: autoLogin.value,
		loginMode: loginMode.value,
		connectorSource: connectorSource.value,
		forceReuseConnector: forceReuse.value,
		source: {
			serverUrl: server.source,
			autoLogin: autoLogin.source,
			loginMode: loginMode.source,
			connectorSource: connectorSource.source,
			forceReuseConnector: forceReuse.source
		}
	};
}
/** Highest layer that has an opinion wins: options → env → default. */
function pick(fromOptions, fromEnv, fallback) {
	if (fromOptions !== null) return {
		value: fromOptions,
		source: "options"
	};
	if (fromEnv !== null) return {
		value: fromEnv,
		source: "env"
	};
	return {
		value: fallback,
		source: "default"
	};
}
function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
//#endregion
//#region src/shared/server-url.ts
/**
* Where this machine's server address comes from (defect ① — 「服务器地址没复用」).
*
* A machine that already runs the AA Desktop app *knows* its server: the shared
* `~/.agents-anywhere/connector-runtime.json` lease records
* `runtime.serverUrl`, and the Desktop app writes its own
* `%APPDATA%\Agents Anywhere\desktop-server.json`. The login flow used to look
* at the plugin config and `AGENT_SERVER_URL` only, so exactly that machine
* reported `not_configured` and the login could never even start.
*
* Resolution order — first hit wins, and **every step is logged** so
* "why THIS server?" is answerable from the log alone:
*
*   1. `options.serverUrl`                     opencode.json plugin config
*   2. `AGENT_SERVER_URL`                      advanced / headless override
*   3. `connector-runtime.json`                `runtime.serverUrl` (shared lease)
*   4. `desktop-server.json`                   Desktop's own config → `serverUrl`
*   5. `connector/desktop-binding.json`        Desktop device binding → `serverUrl`
*
* Field names are the ones the real files use (read on a live install, not
* guessed); a candidate whose file is missing, unreadable, malformed or whose
* field is absent/not a URL is skipped with a debug line — never fatal, never
* guessed.
*
* **Non-sensitive fields only.** The only value ever taken out of a file is a
* `serverUrl`-shaped string, read by dot-path. A token, a password or an
* account id sitting in the same document is never returned and never logged:
* a caller only sees `{ url, source, origin }`, where `origin` is a setting
* name or a file path. Values that fail URL normalisation are dropped, so a
* secret that happened to live under the `serverUrl` key cannot leak either.
*
* Leaf module (`node:fs` + `node:os`), no Onboarding import, so the TUI build
* uses the same resolution as the service plugin.
*/
/** The layer's name as it goes into a log line and into user-facing text. */
const SERVER_URL_SOURCE_LABEL = {
	options: "插件配置 options.serverUrl",
	env: `环境变量 ${SERVER_URL_ENV}`,
	"connector-runtime": "本机共享记录 connector-runtime.json 的 runtime.serverUrl",
	"desktop-server": "桌面端配置 desktop-server.json 的 serverUrl",
	"desktop-binding": "桌面端设备绑定 desktop-binding.json 的 serverUrl",
	none: "无"
};
/** Directory the AA Desktop app keeps its own config in, per OS convention. */
const DESKTOP_APP_DIR_NAME = "Agents Anywhere";
/**
* The Desktop config directory. Windows uses `%APPDATA%` (where the measured
* install writes `desktop-server.json`), macOS `Application Support`, Linux the
* XDG config dir. An unknown platform yields no directory rather than a guess.
*/
function desktopConfigDirs(env = process.env, platform$1 = platform()) {
	if (platform$1 === "win32") {
		const appData = nonEmpty(env["APPDATA"]);
		return appData === null ? [] : [join(appData, DESKTOP_APP_DIR_NAME)];
	}
	if (platform$1 === "darwin") return [join(homedir(), "Library", "Application Support", DESKTOP_APP_DIR_NAME)];
	if (platform$1 === "linux") {
		const xdg = nonEmpty(env["XDG_CONFIG_HOME"]);
		return [join(xdg ?? join(homedir(), ".config"), DESKTOP_APP_DIR_NAME)];
	}
	return [];
}
/** The default candidate list: the shared lease first, then the Desktop app. */
function defaultServerUrlFiles(env = process.env, platform$2 = platform()) {
	const files = [{
		path: connectorRuntimePath(env),
		source: "connector-runtime",
		field: "runtime.serverUrl"
	}];
	for (const dir of desktopConfigDirs(env, platform$2)) {
		files.push({
			path: join(dir, "desktop-server.json"),
			source: "desktop-server",
			field: "serverUrl"
		});
		files.push({
			path: join(dir, "connector", "desktop-binding.json"),
			source: "desktop-binding",
			field: "serverUrl"
		});
	}
	return files;
}
/**
* Resolve the server address, logging each layer it walks past and the one it
* stopped on. Never throws: an unreadable file is a skipped layer.
*/
async function locateServerUrl(input = {}) {
	const env = input.env ?? process.env;
	const logger = input.logger ?? createLogger("server-url");
	const read = input.readText ?? readTextFile;
	const fromOption = apiBaseUrl(input.optionUrl ?? "");
	if (fromOption !== null) return hit(logger, "options", fromOption, "options.serverUrl");
	logger.debug("服务器地址：插件配置 options.serverUrl 未提供可用地址，继续下一层", { source: "options" });
	const fromEnv = apiBaseUrl(env["AGENT_SERVER_URL"] ?? "");
	if (fromEnv !== null) return hit(logger, "env", fromEnv, `环境变量 ${SERVER_URL_ENV}`);
	logger.debug(`服务器地址：环境变量 ${SERVER_URL_ENV} 未提供可用地址，继续下一层`, { source: "env" });
	const files = input.files ?? defaultServerUrlFiles(env, input.platform ?? platform());
	for (const file of files) {
		const text = await read(file.path);
		const raw = text === null ? null : readServerUrlField(text, file.field);
		if (raw === null) {
			const why = text === null ? "文件不存在或不可读" : `缺少可用的 ${file.field} 字符串`;
			logger.debug(`服务器地址：${SERVER_URL_SOURCE_LABEL[file.source]} 无可用地址（${why}），继续下一层`, {
				source: file.source,
				path: file.path
			});
			continue;
		}
		const url = apiBaseUrl(raw);
		if (url === null) {
			logger.debug(`服务器地址：${file.path} 的 ${file.field} 不是可用地址，继续下一层`, {
				source: file.source,
				path: file.path
			});
			continue;
		}
		return hit(logger, file.source, url, `${file.path}（字段 ${file.field}）`);
	}
	logger.warn(`未找到服务器地址：插件配置、AGENT_SERVER_URL 与本机的 Connector / Desktop 记录都没有可用的 serverUrl。怎么设置：在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，或设置环境变量 ${SERVER_URL_ENV}；详见 opencode-plugin/README.md「账号接入（P4）」一节。`, { source: "none" });
	return {
		url: null,
		source: "none",
		origin: "none",
		fromFile: false
	};
}
/**
* Read one string field by dot-path. Anything else — a number, an object, a
* secret under another key, malformed JSON — is `null`, so only the single
* non-sensitive field named by the caller can ever leave this module.
*/
function readServerUrlField(text, field) {
	let document;
	try {
		document = JSON.parse(text);
	} catch {
		return null;
	}
	let cursor = document;
	for (const key of field.split(".")) {
		if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return null;
		cursor = cursor[key];
	}
	return typeof cursor === "string" ? nonEmpty(cursor) : null;
}
function hit(logger, source, url, origin) {
	logger.info(`服务器地址采用${SERVER_URL_SOURCE_LABEL[source]}：${url}`, {
		source,
		origin,
		serverUrl: url
	});
	return {
		url,
		source,
		origin,
		fromFile: source !== "options" && source !== "env"
	};
}
async function readTextFile(path) {
	try {
		return await promises.readFile(path, "utf8");
	} catch {
		return null;
	}
}
function nonEmpty(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
/** How long the listener stays up after consuming the code (so a replay gets 409). */
const SHUTDOWN_GRACE_MS = 6e4;
const CALLBACK_PATH = "/oauth/callback";
/**
* The "this flow never started" code. `auto-login` falls back to the device code
* on exactly this one: a denial or a timeout is a user decision, and answering it
* with a fresh short code would just be noise.
*/
const LOOPBACK_UNAVAILABLE_CODE = "unavailable";
var LoopbackFlowError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
var LoopbackOAuthFlow = class {
	#options;
	#pkce = createPkcePair();
	#state = createState();
	#server;
	#origin = "";
	#port = 0;
	#consumed = false;
	#settled = false;
	#timer;
	#shutdown;
	#deadline = 0;
	#logger;
	constructor(options) {
		this.#options = options;
		this.#logger = options.logger;
		this.#server = createServer$1((request, response) => {
			this.#handle(request, response);
		});
	}
	get redirectUri() {
		return `${this.#origin}${CALLBACK_PATH}`;
	}
	get state() {
		return this.#state;
	}
	get verifier() {
		return this.#pkce.verifier;
	}
	get codeChallenge() {
		return this.#pkce.challenge;
	}
	get port() {
		return this.#port;
	}
	get consumed() {
		return this.#consumed;
	}
	/** Bind loopback and return everything the caller needs to start the login. */
	async start() {
		await new Promise((resolve, reject) => {
			const onError = (error) => reject(error);
			this.#server.once("error", onError);
			this.#server.listen(0, "127.0.0.1", () => {
				this.#server.off("error", onError);
				resolve();
			});
		});
		const address = this.#server.address();
		this.#port = address.port;
		this.#origin = `http://127.0.0.1:${this.#port}`;
		const timeoutMs = this.#options.timeoutMs ?? 6e5;
		this.#deadline = Date.now() + timeoutMs;
		this.#timer = setTimeout(() => {
			this.#fail(new LoopbackFlowError("timeout", "the loopback login timed out"));
			this.close();
		}, timeoutMs);
		this.#timer.unref?.();
		this.#logger?.debug("loopback oauth listening", { port: this.#port });
		return {
			authorizationUrl: buildAuthorizationUrl({
				webOrigin: this.#options.webOrigin,
				redirectUri: this.redirectUri,
				state: this.#state,
				codeChallenge: this.#pkce.challenge
			}),
			redirectUri: this.redirectUri,
			port: this.#port,
			state: this.#state,
			codeChallenge: this.#pkce.challenge,
			deadline: this.#deadline
		};
	}
	/** Stop listening. Idempotent. */
	async close() {
		if (this.#timer !== void 0) clearTimeout(this.#timer);
		if (this.#shutdown !== void 0) clearTimeout(this.#shutdown);
		this.#timer = void 0;
		this.#shutdown = void 0;
		this.#server.closeAllConnections?.();
		if (!this.#server.listening) return;
		await new Promise((resolve) => this.#server.close(() => resolve()));
	}
	/**
	* After the code is consumed the listener keeps answering briefly: the brief
	* requires a **replayed** callback to receive `409`, which is only observable
	* while the listener is still up. It then shuts itself down so no code stays
	* reachable.
	*/
	#scheduleShutdown() {
		if (this.#shutdown !== void 0) return;
		this.#shutdown = setTimeout(() => {
			this.#shutdown = void 0;
			this.close();
		}, SHUTDOWN_GRACE_MS);
		this.#shutdown.unref?.();
	}
	/** Abort an in-flight flow (user cancelled / plugin disposed). */
	abort(reason) {
		this.#fail(new LoopbackFlowError("aborted", reason));
		this.close();
	}
	#fail(error) {
		if (this.#settled) return;
		this.#settled = true;
		try {
			this.#options.onFailed?.(error);
		} catch {}
	}
	#handle(request, response) {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Content-Type-Options", "nosniff");
		if (request.headers.host !== new URL(this.#origin).host) {
			response.writeHead(403).end();
			return;
		}
		if (request.method !== "GET") {
			response.writeHead(405, { Allow: "GET" }).end();
			return;
		}
		let url;
		try {
			url = new URL(request.url ?? "/", this.#origin);
		} catch {
			response.writeHead(400).end();
			return;
		}
		if (url.pathname !== "/oauth/callback") {
			response.writeHead(404).end();
			return;
		}
		const incoming = Buffer.from(url.searchParams.get("state") ?? "");
		const expected = Buffer.from(this.#state);
		if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid OAuth state");
			this.#logger?.warn("loopback oauth state mismatch; aborting the flow");
			this.#fail(new LoopbackFlowError("state_mismatch", "the callback state did not match"));
			this.close();
			return;
		}
		if (this.#consumed) {
			response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" }).end("OAuth callback already consumed");
			this.#logger?.warn("loopback oauth callback replayed");
			return;
		}
		const error = url.searchParams.get("error");
		const code = url.searchParams.get("code");
		if (error === null && (code === null || code.length === 0)) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing authorization code");
			return;
		}
		this.#consumed = true;
		if (error !== null) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(resultHtml(false, error));
			this.#fail(new LoopbackFlowError("denied", `authorization was not granted (${error})`));
			this.#scheduleShutdown();
			return;
		}
		if (code === null) {
			response.writeHead(400).end();
			return;
		}
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(resultHtml(true, null));
		if (this.#settled) return;
		this.#settled = true;
		if (this.#timer !== void 0) clearTimeout(this.#timer);
		this.#timer = void 0;
		this.#logger?.info("loopback oauth callback accepted");
		try {
			Promise.resolve(this.#options.onAuthorized?.(code, {
				verifier: this.#pkce.verifier,
				redirectUri: this.redirectUri
			})).catch(() => this.#logger?.warn("loopback oauth token exchange failed")).finally(() => {
				this.#scheduleShutdown();
			});
		} catch {
			this.#logger?.warn("loopback oauth token exchange failed");
			this.#scheduleShutdown();
		}
	}
};
const RESULT_TITLE = "登录 Agents Anywhere";
function resultHtml(ok, error) {
	const heading = ok ? "授权完成" : "授权未完成";
	const detail = ok ? "你可以关闭此页面，回到 OpenCode。" : `原因：${escapeHtml(error ?? "unknown")}`;
	return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${RESULT_TITLE}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;line-height:1.7">
<h1 style="font-size:1.4rem">${heading}</h1><p style="color:#666">${detail}</p></body></html>`;
}
function escapeHtml(value) {
	return value.replace(/[&<>"']/g, (char) => char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char === "\"" ? "&quot;" : "&#39;");
}
//#endregion
//#region src/server/auto-login.ts
/**
* The automatic half of onboarding (design §5.1; task: 首启即登录).
*
* `setup()` no longer waits for an environment variable. When `resume()` says
* `needs_login`, this module runs the login **by itself**, non-blocking, in the
* shape the machine can actually finish:
*
* - graphical machine → **loopback OAuth**; the authorization URL is written to
*   the log *and* to `login.json`, and the browser is opened so the user only
*   clicks 授权;
* - SSH / no display → **device code**, whose `verification_uri` + short code go
*   to the same two places (the user is on another machine, so "open it for me"
*   cannot be done from here).
*
* Loopback that cannot even *start* (callback port unusable) **falls back to the
* device code** instead of dead-ending. The fallback happens only for a flow
* that never began — never for a user who denied or timed out, who would
* otherwise get a fresh short code thrown at someone who just said no.
*
* The caller (`server/index.ts`) owns the connection-state log lines; this
* module owns the prompts and the `login.json` record, so a prompt exists in
* exactly one place.
*/
/** An SSH session has no browser on *this* machine, so its callback can never land. */
function isRemoteSession(env = process.env) {
	return [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"SSH_TTY"
	].some((key) => (env[key] ?? "").trim().length > 0);
}
/**
* Which flow this machine can finish, absent an explicit choice. Windows and
* macOS always have a browser; elsewhere a display server is the only signal we
* actually have, and an SSH session overrides both.
*/
function preferredLoginMode(env = process.env, platform = process.platform) {
	if (isRemoteSession(env)) return "device";
	if (platform === "win32" || platform === "darwin") return "loopback";
	const display = (env["DISPLAY"] ?? "").trim();
	const wayland = (env["WAYLAND_DISPLAY"] ?? "").trim();
	return display.length > 0 || wayland.length > 0 ? "loopback" : "device";
}
async function runAutoLogin(options) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const logger = options.logger ?? createLogger("login");
	const forced = options.forcedMode ?? null;
	const mode = forced ?? preferredLoginMode(env, platform);
	if (forced === null) logger.info(mode === "device" ? "未检测到本机图形环境（或处于 SSH 会话），使用无头设备码登录（短码与验证地址同时写入登录文件）" : "检测到本机图形环境，使用回环 OAuth 登录，并尝试自动打开系统浏览器");
	const context = {
		login: options.login,
		dataDir: options.dataDir,
		logger,
		now: options.now ?? Date.now,
		signal: options.signal
	};
	const first = await attempt(mode, context);
	if (mode === "loopback" && forced === null && !first.ok && first.code === "unavailable") {
		logger.warn("回环登录无法启动（本机回调端口不可用），自动改用无头设备码登录");
		return {
			mode: "device",
			fellBack: true,
			attempts: ["loopback", "device"],
			outcome: await attempt("device", context)
		};
	}
	return {
		mode,
		fellBack: false,
		attempts: [mode],
		outcome: first
	};
}
async function attempt(mode, context) {
	const signalOptions = context.signal !== void 0 ? { signal: context.signal } : {};
	const outcome = mode === "loopback" ? await context.login({
		headless: false,
		...signalOptions,
		onAuthorizationUrl: (url, loopback) => publishPrompt(context, loopbackPrompt(context.now(), url, loopback.deadline))
	}) : await context.login({
		headless: true,
		...signalOptions,
		onCode: (notice) => publishPrompt(context, devicePrompt(context.now(), notice))
	});
	await settlePrompt(context, mode, outcome);
	return outcome;
}
/** Write the prompt file and log the line the user acts on — one or the other, never neither. */
async function publishPrompt(context, prompt) {
	let path = null;
	try {
		path = await writeLoginPrompt(context.dataDir, prompt);
	} catch (error) {
		context.logger.warn("登录信息文件写入失败，请直接使用下面的地址/短码", { error: error instanceof Error ? error.name : typeof error });
	}
	context.logger.info(formatLoginPrompt(prompt, path));
}
/**
* Replace the pending record with a terminal one that keeps no URL and no code,
* so `login.json` never outlives the flow holding a usable secret.
*/
async function settlePrompt(context, kind, outcome) {
	const now = context.now();
	const record = outcome.ok ? {
		version: 1,
		status: "connected",
		kind,
		createdAt: now,
		expiresAt: now,
		instruction: "登录已完成，可以关闭本文件。"
	} : {
		version: 1,
		status: "failed",
		kind,
		createdAt: now,
		expiresAt: now,
		instruction: failedInstruction(outcome)
	};
	await writeLoginPrompt(context.dataDir, record).catch(() => void 0);
}
/**
* The failed record's sentence. `not_configured` gets its own text: that user's
* problem is not "the flow failed", it is "this machine has no server address
* yet", so the file has to say exactly where to put one (defect ①/②) — the log
* line and the copyable file carry the same words.
*/
function failedInstruction(outcome) {
	if (outcome.code === "not_configured") return `登录未完成（not_configured）：${outcome.message}怎么设置服务器地址：在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，或设置环境变量 ${SERVER_URL_ENV}，或先让 AA Desktop 完成一次连接；详见 opencode-plugin/README.md「账号接入（P4）」一节。`;
	return `登录未完成（${outcome.code}）：${outcome.message}。重启 OpenCode 可重试，或参考 opencode-plugin/README.md「账号接入（P4）」一节。`;
}
function loopbackPrompt(now, authorizationUrl, deadline) {
	return {
		version: 1,
		status: "pending",
		kind: "loopback",
		createdAt: now,
		expiresAt: deadline,
		instruction: "在浏览器打开授权地址并点一次「授权」。",
		authorizationUrl
	};
}
function devicePrompt(now, notice) {
	return {
		version: 1,
		status: "pending",
		kind: "device",
		createdAt: now,
		expiresAt: notice.expiresAt,
		instruction: `打开 ${notice.verificationUri} 并输入短码 ${notice.userCode}。`,
		verificationUri: notice.verificationUri,
		verificationUriComplete: notice.verificationUriComplete,
		userCode: notice.userCode
	};
}
//#endregion
//#region src/server/login-state.ts
/**
* The three connection states, each as one **actionable** line (task item 5):
* `needs_login` · `logging_in` · `connected`.
*
* `logging_in` lives with the prompt itself (`shared/login-prompt.ts`, since the
* URL/short code is what makes it actionable) and is emitted by
* `server/auto-login.ts`. This module owns the other two plus the "auto login is
* switched off" variant, so every state a user can be left in says what is
* wrong **and what to do next** — never a bare debug line.
*
* The configuration is named in the line ("came from `options.autoLogin`"), so
* "why is it not logging me in?" is answerable from the log alone.
*/
/** Where the switch was read from — printed verbatim so the user can go turn it on. */
function sourceLabel(source) {
	if (source === "options") return "插件配置 options.autoLogin";
	if (source === "env") return `环境变量 ${AUTO_LOGIN_ENV}`;
	return "默认值";
}
function needsLoginStateLine(stage, policy) {
	const server = stage.apiBaseUrl ?? `未配置（怎么设置：在 opencode.json 的插件项设置 options.serverUrl，或设置环境变量 AGENT_SERVER_URL；本机 Connector / AA Desktop 已有的服务器记录会被自动识别；详见 opencode-plugin/README.md「账号接入（P4）」一节）`;
	const next = policy.autoLogin ? "下一步：不需要你做任何事 —— 登录已自动发起；图形环境会打开浏览器点一次「授权」，无头/远程环境会给出验证地址与短码（同时写在登录文件里）。" : `下一步：自动登录当前关闭（来源：${sourceLabel(policy.autoLoginSource)}）；在 opencode.json 的插件项里设置 options.autoLogin = true（或删除 ${AUTO_LOGIN_ENV}）后重启 OpenCode。`;
	return `未连接：需要登录（原因：${stage.reason}）。服务器：${server}。${next}`;
}
function autoLoginDisabledStateLine(policy) {
	return `自动登录已关闭（来源：${sourceLabel(policy.autoLoginSource)}），本次不会尝试登录。下一步：需要连接时把 options.autoLogin 设为 true 后重启 OpenCode；或临时删除 ${AUTO_LOGIN_ENV}。`;
}
function connectedStateLine(stage, detail) {
	const how = detail.fellBack ? "设备码登录（回环不可用后自动回退）" : detail.loginMode === "device" ? "设备码登录" : detail.loginMode === "loopback" ? "回环 OAuth 登录" : "复用已有凭据";
	const device = stage.reusedDevice ? "复用本机已有的 Connector" : "已启动新的 Connector";
	return `已连接：账号 ${stage.userId}，设备 ${stage.connectorId}（${how}；${device}）。无需其他操作。`;
}
function disabledStateLine(stage) {
	return `未连接：本地凭据状态不可用（${stage.reason}）。下一步：检查 AGENT_CONNECTOR_DATA_DIR 指向的目录是否可读写后重启 OpenCode。`;
}
//#endregion
//#region src/server/command-flows.ts
/**
* The three palette commands' **flows** (task A.1/A.3) — thin adapters over the
* machinery that already exists, so the command surface and the automatic
* trigger are one implementation, not two.
*
* `runSetupLogin` lives here (re-exported from `server/index.ts`) because both
* callers need it: `setup()` fires it when `resume()` says `needs_login`, and
* `/aa-login` runs it when the user asks. Same onboarding instance, same
* loopback→device fallback, same `login.json` record.
*
* Every `execute` returns a human-readable string and **never throws**: a
* command handler that throws is a silent no-op in a palette, which is exactly
* the failure mode this whole file exists to avoid.
*/
const logger$1 = createLogger("plugin");
/**
* Login + outcome logging, never throwing. Callers fire it without awaiting (the
* host must not be blocked by an interactive flow); tests await the returned
* promise to assert the three state lines.
*/
async function runSetupLogin(task) {
	const loginLogger = task.logger ?? createLogger("login");
	try {
		const result = await runAutoLogin({
			login: task.login,
			logger: loginLogger,
			dataDir: task.dataDir,
			...task.env !== void 0 ? { env: task.env } : {},
			forcedMode: task.forcedMode ?? null
		});
		if (result.outcome.ok) loginLogger.info(connectedStateLine(result.outcome.stage, {
			loginMode: result.mode,
			fellBack: result.fellBack
		}));
		else loginLogger.warn(`登录未完成（${result.outcome.code}）：${result.outcome.message}。下一步：重启 OpenCode 会重新发起登录；无头环境可设置 AGENT_AA_LOGIN=device 强制设备码；也可参考 opencode-plugin/README.md「账号接入」一节。`);
		return result;
	} catch (error) {
		loginLogger.warn("自动登录失败", { error: error instanceof Error ? error.name : typeof error });
		return null;
	}
}
/** The command names, in one place so tests and logs cannot drift apart. */
const AA_COMMANDS = {
	login: "aa-login",
	status: "aa-status",
	logout: "aa-logout"
};
/**
* The flows themselves. Each returns the text a palette entry can display as-is
* and degrades to an actionable message instead of throwing.
*/
function createCommandFlows(options) {
	const flowLogger = options.logger ?? logger$1;
	const env = options.env ?? process.env;
	return {
		login: async () => {
			const onboarding = options.onboarding();
			const promptFile = loginPromptPath(onboarding.dataDir);
			const result = await runSetupLogin({
				login: (loginOptions) => onboarding.login(loginOptions),
				dataDir: onboarding.dataDir,
				env,
				logger: flowLogger,
				forcedMode: options.forcedMode ?? null
			});
			if (result === null) return `登录未完成：登录流程自身出错。下一步：打开登录文件 ${promptFile} 看原因（或查看 OpenCode 日志），然后重试 /aa-login。`;
			if (result.outcome.ok) return `登录成功。${connectedStateLine(result.outcome.stage, {
				loginMode: result.mode,
				fellBack: result.fellBack
			})}\n关键路径：凭据在 ${onboarding.dataDir}（account.json / bindings/，无需手动编辑）；登录状态文件 ${promptFile}。`;
			const next = result.outcome.code === "not_configured" ? "下一步：先设置服务器地址 —— 在 opencode.json 的插件项写 {\"options\":{\"serverUrl\":\"https://你的服务器\"}}，或设置 AGENT_SERVER_URL；详见 opencode-plugin/README.md「账号接入（P4）」。" : "下一步：重试 /aa-login；无头/SSH 环境可用 AGENT_AA_LOGIN=device 强制设备码。";
			return `登录未完成（${result.outcome.code}）：${result.outcome.message}${next}\n登录文件（授权地址 / 短码 / 原因都写在这里，可直接打开复制）：${promptFile}`;
		},
		status: async () => {
			const onboarding = options.onboarding();
			const status = await onboarding.status();
			const host = options.host?.();
			const lines = ["Agents Anywhere 状态"];
			lines.push(status.apiBaseUrl === null ? "- 服务器：未配置（下一步：在 opencode.json 的插件项设置 options.serverUrl，或设置 AGENT_SERVER_URL；本机 Connector / AA Desktop 已有的服务器记录会被自动识别）" : `- 服务器：${status.apiBaseUrl}` + (status.apiBaseUrlSource !== void 0 ? `（来源：${SERVER_URL_SOURCE_LABEL[status.apiBaseUrlSource]}）` : ""));
			lines.push(status.loggedIn ? `- 账号：${status.displayName ?? status.userId ?? "未知"}（${status.userId ?? "—"}）已登录，凭据到期 ${formatTime(status.accountExpiresAt)}` : "- 账号：未登录（下一步：运行 /aa-login 发起登录）");
			lines.push(status.connectorId === null ? "- 设备：未绑定（下一步：运行 /aa-login 完成设备绑定与 Connector 启动）" : `- 设备：${status.connectorId}（Connector ${status.connectorRunning ? "运行中" : "未由本进程运行"}）`);
			if (typeof status.credentialProblem === "string" && status.credentialProblem.length > 0) lines.push(`- 设备凭据：${status.credentialProblem}`);
			lines.push(host === void 0 ? `- 宿主：OpenCode 版本未知（本插件支持 ${OPENCODE_SUPPORTED_RANGE}）` : `- 宿主：OpenCode ${host.version ?? "版本未知"}（支持 ${OPENCODE_SUPPORTED_RANGE}；已核验 ${OPENCODE_VALIDATED_VERSIONS.join("、")}）`);
			lines.push(`- 能力：${(host?.capabilities ?? summarizeHostSurface(void 0)).join(" · ") || "宿主未暴露任何可探测能力"}`);
			lines.push(`- 登录文件：${loginPromptPath(onboarding.dataDir)}（授权地址 / 短码 / 失败原因）`);
			return lines.join("\n");
		},
		logout: async () => {
			const onboarding = options.onboarding();
			await onboarding.logout();
			return `已登出：已先在服务端撤销设备凭据，再清理本地账号/设备记录，并停止本插件启动的 Connector。\n下一步：需要重新连接时运行 /aa-login；本地凭据目录 ${onboarding.dataDir}（account.json / bindings/ 已清理）。`;
		}
	};
}
/**
* Which host surfaces are actually present — the capability summary `aa-status`
* prints. Derived from the live context (never from a static list) so the line
* cannot claim a surface this host does not have.
*/
function summarizeHostSurface(ctx) {
	const out = [];
	if (typeof ctx?.event?.subscribe === "function") out.push("事件流");
	if (typeof ctx?.permission?.hook === "function" || typeof ctx?.permission?.reply === "function") out.push("权限桥");
	if (typeof ctx?.session?.prompt === "function" || typeof ctx?.session?.update === "function") out.push("会话读写");
	if (typeof ctx?.agent?.transform === "function" || typeof ctx?.model?.transform === "function") out.push("agent/model 目录");
	if (typeof ctx?.command?.transform === "function") out.push("命令面板");
	return out;
}
/** The three palette entries, each dispatching to its flow and never throwing. */
function createCommandEntries(flows) {
	return [
		{
			name: AA_COMMANDS.login,
			description: "Agents Anywhere：连接本机/服务器（优先复用可用的 Connector，否则发起登录；图形环境自动打开浏览器，回环不可用时自动回退设备码）",
			execute: guarded("登录", flows.login)
		},
		{
			name: AA_COMMANDS.status,
			description: "Agents Anywhere：显示连接状态（服务器/账号/设备/宿主版本/能力摘要），并给出下一步操作",
			execute: guarded("状态查询", flows.status)
		},
		{
			name: AA_COMMANDS.logout,
			description: "Agents Anywhere：登出（先在服务端撤销设备凭据，再清理本地凭据，并停止本插件的 Connector）",
			execute: guarded("登出", flows.logout)
		}
	];
}
/** Wrap a flow so a throw still answers the palette with something actionable. */
function guarded(label, flow) {
	return async () => {
		try {
			return await flow();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			logger$1.warn(`命令 /${label} 执行失败`, { error: error instanceof Error ? error.name : typeof error });
			return `${label}失败：${detail}。下一步：查看 OpenCode 日志后重试；若持续失败，重启 OpenCode 再执行一次命令。`;
		}
	};
}
function formatTime(epochMs) {
	return epochMs === null ? "未知" : new Date(epochMs).toISOString();
}
//#endregion
//#region src/server/commands.ts
/**
* Host command syntax. Lowercase words separated by `-` / `_` / `.`, leading
* digit allowed, 64 chars max — the conservative subset of what the host's own
* built-ins (`init`, `review`) and our `aa-*` family use. Anything outside it is
* refused rather than gambled on: an illegal name is the 500-risk case.
*/
const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/**
* The host's `description` is optional, but a description is what makes a
* palette entry discoverable. An over-long one is truncated (a long string is
* not a registry hazard, an absent one is a usability hazard); a non-string one
* is a validation failure.
*/
const MAX_DESCRIPTION_CHARS = 200;
function createCommandRegistry() {
	const names = /* @__PURE__ */ new Set();
	return {
		has: (name) => names.has(name),
		claim: (name) => {
			if (names.has(name)) return false;
			names.add(name);
			return true;
		}
	};
}
/** Process-wide registry shared by every `setup()` in this host process. */
const processCommandRegistry = createCommandRegistry();
/**
* Validate one candidate. `taken` answers membership for the names already
* claimed in this process **and** for the ones accepted earlier in the same
* batch, so uniqueness is checked here rather than discovered from the host
* afterwards (where duplicate handling is unknown).
*/
function validateCommandEntry(value, index, taken) {
	const reject = (name, reason) => ({
		ok: false,
		issue: {
			index,
			name,
			reason
		}
	});
	if (value === null || typeof value !== "object" || Array.isArray(value)) return reject(String(value), "命令候选不是一个对象");
	const record = value;
	const name = record["name"];
	if (typeof name !== "string" || name.length === 0) return reject(describe(name), "name 必须是字符串且非空");
	if (!COMMAND_NAME_PATTERN.test(name)) return reject(name, `name 不符合宿主命令语法（要求 ${String(COMMAND_NAME_PATTERN)}）`);
	if (taken.has(name)) return reject(name, "命令名在本进程内已被占用（重名会污染注册表）");
	const description = record["description"];
	if (typeof description !== "string") return reject(name, "description 必须是字符串");
	const execute = record["execute"];
	if (typeof execute !== "function") return reject(name, "execute 必须是函数");
	return {
		ok: true,
		entry: {
			name,
			description: description.slice(0, MAX_DESCRIPTION_CHARS),
			execute
		}
	};
}
/**
* Register palette commands. Never throws and never hands an unvalidated value
* to the host: an absent `ctx.command.transform` (older host, or a non-command
* context) is reported once and the registration is a no-op.
*/
function registerCommands(api, candidates, options) {
	const { logger } = options;
	const registry = options.registry ?? processCommandRegistry;
	const batch = /* @__PURE__ */ new Set();
	const taken = { has: (name) => batch.has(name) || registry.has(name) };
	const accepted = [];
	const rejected = [];
	candidates.forEach((candidate, index) => {
		const verdict = validateCommandEntry(candidate, index, taken);
		if (!verdict.ok) {
			rejected.push(verdict.issue);
			logger.warn("命令未注册：候选载荷未通过校验（已被拦下，不会进入宿主注册表）", {
				index: verdict.issue.index,
				name: verdict.issue.name,
				reason: verdict.issue.reason
			});
			return;
		}
		batch.add(verdict.entry.name);
		accepted.push(verdict.entry);
	});
	const transform = api?.transform;
	if (typeof transform !== "function") {
		logger.warn("宿主未提供 ctx.command.transform，本次不注册命令面板项（自动登录仍照常工作）");
		return {
			registered: [],
			rejected
		};
	}
	const registered = [];
	try {
		transform((draft) => {
			if (draft === null || typeof draft !== "object") return;
			const add = draft.add;
			if (typeof add !== "function") {
				logger.warn("命令草稿未提供 add，本次不注册命令面板项");
				return;
			}
			for (const entry of accepted) {
				const payload = {
					name: entry.name,
					description: entry.description,
					execute: entry.execute
				};
				try {
					const result = add(payload);
					if (result instanceof Map && !result.has(entry.name)) {
						rejected.push({
							index: -1,
							name: entry.name,
							reason: "宿主注册结果中不含该命令（schema 错误被 add 吞掉）"
						});
						logger.warn("宿主命令注册结果中缺少该命令（宿主 schema 可能吞掉了错误）", { name: entry.name });
						continue;
					}
					registered.push(entry.name);
				} catch (error) {
					logger.warn("命令注册被宿主拒绝", {
						name: entry.name,
						error: errorName$1(error)
					});
				}
			}
		});
	} catch (error) {
		logger.warn("命令注册失败，命令面板项不可用（自动登录仍照常工作）", { error: errorName$1(error) });
		return {
			registered,
			rejected
		};
	}
	for (const name of registered) registry.claim(name);
	return {
		registered,
		rejected
	};
}
function describe(value) {
	if (typeof value === "string") return value.slice(0, 80);
	return value === null ? "null" : typeof value;
}
function errorName$1(error) {
	return error instanceof Error ? error.name : typeof error;
}
/**
* Run `work` under `lockPath`. The lock is released even when `work` throws;
* a timeout never throws — see the module comment.
*/
async function withFileLock(lockPath, work, options = {}) {
	const now = options.now ?? Date.now;
	const waitMs = options.waitMs ?? 1e4;
	const staleMs = options.staleMs ?? 6e4;
	const pollMs = options.pollMs ?? 40;
	const started = now();
	let held = false;
	while (!held) {
		held = await tryAcquire(lockPath, now, staleMs);
		if (held) break;
		if (now() - started >= waitMs) {
			options.onTimeout?.(now() - started);
			break;
		}
		await delay(pollMs);
	}
	try {
		return await work();
	} finally {
		if (held) await promises.rm(lockPath, { force: true }).catch(() => void 0);
	}
}
/** One acquisition attempt: create exclusively, else reclaim only if stale. */
async function tryAcquire(lockPath, now, staleMs) {
	await promises.mkdir(dirname(lockPath), {
		recursive: true,
		mode: 448
	});
	if (await create(lockPath, now)) return true;
	try {
		const info = await promises.stat(lockPath);
		if (now() - info.mtimeMs > staleMs) {
			await promises.rm(lockPath, { force: true }).catch(() => void 0);
			return await create(lockPath, now);
		}
	} catch {
		return await create(lockPath, now);
	}
	return false;
}
async function create(lockPath, now) {
	let handle;
	try {
		handle = await promises.open(lockPath, "wx", 384);
	} catch (error) {
		if (isCode(error, "EEXIST")) return false;
		throw error;
	}
	try {
		await handle.writeFile(`${process.pid} ${now()}\n`, "utf8");
	} finally {
		await handle.close();
	}
	return true;
}
function isCode(error, code) {
	return typeof error === "object" && error !== null && error.code === code;
}
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}
//#endregion
//#region src/server/account-api.ts
/**
* Thin HTTP client for the Agents Anywhere server's `/api/v2` surface used by
* onboarding (design §5.1/§5.4 and the P5 implementation report):
*
*   POST /oauth/token            authorization_code + PKCE  → access token
*   GET  /auth/me                account profile
*   GET  /connectors/{id}        device lookup (reuse verification)
*   POST /connector/auth         verify a device credential (the 401 oracle)
*   GET  /connectors             owned devices
*   GET  /connectors/{id}/runtime-types  what the Connector advertises (reuse gate)
*   POST /connectors             register a device  → connector token
*   POST /connectors/{id}/revoke rotate the device token
*   POST /oauth/device/code      RFC 8628 device authorization
*   POST /oauth/device/token     RFC 8628 device token poll
*
* Only Node built-ins; `fetch` is injectable so every branch is testable against
* a local fake server. Tokens and codes travel in request bodies/headers and are
* never logged here.
*/
const API_NAMESPACE = "/api/v2";
const DEFAULT_TIMEOUT_MS = 2e4;
var AccountApiError = class extends Error {
	status;
	code;
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
};
var AccountClient = class {
	#baseUrl;
	#fetch;
	#timeoutMs;
	constructor(options) {
		this.#baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
		this.#fetch = options.fetcher ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}
	get apiBaseUrl() {
		return this.#baseUrl;
	}
	/** Exchange a loopback authorization code (with PKCE) for a token bundle. */
	async exchangeAuthorizationCode(input) {
		return requireToken(await this.#json("/oauth/token", {
			method: "POST",
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: OAUTH_CLIENT_ID,
				code: input.code,
				code_verifier: input.verifier,
				redirect_uri: input.redirectUri
			})
		}, input.signal));
	}
	async me(accessToken, signal) {
		const payload = await this.#json("/auth/me", { headers: bearer(accessToken) }, signal);
		const userId = str(payload["userId"]) ?? str(payload["id"]);
		if (userId === null) throw new AccountApiError(200, null, "the account response carried no user id");
		const email = str(payload["email"]);
		return {
			userId,
			displayName: str(payload["displayName"]) ?? userId,
			email: email !== null && email.length > 0 ? email : null
		};
	}
	async requestDeviceCode(signal) {
		const payload = await this.#json("/oauth/device/code", {
			method: "POST",
			body: new URLSearchParams({
				client_id: OAUTH_CLIENT_ID,
				scope: OAUTH_SCOPE
			})
		}, signal);
		const deviceCode = str(payload["device_code"]);
		const userCode = str(payload["user_code"]);
		const verificationUri = str(payload["verification_uri"]);
		if (deviceCode === null || userCode === null || verificationUri === null) throw new AccountApiError(200, null, "the device-code response was missing required fields");
		const expiresIn = num(payload["expires_in"]);
		const interval = num(payload["interval"]);
		return {
			deviceCode,
			userCode,
			verificationUri,
			verificationUriComplete: str(payload["verification_uri_complete"]) ?? verificationUri,
			expiresIn: expiresIn !== null && expiresIn > 0 ? expiresIn : 600,
			interval: interval !== null && interval > 0 ? interval : 5,
			scope: str(payload["scope"])
		};
	}
	/**
	* One poll. RFC 8628 returns its pending/slow-down/denied states as HTTP 400
	* with an `{error, error_description}` body, so those are **results**, not
	* thrown errors — only a genuinely unexpected status throws.
	*/
	async pollDeviceToken(deviceCode, signal) {
		const response = await this.#send("/oauth/device/token", {
			method: "POST",
			body: new URLSearchParams({
				grant_type: DEVICE_GRANT_TYPE,
				client_id: OAUTH_CLIENT_ID,
				device_code: deviceCode
			})
		}, signal);
		const body = await readJson(response);
		if (response.ok) try {
			return {
				ok: true,
				token: requireToken(body ?? {})
			};
		} catch (error) {
			throw new AccountApiError(response.status, null, error instanceof Error ? error.message : "invalid token response");
		}
		const record = body ?? {};
		const error = str(record["error"]);
		if (response.status === 400 && error !== null) return {
			ok: false,
			error,
			description: str(record["error_description"]),
			interval: num(record["interval"])
		};
		throw new AccountApiError(response.status, error, `device token request failed (HTTP ${response.status})`);
	}
	/** `null` when the device no longer exists (HTTP 404) — a deleted device. */
	async getConnector(accessToken, id, signal) {
		try {
			return readDevice((await this.#json(`/connectors/${encodeURIComponent(id)}`, { headers: bearer(accessToken) }, signal))["connector"]);
		} catch (error) {
			if (error instanceof AccountApiError && error.status === 404) return null;
			throw error;
		}
	}
	/**
	* The server's only oracle for a **device** credential: `POST /connector/auth`
	* authorizes with the Connector's own `Connector <id>:<token>` header and
	* answers 401 for a rotated or revoked token. `GET /connectors/{id}` cannot
	* stand in for it — that call is authorized by the *account* token, so it
	* reports a rotated device credential as healthy (the real-machine root cause
	* of `online:false` / plugin 401).
	*
	* `true` = accepted, `false` = definitively rejected (401/403). Every other
	* outcome throws, so an unreachable or older server can never trigger a
	* rotation on a mere guess.
	*/
	async verifyConnectorToken(id, token, signal) {
		const response = await this.#send("/connector/auth", {
			method: "POST",
			headers: { Authorization: `Connector ${id}:${token}` }
		}, signal);
		if (response.ok) return true;
		if (response.status === 401 || response.status === 403) return false;
		throw new AccountApiError(response.status, null, `device credential check failed (HTTP ${response.status})`);
	}
	async listConnectors(accessToken, signal) {
		const payload = await this.#json("/connectors", { headers: bearer(accessToken) }, signal);
		return (Array.isArray(payload["connectors"]) ? payload["connectors"] : []).map(readDevice).filter((device) => device !== null);
	}
	/**
	* What the running Connector **advertises** it can drive — the reuse gate's
	* evidence (task B). Returns the raw payload: the server owns this shape
	* (`{runtimeTypes:[{runtimeType}]}` on 2.0.x, `{runtimes:[…]}` elsewhere), so
	* `connector-capability.ts` parses it defensively instead of asserting one.
	*/
	async listConnectorRuntimeTypes(accessToken, id, signal) {
		return await this.#json(`/connectors/${encodeURIComponent(id)}/runtime-types`, { headers: bearer(accessToken) }, signal);
	}
	async registerConnector(accessToken, input, signal) {
		const payload = await this.#json("/connectors", {
			method: "POST",
			headers: {
				...bearer(accessToken),
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				name: input.name,
				connectorKind: "cli",
				installationId: input.installationId
			})
		}, signal);
		const device = readDevice(payload["connector"]);
		const token = str(payload["connectorToken"]);
		if (device === null || token === null || token.length === 0) throw new AccountApiError(200, null, "device registration returned no credential");
		return {
			device,
			connectorToken: token
		};
	}
	/** `POST /connectors/{id}/revoke` also **rotates** the token (DSH semantics). */
	async revokeConnector(accessToken, id, signal) {
		const payload = await this.#json(`/connectors/${encodeURIComponent(id)}/revoke`, {
			method: "POST",
			headers: bearer(accessToken)
		}, signal);
		const device = readDevice(payload["connector"]);
		const token = str(payload["connectorToken"]);
		if (device === null || token === null || token.length === 0) throw new AccountApiError(200, null, "device revoke returned no credential");
		return {
			device,
			connectorToken: token
		};
	}
	async #json(path, options, signal) {
		const response = await this.#send(path, options, signal);
		const body = await readJson(response);
		if (!response.ok) {
			const record = body ?? {};
			throw new AccountApiError(response.status, str(record["error"]), `request failed (HTTP ${response.status})`);
		}
		if (body === null) throw new AccountApiError(response.status, null, "the server returned no JSON body");
		return body;
	}
	async #send(path, options, signal) {
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		return await this.#fetch(`${this.#baseUrl}${API_NAMESPACE}${path}`, {
			...options,
			redirect: "error",
			signal: signal !== void 0 ? AbortSignal.any([signal, timeout]) : timeout
		});
	}
};
function bearer(token) {
	return { Authorization: `Bearer ${token}` };
}
function requireToken(payload) {
	const accessToken = str(payload["access_token"]);
	const expiresIn = num(payload["expires_in"]);
	if (accessToken === null || expiresIn === null || expiresIn <= 0) throw new Error("the authorization server returned no usable credential");
	return {
		accessToken,
		expiresIn
	};
}
function readDevice(value) {
	if (value === null || typeof value !== "object") return null;
	const record = value;
	const id = str(record["id"]);
	const userId = str(record["userId"]);
	if (id === null || userId === null) return null;
	return {
		id,
		name: str(record["name"]) ?? id,
		userId
	};
}
async function readJson(response) {
	try {
		const value = await response.json();
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}
function str(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
//#endregion
//#region src/server/browser-opener.ts
/**
* "Open the authorization page in the user's browser" — with zero npm
* dependencies.
*
* The target UX is *install → start → click 授权 once*, so the loopback flow
* launches the authorization URL itself. Only the OS launcher is used; nothing
* is added to the bundle.
*
* Two invariants this module exists to protect:
*
* 1. **Never name a browser.** Channel builds (Edge Beta/Canary, Chrome
*    Canary, …) register their *own* ProgIDs and their *own* default-handler
*    associations, so a hard-coded executable (`msedge.exe`) or ProgID
*    (`MSEdgeHTM` / `ChromeHTML`) would open the wrong thing — or nothing —
*    the moment the user switches to a channel build. Every launcher below
*    goes through the platform's *shell association* instead, which is the one
*    mechanism that follows whatever the user actually set as default.
*
* 2. **Pass the URL verbatim, never through a shell.** The authorization URL
*    carries `&` and `%`
*    (`?response_type=code&client_id=…&redirect_uri=…&code_challenge=…`). Any
*    shell that re-parses its command line treats `&` as a command separator
*    and truncates the URL. So every launcher is invoked **argv-direct**: the
*    caller uses `execFile` (no shell), and each token — the URL included —
*    arrives at the target process byte-for-byte. This is also why `cmd /c
*    start` is deliberately *not* used: `cmd` re-parses its own command line
*    and splits on `&` even when node quotes the argument.
*
* Failure is **soft by construction**: this module never throws — it answers
* `'failed'` after exhausting the fallback chain — and the caller keeps the
* loopback listener up and prints the URL for a manual copy (the URL is always
* in the log and in `login.json` before any launch is attempted). A machine
* with no browser must not cost the user a login.
*/
const execFileAsync = promisify(execFile);
/**
* The candidate argv chains that hand `url` to the platform's default browser,
* in fallback order, or `[]` on a platform we cannot drive (the caller then
* reports "open it yourself"). Each entry is argv-direct — nothing here is ever
* routed through a shell — and none of them names a browser.
*/
function browserCommands(url, platform = process.platform) {
	if (platform === "win32") return [{
		command: "rundll32.exe",
		args: ["url.dll,FileProtocolHandler", url]
	}, {
		command: "explorer.exe",
		args: [url]
	}];
	if (platform === "darwin") return [{
		command: "open",
		args: [url]
	}];
	if (platform === "linux" || platform === "freebsd" || platform === "openbsd" || platform === "sunos") return [{
		command: "xdg-open",
		args: [url]
	}];
	return [];
}
async function openExternal(url, options = {}) {
	const launches = browserCommands(url, options.platform ?? process.platform);
	if (launches.length === 0) return "failed";
	const run = options.run ?? defaultRun;
	for (const launch of launches) try {
		await run(launch.command, launch.args);
		return "opened";
	} catch {}
	return "failed";
}
async function defaultRun(command, args) {
	await execFileAsync(command, args, {
		timeout: 1e4,
		windowsHide: true
	});
}
//#endregion
//#region src/server/connector-capability.ts
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
const OPENCODE_RUNTIME_TYPE = "opencode";
/**
* Pull `runtimeType` values out of either server shape
* (`{runtimeTypes:[{runtimeType}]}` / `{runtimes:[{runtimeType}]}`) and return
* `null` when neither array is present — "unrecognisable", never "empty".
*/
function readRuntimeTypes(payload) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const record = payload;
	for (const key of ["runtimeTypes", "runtimes"]) {
		const rows = record[key];
		if (!Array.isArray(rows)) continue;
		const types = [];
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const value = row["runtimeType"];
			if (typeof value === "string" && value.length > 0) types.push(value);
		}
		return types;
	}
	return null;
}
/** Pure verdict, so the policy is testable without any transport. */
function judgeConnectorCapability(input) {
	if (input.runtimeTypes === null) return {
		verdict: "unknown",
		runtimeTypes: [],
		reason: `无法从服务端确认该 Connector 上报的 runtime 类型${input.error !== null && input.error !== void 0 && input.error.length > 0 ? `：${input.error}` : ""}，保守起见不复用它`
	};
	if (input.runtimeTypes.includes("opencode")) return {
		verdict: "reuse",
		runtimeTypes: input.runtimeTypes,
		reason: `该 Connector 上报的 runtime 类型包含 ${OPENCODE_RUNTIME_TYPE}`
	};
	return {
		verdict: "incompatible",
		runtimeTypes: input.runtimeTypes,
		reason: `该 Connector 上报的 runtime 类型为 [${input.runtimeTypes.join(", ") || "空"}]，不认识 ${OPENCODE_RUNTIME_TYPE}`
	};
}
/**
* Ask the server what this Connector advertises. Any failure — 404, offline
* Connector, network error, unexpected payload — is `unknown`, which the caller
* treats as "do not reuse".
*/
async function probeConnectorCapability(options) {
	try {
		return judgeConnectorCapability({ runtimeTypes: readRuntimeTypes(await options.listRuntimeTypes(options.accessToken, options.connectorId)) });
	} catch (error) {
		return judgeConnectorCapability({
			runtimeTypes: null,
			error: error instanceof Error ? error.message : String(error)
		});
	}
}
//#endregion
//#region src/server/device-login.ts
var DeviceLoginError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
	}
};
const SLOW_DOWN_STEP_SECONDS = 5;
async function runDeviceLogin(options) {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const code = await options.client.requestDeviceCode(options.signal);
	const expiresAt = now() + code.expiresIn * 1e3;
	await options.onCode({
		userCode: code.userCode,
		verificationUri: code.verificationUri,
		verificationUriComplete: code.verificationUriComplete,
		expiresAt,
		interval: code.interval
	});
	let intervalMs = code.interval * 1e3;
	for (;;) {
		throwIfAborted(options.signal);
		if (now() >= expiresAt) throw new DeviceLoginError("expired_token", "the device code expired before it was approved");
		await sleep(intervalMs, options.signal);
		throwIfAborted(options.signal);
		if (now() >= expiresAt) throw new DeviceLoginError("expired_token", "the device code expired before it was approved");
		const result = await options.client.pollDeviceToken(code.deviceCode, options.signal);
		if (result.ok) return result.token;
		switch (result.error) {
			case "authorization_pending": continue;
			case "slow_down": {
				const suggested = result.interval;
				intervalMs = suggested !== null && suggested > 0 ? suggested * 1e3 : intervalMs + SLOW_DOWN_STEP_SECONDS * 1e3;
				continue;
			}
			case "access_denied": throw new DeviceLoginError("access_denied", "the request was denied on the approval page");
			case "expired_token": throw new DeviceLoginError("expired_token", "the device code expired before it was approved");
			case "invalid_grant": throw new DeviceLoginError("invalid_grant", "the device code was rejected");
			case "unsupported_grant_type": throw new DeviceLoginError("unsupported_grant_type", "the server does not support the device-code grant");
			default: throw new DeviceLoginError("unexpected_error", `the device authorization failed (${result.error})`);
		}
	}
}
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new DeviceLoginError("aborted", "the device login was cancelled");
}
async function defaultSleep(ms, signal) {
	if (signal?.aborted === true) throw new DeviceLoginError("aborted", "the device login was cancelled");
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DeviceLoginError("aborted", "the device login was cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region src/server/onboarding.ts
/**
* Onboarding orchestration (design §5.1): reuse-first, then loopback OAuth or
* the headless device-code fallback, then device registration/reuse, then spawn
* the Connector. This is the module `server/index.ts` wires into `setup()`.
*
* Order matters and is enforced here:
*   1. effective credentials on disk  → zero login (reuse)
*   2. the shared `connector-runtime.json` record mentions our device → reuse it
*   3. only then an interactive flow
* Logout is the exact reverse and **irreversible**: revoke on the server first,
* then delete the local binding/account, then stop the Connector. Deleting local
* state first would orphan a live device credential on the server.
*
* A stored device credential is **verified before it is used** (§ resume):
* `POST /connector/auth` is the only call that actually validates a device
* token, and a 401 is healed automatically (rotate the same device, or register
* it anew when the row is gone) under a cross-process lock, writing the
* server-issued token atomically. A 401 reported *after* a Connector started is
* never silent: it reaches the log, `login.json` and `status()`, with a next
* step, and one bounded heal-and-restart is attempted.
*
* The interactive half is *triggered* by `server/index.ts` (`runAutoLogin`) the
* moment `resume()` says `needs_login`; this module only performs it. Loopback
* opens the system browser fail-soft and hands the prompt context (URL +
* deadline) to the caller, which logs it and writes `login.json` — nothing about
* a login is discoverable **only** in the log.
*
* No secret is ever logged.
*/
/** How many automatic credential repairs one process attempts before it only reports. */
const MAX_AUTH_HEAL_ATTEMPTS = 2;
/**
* The sentence a rejected device credential must leave behind (log, `login.json`
* and `status()` all carry it verbatim): what happened, why it can happen, and
* exactly what to do next — never a bare `offline`.
*/
function credentialRejectedInstruction() {
	return "设备凭据被服务器拒绝（HTTP 401）：本地保存的 Connector 凭据与服务端不一致（重复注册导致的令牌轮换、其它主机恢复同一设备、或设备被撤销都会造成）。下一步：插件会自动轮换设备凭据并重启 Connector；若仍失败，请运行 /aa-login 重新登录（或运行 /aa-logout 后再 /aa-login）。";
}
var Onboarding = class {
	#logger;
	#env;
	#fetcher;
	#now;
	#openUrl;
	#deviceName;
	#probeConnector;
	#probeConnectorCapability;
	#forceReuseConnector;
	/** `options.serverUrl` / `options.connectorSource`, the plugin-config layer. */
	#optionServerUrl;
	#optionConnectorSource;
	#serverUrlFiles;
	#readText;
	#platform;
	#stopOwnConnector;
	/** Memoised resolution — one read + one log per instance, not one per call. */
	#serverUrlTask;
	supervisor;
	/** Last account/binding handed to the supervisor — the heal path's context. */
	#lastAccount = null;
	#lastBinding = null;
	/** The flow a future credential-failure record should name (no secret). */
	#lastLoginKind = "loopback";
	/** Actionable text while the stored credential is rejected; `null` when healthy. */
	#credentialProblem = null;
	#authHealAttempts = 0;
	#authHealRunning = false;
	constructor(options = {}) {
		this.#logger = options.logger ?? createLogger("onboarding");
		this.#env = options.env ?? process.env;
		this.#fetcher = options.fetcher;
		this.#now = options.now ?? Date.now;
		this.#openUrl = options.openUrl !== void 0 ? wrapOpener(options.openUrl) : openExternal;
		this.#deviceName = options.deviceName ?? defaultDeviceName;
		this.#optionServerUrl = options.serverUrl ?? null;
		this.#optionConnectorSource = options.connectorSource ?? null;
		this.#serverUrlFiles = options.serverUrlFiles;
		this.#readText = options.readText;
		this.#platform = options.platform;
		this.#stopOwnConnector = options.stopOwnConnector ?? ((pid) => killProcessTree(pid));
		this.#probeConnector = options.probeConnector ?? ((connectorId) => probeExistingConnector({
			env: this.#env,
			connectorId
		}));
		this.#probeConnectorCapability = options.probeConnectorCapability ?? ((input) => probeConnectorCapability({
			accessToken: input.account.accessToken,
			connectorId: input.connectorId,
			listRuntimeTypes: (token, connectorId) => this.#client(input.account.apiBaseUrl).listConnectorRuntimeTypes(token, connectorId)
		}));
		this.#forceReuseConnector = options.forceReuseConnector === true;
		this.supervisor = options.supervisor ?? new ConnectorSupervisor({
			...options.logger !== void 0 ? { logger: options.logger } : {},
			...options.env !== void 0 ? { env: options.env } : {},
			...this.#optionConnectorSource !== null ? { sourceDir: this.#optionConnectorSource } : {},
			onState: (state) => this.#handleSupervisorState(state)
		});
		this.supervisor.attachStateListener?.((state) => this.#handleSupervisorState(state));
	}
	get dataDir() {
		return pluginDataDir(this.#env);
	}
	/**
	* Server origin, highest layer first: plugin config (`options.serverUrl`) →
	* `AGENT_SERVER_URL` → the machine's own `connector-runtime.json` → the
	* Desktop app's config → `settings.json` (added by each caller, since a
	* stored account records its own origin). Every skipped layer and the winning
	* one are logged — see `shared/server-url.ts`.
	*
	* Memoised: the layers are process-level or restart-level, and `status()` is
	* polled by the TUI, so re-reading (and re-logging) them on every call would
	* be noise. A configuration change still needs an OpenCode restart, exactly
	* like `options.*` itself.
	*/
	#resolveServerUrl() {
		this.#serverUrlTask ??= locateServerUrl({
			optionUrl: this.#optionServerUrl,
			env: this.#env,
			logger: this.#logger,
			...this.#serverUrlFiles !== void 0 ? { files: this.#serverUrlFiles } : {},
			...this.#readText !== void 0 ? { readText: this.#readText } : {},
			...this.#platform !== void 0 ? { platform: this.#platform } : {}
		});
		return this.#serverUrlTask;
	}
	async status() {
		const dataDir = this.dataDir;
		const settings = await readSettings(dataDir);
		const account = await readAccount(dataDir);
		const binding = account !== null ? await readBinding(dataDir, account.apiBaseUrl, account.userId) : null;
		const resolved = await this.#resolveServerUrl();
		const apiBaseUrl = account?.apiBaseUrl ?? resolved.url ?? settings?.apiBaseUrl ?? null;
		const status = {
			configured: settings !== null,
			apiBaseUrl,
			loggedIn: accountIsUsable(account, this.#now()),
			accountExpiresAt: account?.expiresAt ?? null,
			userId: account?.userId ?? null,
			displayName: account?.displayName ?? null,
			connectorId: binding?.connectorId ?? null,
			connectorRunning: this.supervisor.running,
			credentialProblem: this.#credentialProblem
		};
		if (account === null && resolved.url !== null) status.apiBaseUrlSource = resolved.source;
		return status;
	}
	/**
	* Attempt a *zero-login* connection. Returns `needs_login` (not an error) when
	* there is nothing usable on disk — the caller decides whether to prompt.
	*/
	async resume() {
		const dataDir = this.dataDir;
		let settings;
		let account;
		try {
			settings = await readSettings(dataDir);
			account = await readAccount(dataDir);
		} catch (error) {
			return {
				stage: "disabled",
				reason: `credential store unreadable: ${errorName(error)}`
			};
		}
		if (!accountIsUsable(account, this.#now())) {
			const pending = await readPendingFlow(dataDir).catch(() => null);
			if (pending !== null && !pendingFlowIsLive(pending, this.#now())) await clearPendingFlow(dataDir).catch(() => void 0);
			return {
				stage: "needs_login",
				apiBaseUrl: (await this.#resolveServerUrl()).url ?? settings?.apiBaseUrl ?? null,
				reason: account === null ? "no stored account" : "the stored access token is expired"
			};
		}
		const binding = await readBinding(dataDir, account.apiBaseUrl, account.userId);
		if (binding === null) return {
			stage: "needs_login",
			apiBaseUrl: account.apiBaseUrl,
			reason: "no device binding yet"
		};
		let usable = binding;
		try {
			usable = await this.#ensureBinding(this.#client(account.apiBaseUrl), account);
		} catch (error) {
			if (isStatus(error, 401)) return {
				stage: "needs_login",
				apiBaseUrl: account.apiBaseUrl,
				reason: "账号凭据已被服务端拒绝（需要重新登录）"
			};
			this.#logger.warn("连接前无法校验/修复设备凭据，先用本地凭据启动 Connector（若之后收到 401，日志与 login.json 会给出下一步）", { error: errorName(error) });
		}
		try {
			const reused = await this.#startConnector(account, usable, true);
			return {
				stage: "connected",
				apiBaseUrl: account.apiBaseUrl,
				userId: account.userId,
				connectorId: usable.connectorId,
				reusedDevice: reused
			};
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "connector_already_running") return {
				stage: "connected",
				apiBaseUrl: account.apiBaseUrl,
				userId: account.userId,
				connectorId: usable.connectorId,
				reusedDevice: true
			};
			return {
				stage: "needs_login",
				apiBaseUrl: account.apiBaseUrl,
				reason: `connector failed to start: ${errorName(error)}`
			};
		}
	}
	async login(options = {}) {
		const dataDir = this.dataDir;
		this.#lastLoginKind = options.headless === true ? "device" : "loopback";
		const settings = await readSettings(dataDir);
		const apiBaseUrl = options.apiBaseUrl ?? (await this.#resolveServerUrl()).url ?? settings?.apiBaseUrl ?? null;
		if (apiBaseUrl === null) return {
			ok: false,
			code: "not_configured",
			message: `尚未配置服务器地址（插件配置、环境变量与本机的 Connector / Desktop 记录都没有可用的 serverUrl）。怎么设置：在 opencode.json 的插件项写 {"options":{"serverUrl":"https://你的服务器"}}，或设置环境变量 ${SERVER_URL_ENV}，或先让 AA Desktop 完成一次连接；详见 opencode-plugin/README.md「账号接入（P4）」一节。`
		};
		const client = this.#client(apiBaseUrl);
		let tokens;
		try {
			tokens = options.headless === true ? await runDeviceLogin({
				client,
				onCode: options.onCode ?? (() => void 0),
				...options.signal !== void 0 ? { signal: options.signal } : {},
				...options.pollSleep !== void 0 ? { sleep: options.pollSleep } : {}
			}) : await this.#loopbackLogin(client, apiBaseUrl, options);
		} catch (error) {
			await clearPendingFlow(dataDir).catch(() => void 0);
			return {
				ok: false,
				code: errorCode(error),
				message: errorMessage(error)
			};
		}
		let profile;
		try {
			profile = await client.me(tokens.accessToken, options.signal);
		} catch (error) {
			return {
				ok: false,
				code: "profile_failed",
				message: errorMessage(error)
			};
		}
		const account = {
			version: 1,
			apiBaseUrl,
			userId: profile.userId,
			displayName: profile.displayName,
			email: profile.email,
			accessToken: tokens.accessToken,
			expiresAt: this.#now() + tokens.expiresIn * 1e3
		};
		await saveAccount(dataDir, account);
		await clearPendingFlow(dataDir).catch(() => void 0);
		let binding;
		try {
			binding = await this.#ensureBinding(client, account);
		} catch (error) {
			return {
				ok: false,
				code: "device_failed",
				message: errorMessage(error)
			};
		}
		try {
			const reused = await this.#startConnector(account, binding, false);
			return {
				ok: true,
				stage: {
					stage: "connected",
					apiBaseUrl,
					userId: account.userId,
					connectorId: binding.connectorId,
					reusedDevice: reused
				}
			};
		} catch (error) {
			if (error instanceof Error && error.code === "connector_already_running") return {
				ok: true,
				stage: {
					stage: "connected",
					apiBaseUrl,
					userId: account.userId,
					connectorId: binding.connectorId,
					reusedDevice: true
				}
			};
			return {
				ok: false,
				code: "connector_failed",
				message: errorMessage(error)
			};
		}
	}
	/**
	* Logout, in the only safe order: **revoke on the server → clear local → stop
	* the Connector**. A revoke failure stops the sequence rather than deleting a
	* credential that is still live.
	*/
	async logout() {
		const dataDir = this.dataDir;
		const account = await readAccount(dataDir);
		if (account !== null) {
			const binding = await readBinding(dataDir, account.apiBaseUrl, account.userId);
			if (binding !== null) try {
				await this.#client(account.apiBaseUrl).revokeConnector(account.accessToken, binding.connectorId);
			} catch (error) {
				if (!(error instanceof Error && "status" in error && error.status === 404)) {
					await this.supervisor.stop().catch(() => void 0);
					throw new Error(`撤销设备凭据失败，未清理本地凭据：${errorMessage(error)}`);
				}
			}
		}
		await this.supervisor.stop().catch(() => void 0);
		if (account !== null) {
			await clearBinding(dataDir, account.apiBaseUrl, account.userId);
			await clearPendingRegistration(dataDir, account.apiBaseUrl, account.userId).catch(() => void 0);
		}
		await clearAccount(dataDir);
		await clearPendingFlow(dataDir).catch(() => void 0);
		this.#lastAccount = null;
		this.#lastBinding = null;
		this.#credentialProblem = null;
		this.#authHealAttempts = 0;
	}
	async #loopbackLogin(client, apiBaseUrl, options) {
		const dataDir = this.dataDir;
		let settle = null;
		const result = new Promise((resolve, reject) => {
			settle = {
				resolve,
				reject
			};
		});
		const flow = new LoopbackOAuthFlow({
			webOrigin: webOrigin(apiBaseUrl) ?? apiBaseUrl,
			logger: this.#logger,
			onAuthorized: (code, { verifier, redirectUri }) => {
				client.exchangeAuthorizationCode({
					code,
					verifier,
					redirectUri,
					...options.signal !== void 0 ? { signal: options.signal } : {}
				}).then((token) => settle?.resolve(token)).catch((error) => settle?.reject(toError(error)));
			},
			onFailed: (error) => settle?.reject(error)
		});
		let started;
		try {
			started = await flow.start();
		} catch (error) {
			throw new LoopbackFlowError(LOOPBACK_UNAVAILABLE_CODE, `回环登录监听无法启动：${errorMessage(error)}`);
		}
		await savePendingFlow(dataDir, {
			version: 1,
			apiBaseUrl,
			state: started.state,
			verifier: flow.verifier,
			redirectUri: started.redirectUri,
			createdAt: this.#now(),
			deadline: started.deadline
		}).catch(() => void 0);
		try {
			await options.onAuthorizationUrl?.(started.authorizationUrl, {
				deadline: started.deadline,
				redirectUri: started.redirectUri
			});
		} catch (error) {
			this.#logger.warn("登录提示写入失败，请使用日志中的授权地址", { error: errorName(error) });
		}
		const onAbort = () => {
			flow.abort("login cancelled");
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (await this.#openUrl(started.authorizationUrl) === "failed") this.#logger.info("未能自动打开浏览器（fail-soft，不影响登录）：请手动复制上面的授权地址到浏览器打开。");
			return await result;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			await flow.close().catch(() => void 0);
		}
	}
	/**
	* The device-credential gate: **verify → heal → (only if needed) register**.
	*
	* The whole exchange runs under a cross-process lock (see `file-lock.ts`) and
	* re-reads the binding *inside* it, so a hot reload, a second OpenCode
	* instance, or a concurrently finishing login can never interleave a
	* registration with a rotation and leave the disk holding a token the server
	* has already replaced. Registration itself persists its installation key
	* before the request (`pending.json`), so a lost response is retried against
	* the same device instead of creating a second one.
	*/
	async #ensureBinding(client, account) {
		const dataDir = this.dataDir;
		return await withFileLock(`${bindingPath(dataDir, account.apiBaseUrl, account.userId)}.lock`, async () => {
			const existing = await readBinding(dataDir, account.apiBaseUrl, account.userId);
			if (existing !== null) {
				const verdict = await this.#credentialVerdict(client, existing);
				if (verdict === "valid") {
					this.#credentialProblem = null;
					return existing;
				}
				if (verdict === "unknown") return existing;
				this.#logger.warn("已存设备凭据被服务端拒绝（401），按服务端轮换同一设备", { connectorId: existing.connectorId });
				const rotated = await this.#rotateBinding(client, account, existing);
				if (rotated !== null) return rotated;
			}
			return await this.#registerBinding(client, account, existing);
		}, { onTimeout: (waitedMs) => this.#logger.warn("设备凭据锁等待超时，继续执行（多实例可能竞争，落盘仍是原子的）", { waitedMs }) });
	}
	/**
	* Ask the server whether the stored device token is still current.
	* `unknown` (unreachable server, timeout, or an older server without the
	* route) must never cause a rotation — only a definitive 401/403 does.
	*/
	async #credentialVerdict(client, binding) {
		try {
			return await client.verifyConnectorToken(binding.connectorId, binding.connectorToken) ? "valid" : "invalid";
		} catch (error) {
			this.#logger.warn("无法校验设备凭据，按“未验证”处理（不轮换）", {
				error: errorName(error),
				connectorId: binding.connectorId
			});
			return "unknown";
		}
	}
	/** Rotate the token of the **same** device; `null` when the device row is gone. */
	async #rotateBinding(client, account, existing) {
		let rotated;
		try {
			rotated = await client.revokeConnector(account.accessToken, existing.connectorId);
		} catch (error) {
			if (isStatus(error, 404)) return null;
			throw error;
		}
		if (rotated.device.userId !== account.userId) throw new Error("设备归属与当前账号不一致。");
		const binding = {
			...existing,
			connectorToken: rotated.connectorToken,
			name: rotated.device.name
		};
		await saveBinding(this.dataDir, account.apiBaseUrl, account.userId, binding);
		this.#logger.info("设备凭据已轮换，并按服务端返回值原子落盘", { connectorId: binding.connectorId });
		this.#credentialProblem = null;
		return binding;
	}
	/**
	* Register a device for this account, idempotently:
	*   - the installation key is written to `…pending.json` **before** the POST,
	*     so even a lost response can be retried without creating a second device;
	*   - an existing binding (or a pending record) supplies the key and the name;
	*   - 409 (the installation was deleted server-side, tombstone still present)
	*     retries exactly once with a fresh key — deliberately, never silently
	*     reviving a deleted identity.
	*/
	async #registerBinding(client, account, existing) {
		const dataDir = this.dataDir;
		const pending = await readPendingRegistration(dataDir, account.apiBaseUrl, account.userId).catch(() => null);
		const name = existing?.name ?? pending?.name ?? this.#deviceName();
		let installationId = existing?.installationId ?? pending?.installationId ?? randomUUID();
		await savePendingRegistration(dataDir, account.apiBaseUrl, account.userId, {
			version: 1,
			installationId,
			name,
			createdAt: this.#now()
		});
		try {
			return await this.#registerOnce(client, account, name, installationId);
		} catch (error) {
			if (!isStatus(error, 409)) throw error;
			installationId = randomUUID();
			await savePendingRegistration(dataDir, account.apiBaseUrl, account.userId, {
				version: 1,
				installationId,
				name,
				createdAt: this.#now()
			});
			return await this.#registerOnce(client, account, name, installationId);
		}
	}
	async #registerOnce(client, account, name, installationId) {
		const created = await client.registerConnector(account.accessToken, {
			name,
			installationId
		});
		if (created.device.userId !== account.userId) throw new Error("注册设备的账号不一致。");
		const binding = {
			version: 1,
			connectorId: created.device.id,
			connectorToken: created.connectorToken,
			name: created.device.name,
			installationId
		};
		await saveBinding(this.dataDir, account.apiBaseUrl, account.userId, binding);
		await clearPendingRegistration(this.dataDir, account.apiBaseUrl, account.userId).catch(() => void 0);
		this.#logger.info("设备已注册，凭据按服务端返回值原子落盘", { connectorId: binding.connectorId });
		this.#credentialProblem = null;
		return binding;
	}
	/**
	* The 401 must never stay a silent `offline`: log the actionable sentence,
	* write it to `login.json`, expose it in `status()`, and attempt one bounded
	* automatic repair (rotate/register + restart the Connector with the new
	* token). After `MAX_AUTH_HEAL_ATTEMPTS` the plugin only reports.
	*/
	#handleSupervisorState(state) {
		if (!state.authFailed) return;
		const problem = credentialRejectedInstruction();
		this.#credentialProblem = problem;
		this.#logger.warn(problem, { connectorId: this.#lastBinding?.connectorId ?? null });
		this.#recordCredentialFailure(problem);
		if (this.#authHealRunning || this.#authHealAttempts >= MAX_AUTH_HEAL_ATTEMPTS) return;
		this.#authHealRunning = true;
		this.#healAfterAuthFailure().catch((error) => {
			this.#logger.warn("自动修复设备凭据失败，连接保持离线（见 login.json 的下一步）", { error: errorName(error) });
		}).finally(() => {
			this.#authHealRunning = false;
		});
	}
	async #recordCredentialFailure(problem) {
		const now = this.#now();
		await writeLoginPrompt(this.dataDir, {
			version: 1,
			status: "failed",
			kind: this.#lastLoginKind,
			createdAt: now,
			expiresAt: now,
			instruction: problem
		}).catch(() => void 0);
	}
	async #healAfterAuthFailure() {
		const account = this.#lastAccount;
		if (account === null) return;
		this.#authHealAttempts += 1;
		const before = this.#lastBinding;
		const healed = await this.#ensureBinding(this.#client(account.apiBaseUrl), account);
		if (!(before === null || healed.connectorToken !== before.connectorToken || healed.connectorId !== before.connectorId)) {
			this.#logger.warn("自动修复后凭据未变化，401 仍在；请运行 /aa-login 重新登录");
			return;
		}
		this.#lastBinding = healed;
		this.#credentialProblem = null;
		await this.#recordCredentialRecovered();
		this.#logger.info("设备凭据已自动修复，正在用新凭据重启 Connector", { connectorId: healed.connectorId });
		await this.supervisor.start({
			apiBaseUrl: account.apiBaseUrl,
			connectorId: healed.connectorId,
			connectorToken: healed.connectorToken,
			dataDir: join(this.dataDir, "connector")
		});
	}
	/** Replace the failure record once the automatic repair actually succeeded. */
	async #recordCredentialRecovered() {
		const now = this.#now();
		await writeLoginPrompt(this.dataDir, {
			version: 1,
			status: "connected",
			kind: this.#lastLoginKind,
			createdAt: now,
			expiresAt: now,
			instruction: "设备凭据已自动修复并已用新凭据重启 Connector，无需其他操作。"
		}).catch(() => void 0);
	}
	/**
	* The device token baked into `connector/connector.json` — i.e. what the
	* running/adopted Connector tree was launched with. `null` when the file is
	* missing, belongs to another device, or is unreadable: an uncertain
	* comparison must never stop a healthy child.
	*/
	async #connectorConfigToken(connectorDir, connectorId) {
		const value = await readJsonFile(join(connectorDir, "connector.json")).catch(() => null);
		if (value === null || value.connectorId !== connectorId) return null;
		return typeof value.connectorToken === "string" && value.connectorToken.length > 0 ? value.connectorToken : null;
	}
	async #startConnector(account, binding, _resume) {
		this.#lastAccount = account;
		this.#lastBinding = binding;
		const connectorDir = join(this.dataDir, "connector");
		const own = await probeOwnConnector({
			dataDir: connectorDir,
			connectorId: binding.connectorId
		}).catch(() => ({
			own: false,
			pid: null,
			reason: "自己的 Connector 记录读取失败，按未运行处理"
		}));
		if (own.own) {
			const configToken = await this.#connectorConfigToken(connectorDir, binding.connectorId);
			if (configToken === null || configToken === binding.connectorToken) {
				this.#logger.info("本插件启动的 Connector 已在运行，复用而不重复 spawn", {
					pid: own.pid,
					reason: own.reason
				});
				return true;
			}
			this.#logger.warn("本插件启动的 Connector 仍在使用旧设备凭据（会 401），先停止并改用当前凭据重启", { pid: own.pid });
			if (own.pid !== null) this.#stopOwnConnector(own.pid);
			await clearOwnChild(connectorDir, own.pid ?? void 0).catch(() => void 0);
		}
		const foreign = await probeForeignBlock({
			dataDir: connectorDir,
			connectorId: binding.connectorId
		}).catch(() => ({
			blocked: false,
			kind: null,
			pid: null,
			reason: "占用记录读取失败，按可重试处理"
		}));
		if (foreign.blocked) {
			this.#logger.warn("本机 Connector 租约仍被其它来源占用，跳过 spawn（重复 spawn 只会失败）", {
				kind: foreign.kind,
				pid: foreign.pid,
				reason: foreign.reason
			});
			return true;
		}
		const probe = await this.#probeConnector(binding.connectorId).catch(() => ({
			decision: "none",
			reason: "探测失败，按新建处理",
			kind: null,
			pid: null
		}));
		let ownConnector = false;
		if (probe.decision === "reuse") {
			const gate = await this.#reuseGate(account, binding.connectorId);
			if (gate.reuse) {
				this.#logger.info("复用本机已有的 Connector，跳过 spawn", {
					reason: probe.reason,
					pid: probe.pid,
					kind: probe.kind,
					capability: gate.reason
				});
				return true;
			}
			ownConnector = true;
			this.#logger.warn(gate.reason);
		} else if (probe.decision === "occupied") this.#logger.warn("本机 Connector 已被其它来源占用，尝试复用其连接而非新建", {
			reason: probe.reason,
			pid: probe.pid,
			kind: probe.kind
		});
		else this.#logger.info("本机无可复用 Connector，新建一个", { reason: probe.reason });
		const config = {
			apiBaseUrl: account.apiBaseUrl,
			connectorId: binding.connectorId,
			connectorToken: binding.connectorToken,
			dataDir: join(this.dataDir, "connector")
		};
		return await this.#spawnAndRecord(config, binding.connectorId, ownConnector);
	}
	/**
	* `{reuse:false}` carries the **actionable reason we are not reusing**, so the
	* caller can log it verbatim (why + what to do about it).
	*/
	async #reuseGate(account, connectorId) {
		if (this.#forceReuseConnector) {
			this.#logger.info("强制复用已启用（forceReuseConnector），跳过能力判定", { connectorId });
			return {
				reuse: true,
				reason: "显式配置要求复用"
			};
		}
		const capability = await this.#probeConnectorCapability({
			account,
			connectorId
		}).catch(() => judgeConnectorCapability({
			runtimeTypes: null,
			error: "能力判定探测本身抛出异常"
		}));
		if (capability.verdict === "reuse") return {
			reuse: true,
			reason: capability.reason
		};
		return {
			reuse: false,
			reason: `不复用本机已有的 Connector：${capability.reason}。下一步：改用本插件自带的 Connector（解析顺序：包内 ${BUNDLED_CONNECTOR_SUBDIR} → 同级 connector/）；若确认那个 Connector 就是可用版本，可设置 options.forceReuseConnector = true（或 ${FORCE_REUSE_CONNECTOR_ENV}=1）强制复用。`
		};
	}
	async #spawnAndRecord(config, connectorId, ownConnector = false) {
		const reused = runtimeMentionsConnector(ownConnector ? null : await readConnectorRuntime(this.#env).catch(() => null), connectorId);
		await this.supervisor.prepare();
		try {
			await this.supervisor.start(config);
		} catch (error) {
			if (error instanceof ConnectorOwnershipError || error.code === "connector_already_running") {
				const owner = error instanceof ConnectorOwnershipError ? error.owner : {
					kind: null,
					pid: null
				};
				await setBlocked(join(this.dataDir, "connector"), {
					kind: owner.kind,
					pid: owner.pid,
					connectorId,
					at: Date.now()
				}).catch(() => void 0);
			}
			throw error;
		}
		return reused;
	}
	#client(apiBaseUrl) {
		return new AccountClient({
			apiBaseUrl,
			...this.#fetcher !== void 0 ? { fetcher: this.#fetcher } : {}
		});
	}
};
function defaultDeviceName() {
	const host = hostname();
	return host.length > 0 ? `OpenCode (${host})` : "OpenCode";
}
/**
* Wrap an injected opener so a rejecting implementation is fail-soft too: the
* three login paths must behave identically whether the real launcher or a test
* double is in place.
*/
function wrapOpener(opener) {
	return async (url) => {
		try {
			await opener(url);
			return "opened";
		} catch {
			return "failed";
		}
	};
}
function isStatus(error, status) {
	return error instanceof Error && "status" in error && error.status === status;
}
function errorName(error) {
	return error instanceof Error ? error.name : typeof error;
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function errorCode(error) {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = error.code;
		if (typeof code === "string") return code;
	}
	return "login_failed";
}
function toError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
/** Process-wide onboarding handle, adopted across hot reloads like the Hub. */
const ONBOARDING_GLOBAL_KEY = "agents-anywhere.opencode.onboarding";
/**
* Adopt the process-wide `Onboarding`. A hot reload (or a second location's
* `setup()`) must reuse the existing supervisor: spawning a second Connector
* would only burn a `uv` process against the machine-wide OS lease.
*/
function installOnboarding(options = {}) {
	const key = Symbol.for(ONBOARDING_GLOBAL_KEY);
	const globals = globalThis;
	const existing = globals[key];
	if (isOnboardingLike(existing)) return existing;
	const created = new Onboarding(options);
	globals[key] = created;
	return created;
}
/** Does `value` already carry the singleton surface, whatever its class identity? */
function isOnboardingLike(value) {
	if (value === null || typeof value !== "object") return false;
	const candidate = value;
	return typeof candidate.resume === "function" && typeof candidate.status === "function" && "supervisor" in candidate;
}
//#endregion
//#region src/server/index.ts
/**
* OpenCode **service** plugin entry point.
*
* The host contract is proven by measurement (P0 spike, opencode-cli 2.0.18):
* `export default` MUST be an object carrying `id` plus a `setup` (or `effect`)
* function — the V1 `export const X = async (input) => ({ hooks })` shape fails
* to load with `Plugin must export a default definition with an id and an effect
* or setup function`. `setup()`'s return value is treated as the cleanup.
*
* Wiring (design §5.1, ordered):
*   0. `AGENT_AA_CLEANUP` set → run the explicit uninstall path and stop; no hub,
*      no connection (audit M3);
*   1. `installPlugin(ctx)` — adopt/create the process-wide Bridge Hub and
*      publish the loopback endpoint (so a Connector has something to attach to);
*   2. `registerCommands(ctx.command, …)` — `/aa-login` `/aa-status` `/aa-logout`
*      in the command palette. This is an **additional** trigger, never the only
*      one: the same flows are what the automatic path below calls, so both
*      surfaces share one implementation (`command-flows.ts`);
*   3. `installOnboarding(ctx.options)` — reuse-first credential check; when
*      effective credentials and a device binding already exist it reuses an
*      existing machine-wide Connector **only if that Connector advertises the
*      `opencode` runtime** (task B, `connector-capability.ts`) or spawns one
*      with **zero login**;
*   4. `needs_login` → one actionable line, then the login starts **by itself**:
*      loopback OAuth + system browser on a graphical machine, device code on a
*      headless/remote one, both writing the URL / short code to `login.json`
*      and to the log. Nothing here needs an environment variable; the switch to
*      turn it off is the plugin's own config (`options.autoLogin = false`, or
*      `AGENT_AA_AUTO_LOGIN=0` for a headless/shell install).
*
* The Connector is deliberately **not** stopped when this plugin instance is
* released: it is a machine-wide singleton guarded by the Connector's own OS
* lease and outlives any single OpenCode process (design §1.1, §4.1).
*/
const id = "agents-anywhere-opencode";
const NOOP_CLEANUP = () => void 0;
const logger = createLogger("plugin");
/**
* The one `Onboarding` this process uses. `installOnboarding` is a global
* singleton, so the palette commands and the automatic trigger always hold the
* *same* instance — there is no second copy of the login flow anywhere.
*/
function sharedOnboarding(ctx) {
	const options = resolvePluginOptions(ctx.options, process.env);
	return installOnboarding({
		logger: createLogger("onboarding"),
		serverUrl: options.serverUrl,
		connectorSource: options.connectorSource,
		forceReuseConnector: options.forceReuseConnector
	});
}
/** Host version + version gate + present surfaces, for `aa-status`. */
function hostSummary(ctx) {
	const version = readServiceVersion(ctx) ?? null;
	return {
		version,
		supported: evaluateHostVersion(version ?? void 0).supported,
		capabilities: summarizeHostSurface(ctx)
	};
}
const plugin = {
	id,
	async setup(ctx) {
		const env = process.env;
		const options = resolvePluginOptions(ctx.options, env);
		if (cleanupRequested(env)) {
			try {
				const result = await runCleanup({ env });
				logger.warn("AGENT_AA_CLEANUP：已完成本地清理，本次不建立远端连接", {
					removedPluginData: result.removedPluginData,
					removedBridgeDir: result.removedBridgeDir,
					stoppedConnector: result.stoppedConnectorPid !== null
				});
			} catch (error) {
				logger.warn("清理失败，本地状态未完全删除", { error: error instanceof Error ? error.name : typeof error });
			}
			return NOOP_CLEANUP;
		}
		let releaseHub = NOOP_CLEANUP;
		try {
			releaseHub = await installPlugin(ctx);
		} catch (error) {
			logger.warn("bridge hub setup failed; remote access disabled for this process", { error: error instanceof Error ? error.name : typeof error });
			return NOOP_CLEANUP;
		}
		registerCommands(ctx.command, createCommandEntries(createCommandFlows({
			onboarding: () => sharedOnboarding(ctx),
			env,
			logger,
			forcedMode: options.loginMode,
			host: () => hostSummary(ctx)
		})), { logger });
		try {
			const onboarding = sharedOnboarding(ctx);
			const stage = await onboarding.resume();
			if (stage.stage === "needs_login") {
				logger.warn(needsLoginStateLine(stage, {
					autoLogin: options.autoLogin,
					autoLoginSource: options.source.autoLogin
				}));
				if (options.autoLogin) runSetupLogin({
					login: (loginOptions) => onboarding.login(loginOptions),
					dataDir: onboarding.dataDir,
					env,
					forcedMode: options.loginMode
				});
				else logger.warn(autoLoginDisabledStateLine({
					autoLogin: options.autoLogin,
					autoLoginSource: options.source.autoLogin
				}));
			} else if (stage.stage === "disabled") logger.warn(disabledStateLine(stage));
			else logger.info(connectedStateLine(stage, {
				loginMode: null,
				fellBack: false
			}));
		} catch (error) {
			logger.warn("onboarding resume failed; login stays pending", { error: error instanceof Error ? error.name : typeof error });
		}
		return async () => {
			try {
				await releaseHub();
			} catch {}
		};
	}
};
//#endregion
export { plugin as default, id, runSetupLogin };

//# sourceMappingURL=index.js.map