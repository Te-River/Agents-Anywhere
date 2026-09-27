import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, existsSync, promises } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
Object.values({
	initialize: "initialize",
	ping: "ping",
	runtimeGetCapabilities: "runtime.getCapabilities",
	sessionList: "session.list",
	sessionGetSnapshot: "session.getSnapshot",
	sessionGetState: "session.getState",
	sessionGetNotices: "session.getNotices",
	runtimeSyncSubscribe: "runtime.sync.subscribe",
	runtimeSyncAck: "runtime.sync.ack"
});
Object.values({
	sessionCreateAndStart: "session.createAndStart",
	sessionStartTurn: "session.startTurn",
	sessionSteerTurn: "session.steerTurn",
	sessionInterrupt: "session.interrupt",
	sessionUpdateSelections: "session.updateSelections",
	sessionRespondInteraction: "session.respondInteraction"
});
Object.values({
	listModels: "catalog.listModels",
	listPermissions: "catalog.listPermissions",
	/**
	* Agent directory (D3). `params {}` → `{ agents: [{ id, name?, description?,
	* mode, hidden }] }`, `mode ∈ {"primary","subagent","all"}`. Served from
	* `ctx.agent` when the host exposes it; otherwise answered
	* `UNSUPPORTED_OPERATION` like every other known-but-unserved method.
	*/
	listAgents: "catalog.listAgents"
});
//#endregion
//#region src/shared/endpoint-store.ts
const DATA_DIR_ENV = "AGENT_CONNECTOR_DATA_DIR";
const DATA_DIR_NAME = ".agents-anywhere";
const BRIDGE_DIR_NAME = "opencode-bridge";
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
/** `null` for a missing, malformed or unreadable record — never throws. */
async function readLoginPrompt(dataDir) {
	let value;
	try {
		value = await readJsonFile(loginPromptPath(dataDir));
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object") return null;
	if (value.status !== "pending" && value.status !== "connected" && value.status !== "failed") return null;
	if (value.kind !== "device" && value.kind !== "loopback") return null;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
	if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
	const prompt = {
		version: 1,
		status: value.status,
		kind: value.kind,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
		instruction: typeof value.instruction === "string" ? value.instruction : ""
	};
	if (typeof value.authorizationUrl === "string") prompt.authorizationUrl = value.authorizationUrl;
	if (typeof value.verificationUri === "string") prompt.verificationUri = value.verificationUri;
	if (typeof value.verificationUriComplete === "string") prompt.verificationUriComplete = value.verificationUriComplete;
	if (typeof value.userCode === "string") prompt.userCode = value.userCode;
	return prompt;
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
/** Server address; the same name the Connector and the Docker images use. */
const SERVER_URL_ENV = "AGENT_SERVER_URL";
/**
* Advanced escape hatch (task B): reuse whatever Connector is already running
* even though its advertised runtime types do not include `opencode`. Default
* (`false`) is the safe direction: an unrecognised Connector is not reused.
* Keep in sync with `server/onboarding.ts` (which logs this name).
*/
const FORCE_REUSE_CONNECTOR_ENV = "AGENT_AA_FORCE_REUSE_CONNECTOR";
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
		const appData = nonEmpty$1(env["APPDATA"]);
		return appData === null ? [] : [join(appData, DESKTOP_APP_DIR_NAME)];
	}
	if (platform$1 === "darwin") return [join(homedir(), "Library", "Application Support", DESKTOP_APP_DIR_NAME)];
	if (platform$1 === "linux") {
		const xdg = nonEmpty$1(env["XDG_CONFIG_HOME"]);
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
	return typeof cursor === "string" ? nonEmpty$1(cursor) : null;
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
function nonEmpty$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
//#endregion
//#region src/shared/session-index.ts
/**
* TUI → Hub session index channel.
*
* Measured (spike 02 §3.1–§3.4): the runtime's global event stream and
* `ctx.session` expose **no** parent/child linkage — the runtime `session.created`
* payload has no `info`, `ctx.session.get` returns no `parentID`, and the SDK's
* `GET /session/{id}/children` is 404 on this build. The one surface whose
* *published type* does carry the relation is the **TUI host SDK client**
* (`api.client`, i.e. `OpencodeClient.session.list`, whose v2 `Session` type has
* `parentID?: string` — `@opencode-ai/sdk/v2` `types.gen.d.ts`). So:
*
* - the **TUI plugin** enumerates sessions through that client and publishes what
*   it actually received to a JSON file, written atomically;
* - the **Hub** reads that file (fail-soft) to learn which sessions are children.
*
* The channel is best-effort by construction and never invents data:
*
* - the TUI may not be running (headless hosts) → the file is absent or stale and
*   the Hub downgrades to `parentRelation: "unavailable"`;
* - the runtime may or may not return `parentID` in `session.list` → the TUI
*   writes only the fields it received; a session with no `parentID` is written
*   without one;
* - the file is only trusted while **fresh** (`SessionIndex.state === 'fresh'`),
*   so a crashed TUI cannot leave the Hub advertising a relation it can no longer
*   refresh.
*
* Nothing here reads OpenCode's SQLite store: `session_v2.parent_id` was
* deliberately not chosen (user decision).
*/
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
/**
* Extract the session list from a TUI client result. The SDK's `session.list`
* resolves to `{ data, error }`; a bare array is also accepted (older/other
* call shapes). `null` means "shape not recognised" — the caller must then keep
* the previous index instead of overwriting it with an empty one.
*/
function collectIndexedSessions(payload) {
	const data = Array.isArray(payload) ? payload : payload !== null && typeof payload === "object" && Array.isArray(payload.data) ? payload.data : null;
	if (data === null) return null;
	const sessions = [];
	for (const entry of data) {
		const session = toIndexedSession(entry);
		if (session !== null) sessions.push(session);
	}
	return sessions;
}
/**
* Write the index atomically (tmp → fsync → rename): a reader sees either the
* previous complete file or the new complete file, never a partial write.
*/
async function writeSessionIndexFile(targetPath, sessions, now = /* @__PURE__ */ new Date()) {
	const snapshot = {
		updatedAt: now.toISOString(),
		sessions: [...sessions]
	};
	const directory = dirname(targetPath);
	await promises.mkdir(directory, {
		recursive: true,
		mode: 448
	});
	const tmp = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const handle = await promises.open(tmp, "w", 384);
	try {
		await handle.writeFile(JSON.stringify(snapshot), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await promises.rename(tmp, targetPath);
	} catch (error) {
		await promises.rm(tmp, { force: true }).catch(() => void 0);
		throw error;
	}
	return snapshot;
}
/**
* `writeSessionIndexFile` on the resolved path, swallow-on-failure. Returns
* whether the file was published; the TUI must never abort on a failed publish.
*/
async function writeSessionIndex(sessions, options = {}) {
	try {
		await writeSessionIndexFile(options.path ?? sessionIndexPath(), sessions, options.now ?? /* @__PURE__ */ new Date());
		return true;
	} catch {
		return false;
	}
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
		await delay$1(pollMs);
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
function delay$1(ms) {
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
const CONNECTOR_SOURCE_ENV = "AGENT_CONNECTOR_SOURCE";
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
		const explicit = this.#sourceDir ?? nonEmpty(this.#env["AGENT_CONNECTOR_SOURCE"]);
		if (explicit !== void 0) return [explicit];
		return [join(this.#packageDir, BUNDLED_CONNECTOR_SUBDIR), join(dirname(this.#packageDir), "connector")];
	}
	async resolveUv() {
		const command = this.#uvPath ?? nonEmpty(this.#env["AGENT_CONNECTOR_UV"]) ?? "uv";
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
		if (!found) throw new ConnectorSourceError(`未找到 Connector 源码。本插件包内应自带 ${BUNDLED_CONNECTOR_SUBDIR}（随包分发，安装包损坏或版本不对时会缺失）；也可设置 ${CONNECTOR_SOURCE_ENV} 指向包含 pyproject.toml 与 connector/cli.py 的目录，或把本仓库的 connector/ 放在插件包同级。已尝试：${candidates.join(", ")}。`);
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
		if (sourceDir === null) throw new ConnectorSourceError(`未找到 Connector 源码。请设置 ${CONNECTOR_SOURCE_ENV}，或安装自带 ${BUNDLED_CONNECTOR_SUBDIR} 的正式插件包（开发期可用同级 connector/）。`);
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
		await Promise.race([ended, delay(1e3)]);
		if (!this.#closed.has(child)) this.#terminate(child, false);
		await Promise.race([ended, delay(3e3)]);
		if (!this.#closed.has(child)) this.#terminate(child, true);
		await Promise.race([ended, delay(5e3)]);
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
function nonEmpty(value) {
	return value !== void 0 && value.trim().length > 0 ? value.trim() : void 0;
}
function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
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
		this.#server = createServer((request, response) => {
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
//#endregion
//#region src/tui/index.ts
/**
* OpenCode **TUI** plugin entry point — a **status surface**, not a command surface.
*
* Measured against opencode-cli **2.0.18** (A10 PTY probe:
* `.git/opencode-team/20260926-213919/opencode-tui-pty/01-implementer-tui-pty-verification.md`):
*
* - The **full** TUI (`opencode`, bare/`--standalone`) DOES evaluate this module and
*   call `setup()` (`module-evaluated` + `setup-called` in `tui-probe.log`, §3).
* - `opencode mini` does **NOT** load the TUI plugin at all (§3: probe log empty).
* - The module shape the host validator accepts is ONLY `{ id: string, setup: fn }` (§A10).
* - The real TUI context exposes 13 top-level keys (§4):
*   `options, location, app, renderer, client, data, attention, theme,
*    themeMode, markdown, keymap, storage, ui`.
*
* Surfaces we therefore use — every one probed, never assumed:
*   - `ui.toast`         → user-visible status text (§4: `ui` = dialog, toast,
*                          format, router, panel, tabs, model, slot).
*   - `attention.notify` → optional desktop ping (§4: `attention` = notify, dispose).
*   - `keymap.layer`     → the ONLY member that *could* carry a command layer
*                          (§4: `keymap` = layer, dispatch, shortcuts, commands,
*                          pending, active, mode). Its writability and exact
*                          argument shape are **UNVERIFIED on a real terminal**;
*                          the call is guarded and any failure degrades silently
*                          to `'none'` (see `registerCommandLayer`).
*   - `client.session.list` → the session-index side channel (unchanged; its own
*                          file documents why it is the only parent/child source).
*   - `login.json`       → polled on a timer (`startLoginStateWatcher`) so a login
*                          started on the *server* side is visible here too: each
*                          state change becomes one actionable toast (defect ②).
*                          No host surface is required for this and none is
*                          disturbed (the timer is unref'd and stopped on dispose).
*
* Surfaces we deliberately do NOT touch (measured absent, or JSX-only):
*   - `keymap.registerLayer` and `command.register` — the previous calls were
*     **silent no-ops**: `keymap` has no `registerLayer`, and there is **no
*     `command` key at all** in the real context (§4). Both calls are removed.
*   - `ui.DialogAlert` / `ui.DialogPrompt` / `ui.dialog.replace` — **not** in the
*     real `ui` member set (§4), so no dialog path exists here any more.
*   - `route` / `slots` / `lifecycle` / `kv` — absent from the real context (§4);
*     `lifecycle.onDispose` is unnecessary because the host calls the dispose
*     handle `setup()` returns (p0/01 §6: hot reload replays `setup()` and calls
*     the old instance's cleanup).
*   - `markdown.registerCodeBlockRenderer` / `ui.slot` / `ui.panel` — present but
*     **JSX-only**: authoring them needs a JSX runtime this zero-dependency module
*     does not ship. Reported by `describeSurfaces`, never registered.
*
* NOT DONE (cannot be faked without dependencies — listed, not hidden):
*   - JSX panels/slots and the markdown code-block renderer.
*   - A `/aa` slash command: on 2.0.18 there is **no command-registration surface**
*     (§5: the `/` palette lists only built-ins; `/aa` never appears), so no such
*     command exists for the user. Login's primary triggers live on the **server
*     side** — the `/aa-login` command and the missing-credential auto-trigger —
*     and this module only *tells* the user to run that command.
*
* `setup()` never throws: a context missing every surface still returns a working
* dispose handle, and the host's plugin chain is never disturbed.
*/
const id = "agents-anywhere-opencode";
const PLUGIN_LABEL = "Agents Anywhere";
/** The server-side command that actually starts login (this module cannot register one). */
const LOGIN_COMMAND = "/aa-login";
/** One active Onboarding per host API instance (hot reload creates a new api). */
const instances = /* @__PURE__ */ new WeakMap();
function onboardingFor(api) {
	const existing = instances.get(api);
	if (existing !== void 0) return existing;
	const created = new Onboarding({ logger: createLogger("tui") });
	instances.set(api, created);
	return created;
}
/**
* Probe which surfaces the live context exposes. `usable` are the members we may
* call; `jsxOnly` are members that exist yet require a JSX renderer this
* zero-dependency module cannot author. Exported so tests and the A10 self-check
* log can see the *real* surface (A10 measured `ui` + `attention` usable, with no
* command surface at all).
*/
function describeSurfaces(api) {
	const usable = [];
	if (typeof api.ui?.toast === "function") usable.push("ui.toast");
	if (typeof api.attention?.notify === "function") usable.push("attention.notify");
	if (typeof api.keymap?.layer === "function") usable.push("keymap.layer");
	const jsxOnly = [];
	if (typeof api.ui?.slot !== "undefined") jsxOnly.push("ui.slot");
	if (typeof api.ui?.panel !== "undefined") jsxOnly.push("ui.panel");
	if (typeof api.markdown?.registerCodeBlockRenderer === "function") jsxOnly.push("markdown.registerCodeBlockRenderer");
	if (typeof api.route?.register === "function") jsxOnly.push("route");
	if (typeof api.slots?.register === "function") jsxOnly.push("slots");
	return {
		usable,
		jsxOnly
	};
}
/**
* Publish the session index once from the host client.
*
* `session.list({ roots: false })` asks for **all** sessions (a root-only list
* would hide exactly the children we need). Only what the client actually
* returned is written: a `parentID` the runtime did not send is never invented,
* and an unrecognised payload shape leaves the previous index untouched rather
* than clobbering it with an empty list. Returns whether a snapshot was written;
* never throws.
*/
async function publishSessionIndexOnce(api, options = {}) {
	const sessionApi = api.client?.session;
	const list = sessionApi?.list;
	if (sessionApi === void 0 || typeof list !== "function") return false;
	let payload;
	try {
		payload = await list.call(sessionApi, { roots: false });
	} catch {
		return false;
	}
	const sessions = collectIndexedSessions(payload);
	if (sessions === null) return false;
	return writeSessionIndex(sessions, options.path !== void 0 ? { path: options.path } : {});
}
/**
* Keep the session index fresh while the TUI is loaded: publish once at
* `setup`, then on an interval. Returns the **async** stop handle the host
* dispose awaits.
*
* Stopping is a two-step contract: `stop()` first blocks new ticks (`stopped` +
* `clearInterval`), then **drains every publish already in flight**. Once
* `await stop()` resolves no further write can land. Without the drain a
* publish that started just before dispose could rename its file into place
* *after* the caller removed the bridge directory — and because
* `writeSessionIndexFile` does `mkdir … { recursive: true }`, that late write
* **re-creates** the directory (a Windows `ENOTEMPTY rmdir`, or a silent
* leftover).
*
* The host may not expose a client at all (headless / different context), in
* which case this is a no-op. The timer is unref'd so the command surface never
* holds the host process open on its own.
*/
function startSessionIndexWriter(api, options = {}) {
	if (typeof api.client?.session?.list !== "function") return async () => void 0;
	let stopped = false;
	const inFlight = /* @__PURE__ */ new Set();
	const tick = () => {
		if (stopped) return;
		const run = publishSessionIndexOnce(api, options.path !== void 0 ? { path: options.path } : {}).then(() => void 0).catch(() => void 0);
		inFlight.add(run);
		run.finally(() => {
			inFlight.delete(run);
		});
	};
	tick();
	const timer = setInterval(tick, options.intervalMs ?? 6e4);
	if (typeof timer.unref === "function") timer.unref();
	options.logger?.debug("session index writer started", { intervalMs: options.intervalMs });
	return async () => {
		stopped = true;
		clearInterval(timer);
		while (inFlight.size > 0) await Promise.all([...inFlight]);
	};
}
/**
* Try to register the `/aa` command family on the **only** member that could
* carry it — `keymap.layer` (A10 §4; `registerLayer` and the `command` domain do
* not exist on 2.0.18, so those calls were removed). `keymap.layer`'s writability
* and argument shape are unverified on a real terminal, so a missing member, a
* wrong shape, or a throw all degrade **silently** to `'none'` — the caller logs
* it, and the host is never disturbed.
*/
function registerCommandLayer(api, commands) {
	const layer = api.keymap?.layer;
	if (typeof layer !== "function") return "none";
	try {
		layer({
			id,
			commands
		});
		return "keymap";
	} catch {
		return "none";
	}
}
/** Build the `/aa` command descriptors (exported for shape tests). */
function aaCommands(api) {
	const run = (sub) => () => dispatch(api, sub);
	return [
		{
			title: `${PLUGIN_LABEL}：状态`,
			value: "agents-anywhere.status",
			description: "查看登录状态与本机设备连接",
			category: PLUGIN_LABEL,
			slash: {
				name: "aa",
				aliases: ["agents-anywhere"]
			},
			onSelect: run("status")
		},
		{
			title: `${PLUGIN_LABEL}：登录`,
			value: "agents-anywhere.login",
			description: "打开浏览器完成账号授权并连接本机设备",
			category: PLUGIN_LABEL,
			slash: {
				name: "login",
				aliases: ["connect"]
			},
			onSelect: run("login")
		},
		{
			title: `${PLUGIN_LABEL}：无头登录`,
			value: "agents-anywhere.login-headless",
			description: "SSH/无头环境：显示短码，在任意设备上批准",
			category: PLUGIN_LABEL,
			slash: { name: "login-headless" },
			onSelect: run("login-headless")
		},
		{
			title: `${PLUGIN_LABEL}：退出登录`,
			value: "agents-anywhere.logout",
			description: "先撤销服务端设备凭据，再清理本地并停止 Connector",
			category: PLUGIN_LABEL,
			slash: { name: "logout" },
			onSelect: run("logout")
		}
	];
}
/**
* The one behaviour that is real on 2.0.18: an **actionable status toast**.
* Exported so tests can await it directly (it reads the credential store).
* Never throws.
*/
async function announceStatus(api) {
	let status;
	try {
		status = await onboardingFor(api).status();
	} catch {
		return;
	}
	const message = status.loggedIn ? `${PLUGIN_LABEL} 已加载：已连接账号 ${status.userId ?? "未知"}，设备 ${status.connectorId ?? "未注册"}。` : `${PLUGIN_LABEL} 已加载：未登录，用服务端命令 ${LOGIN_COMMAND} 连接本机。`;
	toast(api, {
		variant: status.loggedIn ? "success" : "info",
		title: PLUGIN_LABEL,
		message
	});
}
/** How often the TUI re-reads `login.json` while it is loaded. */
const LOGIN_WATCH_INTERVAL_MS = 2e3;
/**
* Identity of a login state *as the user experiences it*: a re-read that
* returns the same record must not produce a second toast (defect ②).
*/
function loginPromptSignature(prompt) {
	if (prompt === null) return "none";
	return `${prompt.status}|${prompt.kind}|${prompt.userCode ?? ""}|${prompt.createdAt}`;
}
/**
* The toast for a *transition*, or `null` when nothing user-visible changed.
* Exported so the mapping is unit-testable without a TUI or a timer.
*/
function loginStateToast(current, previous, path) {
	if (loginPromptSignature(current) === loginPromptSignature(previous)) return null;
	const where = path === void 0 ? "" : `\n登录文件：${path}`;
	if (current === null) return {
		variant: "info",
		title: PLUGIN_LABEL,
		message: `登录状态已清除。需要连接时运行服务端命令 ${LOGIN_COMMAND}。${where}`
	};
	switch (current.status) {
		case "pending": return {
			variant: "warning",
			title: PLUGIN_LABEL,
			message: current.kind === "device" ? `已开始无头登录：在任意设备打开 ${current.verificationUri ?? "(验证地址缺失)"} 并输入短码 ${current.userCode ?? "(短码缺失)"}。${where}` : `已开始登录：在浏览器打开授权地址并点一次「授权」${current.authorizationUrl === void 0 ? "" : `：${current.authorizationUrl}`}${where}`,
			duration: 6e4
		};
		case "connected": return {
			variant: "success",
			title: PLUGIN_LABEL,
			message: `登录成功：账号与本机设备已连接。${where}`
		};
		case "failed": return {
			variant: "error",
			title: PLUGIN_LABEL,
			message: `登录未完成：${current.instruction}\n下一步：重试服务端命令 ${LOGIN_COMMAND}。${where}`
		};
	}
}
/**
* Poll `login.json` and toast each state change (开始登录 / 成功 / 失败). This is
* the only channel the TUI has: on 2.0.18 there is no command-registration
* surface, so a login started from the server side is otherwise invisible here.
*
* The first read only seeds the baseline — a record left over from an earlier
* run must not be announced as if it had just happened. Everything is guarded:
* a failed read, a throwing `ui.toast` or a hostile context is swallowed, the
* timer is unref'd so it never holds the host process open, and dispose stops
* it. Returns the stop handle the host's dispose calls.
*/
function startLoginStateWatcher(api, options = {}) {
	const logger = options.logger ?? createLogger("tui");
	const readPrompt = options.readPrompt ?? readLoginPrompt;
	const dataDir = options.dataDir ?? pluginDataDir();
	let stopped = false;
	let running = false;
	let seeded = false;
	let previous = null;
	const tick = async () => {
		if (stopped || running) return;
		running = true;
		try {
			const current = await readPrompt(dataDir);
			if (stopped) return;
			if (!seeded) {
				seeded = true;
				previous = current;
				return;
			}
			const next = loginStateToast(current, previous, loginPromptPath(dataDir));
			previous = current;
			if (next !== null) toast(api, next);
		} catch (error) {
			logger.debug("登录状态轮询失败（忽略，不影响宿主）", { error: error instanceof Error ? error.name : typeof error });
		} finally {
			running = false;
		}
	};
	tick();
	const timer = setInterval(() => {
		tick();
	}, options.intervalMs ?? 2e3);
	if (typeof timer.unref === "function") timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
/**
* Wire the module into a live TUI context and return its cleanup. Never throws:
* a context missing every surface still returns a working dispose handle, and the
* command registration outcome (`'keymap'` / `'none'`) is only logged.
*/
function tuiPlugin(api) {
	const logger = createLogger("tui");
	try {
		const surfaces = describeSurfaces(api);
		const mode = registerCommandLayer(api, aaCommands(api));
		const stopSessionIndex = startSessionIndexWriter(api, { logger });
		logger.debug("tui plugin ready", {
			commandMode: mode,
			usable: surfaces.usable.join(",") || "none",
			jsxOnly: surfaces.jsxOnly.join(",") || "none",
			apiVersion: api.app?.version ?? "unknown"
		});
		announceStatus(api).catch(() => void 0);
		const stopLoginWatch = startLoginStateWatcher(api, { logger });
		const dispose = () => {
			stopLoginWatch();
			return stopSessionIndex();
		};
		return dispose;
	} catch (error) {
		logger.warn("tui setup failed", { error: error instanceof Error ? error.name : typeof error });
		return () => void 0;
	}
}
/**
* Host entry point. Same body as `tuiPlugin`; named `setup` because that is the
* exact member the 2.0.18 TUI module validator requires.
*/
function setup(context) {
	return tuiPlugin(context);
}
const tuiPluginModule = {
	id,
	setup
};
async function dispatch(api, sub) {
	const onboarding = onboardingFor(api);
	try {
		switch (sub) {
			case "status": return await showStatus(api, onboarding);
			case "login": return await startLogin(api, onboarding, { headless: false });
			case "login-headless": return await startLogin(api, onboarding, { headless: true });
			case "logout": return await logout(api, onboarding);
			default: toast(api, {
				variant: "warning",
				title: PLUGIN_LABEL,
				message: `未知子命令：${sub}`
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		toast(api, {
			variant: "error",
			title: PLUGIN_LABEL,
			message
		});
	}
}
async function showStatus(api, onboarding) {
	const status = await onboarding.status();
	const source = status.apiBaseUrlSource === void 0 ? "" : `（来源：${SERVER_URL_SOURCE_LABEL[status.apiBaseUrlSource]}）`;
	const lines = [
		`服务器：${status.apiBaseUrl ?? "未配置"}${source}`,
		`账号：${status.userId ?? "未登录"}${status.loggedIn ? "" : "（凭据已失效）"}`,
		`设备：${status.connectorId ?? "未注册"}`,
		`Connector：${status.connectorRunning ? "运行中" : "未运行"}`
	];
	if (!status.loggedIn) lines.push("", `在 TUI 里运行服务端命令 ${LOGIN_COMMAND} 连接本机。`);
	toast(api, {
		variant: status.loggedIn ? "success" : "info",
		title: PLUGIN_LABEL,
		message: lines.join("\n")
	});
}
async function startLogin(api, onboarding, options) {
	if (!(await onboarding.status()).configured) {
		toast(api, {
			variant: "warning",
			title: PLUGIN_LABEL,
			message: `尚未配置服务器地址；请先配置插件，再运行服务端命令 ${LOGIN_COMMAND}。`
		});
		return;
	}
	toast(api, {
		variant: "info",
		title: PLUGIN_LABEL,
		message: options.headless ? "正在申请设备码…" : "正在打开浏览器…"
	});
	reportLogin(api, await onboarding.login({
		headless: options.headless,
		onCode: (notice) => announceDeviceCode(api, notice)
	}));
}
function reportLogin(api, outcome) {
	if (outcome.ok) {
		toast(api, {
			variant: "success",
			title: PLUGIN_LABEL,
			message: `已连接 ${outcome.stage.apiBaseUrl}\n账号 ${outcome.stage.userId}\n设备 ${outcome.stage.connectorId}`
		});
		return;
	}
	const hint = outcome.code === "not_configured" ? `\n先运行服务端命令 ${LOGIN_COMMAND}。` : outcome.code === "access_denied" ? "\n你在批准页拒绝了本次请求，可以重试。" : outcome.code === "expired_token" ? `\n设备码已过期，请重新执行 ${LOGIN_COMMAND}。` : "";
	toast(api, {
		variant: "error",
		title: PLUGIN_LABEL,
		message: `${outcome.message}${hint}`
	});
}
async function logout(api, onboarding) {
	await onboarding.logout();
	toast(api, {
		variant: "success",
		title: PLUGIN_LABEL,
		message: "已撤销设备凭据并清理本地登录状态。"
	});
}
/** Show the short code exactly where a headless user will look for it. */
function announceDeviceCode(api, notice) {
	const message = `打开 ${notice.verificationUri}\n输入代码：${notice.userCode}`;
	toast(api, {
		variant: "warning",
		title: PLUGIN_LABEL,
		message,
		duration: 6e4
	});
	ping(api, {
		title: PLUGIN_LABEL,
		message
	});
}
function toast(api, input) {
	try {
		api.ui?.toast?.(input);
	} catch {}
}
/** Optional desktop ping via `attention.notify` (A10 §4). */
function ping(api, input) {
	try {
		api.attention?.notify?.({
			...input,
			sound: "default"
		});
	} catch {}
}
//#endregion
export { LOGIN_WATCH_INTERVAL_MS, aaCommands, announceStatus, tuiPluginModule as default, describeSurfaces, id, loginStateToast, publishSessionIndexOnce, registerCommandLayer, setup, startLoginStateWatcher, startSessionIndexWriter, tuiPlugin };

//# sourceMappingURL=tui.js.map