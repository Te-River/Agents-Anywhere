//#region src/server/opencode-ctx.d.ts
/**
 * Structural types for the OpenCode V2 plugin context.
 *
 * The published `@opencode-ai/plugin` types lag the 2.0.x runtime badly (they
 * lack `ctx.permission` / `ctx.event` / `ctx.rpc` and miss 6 emitted event
 * names), so the plugin declares only the surface it actually touches and
 * probes every member at runtime. Nothing here is imported from the host.
 */
/** Event envelope as measured at runtime (P0 spike, opencode-cli 2.0.18). */
interface OpenCodeEvent {
  id?: string;
  created?: string;
  type?: string;
  durable?: {
    aggregateID?: string;
    seq?: number;
    version?: number;
  };
  location?: {
    directory?: string;
    workspaceID?: string;
  };
  data?: Record<string, unknown>;
}
type OpenCodeEventStream = AsyncIterable<OpenCodeEvent>;
interface PermissionEvaluatePayload {
  sessionID?: string;
  agent?: string;
  action?: string;
  resources?: unknown;
  metadata?: unknown;
  source?: unknown;
  effect?: string;
}
interface Disposable {
  dispose?: () => void;
}
type PermissionHook = (name: string, callback: (payload: PermissionEvaluatePayload) => unknown) => Disposable | void;
interface PermissionApi {
  hook?: PermissionHook;
  reply?: PermissionReply;
  list?: unknown;
  get?: unknown;
}
/**
 * `ctx.permission.reply` shape, measured in the P0 spike (opencode-cli 2.0.18):
 * a single object mirroring the SDK route — `{path:{requestID}, body:{reply}}`
 * with `reply ∈ {"once","always","reject"}`. The bridge only ever sends `once`
 * or `reject`; `always` would rewrite the persistent rules (§6).
 */
interface PermissionReplyRequest {
  path: {
    requestID: string;
  };
  body: {
    reply: 'once' | 'always' | 'reject';
    message?: string;
  };
  query?: {
    directory?: string;
    workspace?: string;
  };
}
type PermissionReply = (request: PermissionReplyRequest) => unknown;
interface EventApi {
  subscribe?: (type?: string) => OpenCodeEventStream;
}
interface LocationApi {
  directory?: string;
  workspaceID?: string;
}
interface AppApi {
  version?: string;
}
/**
 * `ctx.session` write methods. Their arity/shape is **unverified** beyond the
 * measured `ctx.session.context({sessionID})` (research doc 02): the published
 * SDK types lag the runtime, so each method is probed by `typeof === "function"`
 * at call time and invoked with a single options object carrying `sessionID`.
 */
type SessionMethod = (options: Record<string, unknown>) => unknown;
interface SessionApi {
  create?: SessionMethod;
  get?: SessionMethod;
  prompt?: SessionMethod;
  interrupt?: SessionMethod;
  switchModel?: SessionMethod;
  switchAgent?: SessionMethod;
  update?: SessionMethod;
}
interface AgentApi {
  list?: () => unknown;
  get?: (id: string) => unknown;
  transform?: (callback: (draft: unknown) => void) => unknown;
  reload?: () => unknown;
}
interface ModelApi {
  list?: () => unknown;
  get?: (id: string) => unknown;
  transform?: (callback: (draft: unknown) => void) => unknown;
  reload?: () => unknown;
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
interface CommandAddPayload {
  name: string;
  description?: string;
  execute?: (ctx?: unknown) => unknown;
}
interface CommandDraft {
  add?: (info: CommandAddPayload) => unknown;
}
interface CommandApi {
  transform?: (callback: (draft: CommandDraft) => void) => unknown;
  /** Present on some hosts; never required (the runtime draft has only `add`). */
  list?: () => unknown;
  get?: unknown;
}
interface OpenCodePluginContext {
  app?: AppApi;
  location?: LocationApi;
  event?: EventApi;
  permission?: PermissionApi;
  session?: SessionApi;
  agent?: AgentApi;
  model?: ModelApi;
  command?: CommandApi;
  options?: unknown;
}
type Cleanup = () => void | Promise<void>;
/** The shape the host requires: an object with `id` and `setup`/`effect`. */
interface OpenCodePluginModule {
  id: string;
  setup?: (ctx: OpenCodePluginContext) => Promise<Cleanup> | Cleanup;
  effect?: (ctx: OpenCodePluginContext) => Promise<Cleanup> | Cleanup;
}
//#endregion
//#region src/shared/logger.d.ts
interface LogFields {
  readonly [key: string]: unknown;
}
interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
//#endregion
//#region src/shared/plugin-options.d.ts
type LoginMode = 'device' | 'loopback';
//#endregion
//#region src/server/device-login.d.ts
interface DeviceCodeNotice {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  /** Seconds the client will wait between polls. */
  interval: number;
}
//#endregion
//#region src/server/onboarding.d.ts
type ConnectionStage = {
  stage: 'connected';
  apiBaseUrl: string;
  userId: string;
  connectorId: string;
  reusedDevice: boolean;
} | {
  stage: 'needs_login';
  apiBaseUrl: string | null;
  reason: string;
} | {
  stage: 'disabled';
  reason: string;
};
type LoginOutcome = {
  ok: true;
  stage: Extract<ConnectionStage, {
    stage: 'connected';
  }>;
} | {
  ok: false;
  code: string;
  message: string;
};
/** What the loopback prompt writer needs to make the URL actionable. */
interface LoopbackPromptContext {
  /** Epoch ms after which the URL is dead. */
  deadline: number;
  redirectUri: string;
}
interface LoginOptions {
  /** Skip the browser/loopback entirely (SSH/headless). */
  headless?: boolean;
  /** Called with the short code the user must enter (headless path). */
  onCode?: (notice: DeviceCodeNotice) => void | Promise<void>;
  /**
   * Called once the loopback listener is up, before the browser is opened. The
   * returned promise is awaited (fail-soft), so a writer of `login.json` is
   * guaranteed to have finished before the user is asked to click anything.
   */
  onAuthorizationUrl?: (url: string, context: LoopbackPromptContext) => void | Promise<void>;
  signal?: AbortSignal;
  /** Override the settings apiBaseUrl for this login. */
  apiBaseUrl?: string;
  /** Test seam: replaces the device-code poll delay. */
  pollSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
//#endregion
//#region src/server/auto-login.d.ts
interface AutoLoginResult {
  /** The flow the user actually ended up in. */
  mode: LoginMode;
  /** True when loopback could not start and the device code took over. */
  fellBack: boolean;
  attempts: LoginMode[];
  outcome: LoginOutcome;
}
//#endregion
//#region src/server/command-flows.d.ts
/** What `runSetupLogin` needs to run a login without holding the whole `Onboarding`. */
interface SetupLoginTask {
  login: (options: LoginOptions) => Promise<LoginOutcome>;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Forced flow from `options.loginMode` / `AGENT_AA_LOGIN`. */
  forcedMode?: 'device' | 'loopback' | null;
}
/**
 * Login + outcome logging, never throwing. Callers fire it without awaiting (the
 * host must not be blocked by an interactive flow); tests await the returned
 * promise to assert the three state lines.
 */
declare function runSetupLogin(task: SetupLoginTask): Promise<AutoLoginResult | null>;
//#endregion
//#region src/server/index.d.ts
declare const id = "agents-anywhere-opencode";
declare const plugin: OpenCodePluginModule;
//#endregion
export { type SetupLoginTask, plugin as default, id, runSetupLogin };
//# sourceMappingURL=index.d.ts.map