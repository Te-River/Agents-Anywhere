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
//#region src/shared/login-prompt.d.ts
declare const LOGIN_PROMPT_VERSION = 1;
type LoginPromptStatus = 'pending' | 'connected' | 'failed';
/** The record behind both the prominent log line and the on-disk state. */
interface LoginPrompt {
  version: typeof LOGIN_PROMPT_VERSION;
  status: LoginPromptStatus;
  kind: LoginMode;
  /** Epoch ms the record was written. */
  createdAt: number;
  /** Epoch ms the pending URL / short code stops being usable. */
  expiresAt: number;
  /** The sentence the user should act on (mirrors the log line's body). */
  instruction: string;
  /** Loopback only. */
  authorizationUrl?: string;
  /** Device only. */
  verificationUri?: string;
  /** Device only: the URL that already carries `user_code`. */
  verificationUriComplete?: string;
  /** Device only. */
  userCode?: string;
}
//#endregion
//#region src/tui/index.d.ts
/** Cleanup returned by `setup`, mirroring the host's `TuiDispose`. */
type TuiDispose = () => void | Promise<void>;
/**
 * The V2 TUI module shape the host accepts. `id` and `setup` are the only two
 * members the validator checks; extra members are ignored.
 */
interface TuiPluginModule {
  id: string;
  setup: (context: unknown) => TuiDispose | Promise<TuiDispose>;
}
declare const id = "agents-anywhere-opencode";
interface TuiToast {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  message: string;
  duration?: number;
}
interface TuiCommandDescriptor {
  title: string;
  value: string;
  description?: string;
  category?: string;
  slash?: {
    name: string;
    aliases?: string[];
  };
  onSelect?: () => void | Promise<void>;
}
/** The argument we hand to `keymap.layer` — its true shape is unverified (§4). */
interface TuiKeymapLayer {
  id: string;
  commands: TuiCommandDescriptor[];
}
interface TuiApi {
  app?: {
    version?: string;
    channel?: string;
  };
  ui?: {
    toast?: (input: TuiToast) => void;
    /** Present on the real context but JSX-rendered: reported, never used. */
    slot?: unknown;
    panel?: unknown;
  };
  attention?: {
    notify?: (input: {
      title?: string;
      message: string;
      sound?: unknown;
    }) => unknown;
  };
  /** The only member that could carry a command layer (§4); unverified writability. */
  keymap?: {
    layer?: (layer: TuiKeymapLayer) => unknown;
  };
  /**
   * The host SDK client (`TuiPluginApi.client`). The session *list* is the only
   * parent/child channel the runtime exposes (spike 02 §3.1–§3.3). Typed
   * structurally because this module stays dependency-free; probed before use.
   */
  client?: {
    session?: {
      list?: (parameters?: {
        roots?: boolean;
      }) => Promise<unknown> | unknown;
    };
  };
  /** Present on some hosts only; JSX-only, reported by `describeSurfaces`. */
  markdown?: {
    registerCodeBlockRenderer?: (renderer: unknown) => unknown;
  };
  route?: {
    register?: (routes: unknown[]) => unknown;
  };
  slots?: {
    register?: (plugin: unknown) => unknown;
  };
}
type CommandRegistrationMode = 'keymap' | 'none';
/** What the live context actually offers us (A10 §4 checklist). */
interface TuiSurfaceReport {
  /** Surfaces this module can call on the live host. */
  usable: string[];
  /** Surfaces that exist but need a JSX runtime this module does not ship. */
  jsxOnly: string[];
}
/**
 * Probe which surfaces the live context exposes. `usable` are the members we may
 * call; `jsxOnly` are members that exist yet require a JSX renderer this
 * zero-dependency module cannot author. Exported so tests and the A10 self-check
 * log can see the *real* surface (A10 measured `ui` + `attention` usable, with no
 * command surface at all).
 */
declare function describeSurfaces(api: TuiApi): TuiSurfaceReport;
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
declare function publishSessionIndexOnce(api: TuiApi, options?: {
  path?: string;
}): Promise<boolean>;
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
declare function startSessionIndexWriter(api: TuiApi, options?: {
  path?: string;
  intervalMs?: number;
  logger?: Logger;
}): () => Promise<void>;
/**
 * Try to register the `/aa` command family on the **only** member that could
 * carry it — `keymap.layer` (A10 §4; `registerLayer` and the `command` domain do
 * not exist on 2.0.18, so those calls were removed). `keymap.layer`'s writability
 * and argument shape are unverified on a real terminal, so a missing member, a
 * wrong shape, or a throw all degrade **silently** to `'none'` — the caller logs
 * it, and the host is never disturbed.
 */
declare function registerCommandLayer(api: TuiApi, commands: TuiCommandDescriptor[]): CommandRegistrationMode;
/** Build the `/aa` command descriptors (exported for shape tests). */
declare function aaCommands(api: TuiApi): TuiCommandDescriptor[];
/**
 * The one behaviour that is real on 2.0.18: an **actionable status toast**.
 * Exported so tests can await it directly (it reads the credential store).
 * Never throws.
 */
declare function announceStatus(api: TuiApi): Promise<void>;
/** How often the TUI re-reads `login.json` while it is loaded. */
declare const LOGIN_WATCH_INTERVAL_MS = 2000;
interface LoginWatchOptions {
  /** Where `login.json` lives; defaults to the plugin data dir. */
  dataDir?: string;
  intervalMs?: number;
  logger?: Logger;
  /** Test seam: replaces the real `login.json` read. Never called with a secret. */
  readPrompt?: (dataDir: string) => Promise<LoginPrompt | null>;
}
/**
 * The toast for a *transition*, or `null` when nothing user-visible changed.
 * Exported so the mapping is unit-testable without a TUI or a timer.
 */
declare function loginStateToast(current: LoginPrompt | null, previous: LoginPrompt | null, path?: string): TuiToast | null;
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
declare function startLoginStateWatcher(api: TuiApi, options?: LoginWatchOptions): () => void;
/**
 * Wire the module into a live TUI context and return its cleanup. Never throws:
 * a context missing every surface still returns a working dispose handle, and the
 * command registration outcome (`'keymap'` / `'none'`) is only logged.
 */
declare function tuiPlugin(api: TuiApi): TuiDispose;
/**
 * Host entry point. Same body as `tuiPlugin`; named `setup` because that is the
 * exact member the 2.0.18 TUI module validator requires.
 */
declare function setup(context: unknown): TuiDispose;
declare const tuiPluginModule: TuiPluginModule;
//#endregion
export { CommandRegistrationMode, LOGIN_WATCH_INTERVAL_MS, LoginWatchOptions, TuiDispose, TuiPluginModule, TuiSurfaceReport, TuiToast, aaCommands, announceStatus, tuiPluginModule as default, describeSurfaces, id, loginStateToast, publishSessionIndexOnce, registerCommandLayer, setup, startLoginStateWatcher, startSessionIndexWriter, tuiPlugin };
//# sourceMappingURL=tui.d.ts.map