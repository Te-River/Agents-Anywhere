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

import { installPlugin } from './bridge-hub.js'
import { cleanupRequested, runCleanup } from './cleanup.js'
import {
  createCommandEntries,
  createCommandFlows,
  runSetupLogin,
  summarizeHostSurface,
  type HostSummary,
} from './command-flows.js'
import { registerCommands } from './commands.js'
import {
  autoLoginDisabledStateLine,
  connectedStateLine,
  disabledStateLine,
  needsLoginStateLine,
} from './login-state.js'
import { installOnboarding } from './onboarding.js'
import { createLogger } from '../shared/logger.js'
import { resolvePluginOptions } from '../shared/plugin-options.js'
import { evaluateHostVersion } from '../shared/version-gate.js'
import {
  readServiceVersion,
  type Cleanup,
  type OpenCodePluginContext,
  type OpenCodePluginModule,
} from './opencode-ctx.js'

export const id = 'agents-anywhere-opencode'

const NOOP_CLEANUP: Cleanup = () => undefined

const logger = createLogger('plugin')

// `runSetupLogin` moved to `command-flows.ts` (the palette commands share the
// very same login flow); re-exported here so the package surface is unchanged.
export { runSetupLogin } from './command-flows.js'
export type { SetupLoginTask } from './command-flows.js'

/**
 * The one `Onboarding` this process uses. `installOnboarding` is a global
 * singleton, so the palette commands and the automatic trigger always hold the
 * *same* instance — there is no second copy of the login flow anywhere.
 */
function sharedOnboarding(ctx: OpenCodePluginContext): ReturnType<typeof installOnboarding> {
  const options = resolvePluginOptions(ctx.options, process.env)
  return installOnboarding({
    logger: createLogger('onboarding'),
    serverUrl: options.serverUrl,
    connectorSource: options.connectorSource,
    forceReuseConnector: options.forceReuseConnector,
  })
}

/** Host version + version gate + present surfaces, for `aa-status`. */
function hostSummary(ctx: OpenCodePluginContext): HostSummary {
  const version = readServiceVersion(ctx) ?? null
  return {
    version,
    supported: evaluateHostVersion(version ?? undefined).supported,
    capabilities: summarizeHostSurface(ctx),
  }
}

const plugin: OpenCodePluginModule = {
  id,
  async setup(ctx: OpenCodePluginContext): Promise<Cleanup> {
    const env = process.env
    // Plugin config first, environment as the advanced override (see
    // `shared/plugin-options.ts`); a malformed option degrades, never throws.
    const options = resolvePluginOptions(ctx.options, env)

    if (cleanupRequested(env)) {
      try {
        const result = await runCleanup({ env })
        logger.warn('AGENT_AA_CLEANUP：已完成本地清理，本次不建立远端连接', {
          removedPluginData: result.removedPluginData,
          removedBridgeDir: result.removedBridgeDir,
          stoppedConnector: result.stoppedConnectorPid !== null,
        })
      } catch (error) {
        logger.warn('清理失败，本地状态未完全删除', {
          error: error instanceof Error ? error.name : typeof error,
        })
      }
      return NOOP_CLEANUP
    }

    let releaseHub: Cleanup = NOOP_CLEANUP
    try {
      releaseHub = await installPlugin(ctx)
    } catch (error) {
      // §4.1 fail-soft: setup never throws into the host's plugin chain. A
      // disabled hub simply means no remote access this session.
      logger.warn('bridge hub setup failed; remote access disabled for this process', {
        error: error instanceof Error ? error.name : typeof error,
      })
      return NOOP_CLEANUP
    }

    // ── the command palette (task A) ──────────────────────────────────────────
    // Registered whether or not the user is logged in: `/aa-login` is the manual
    // trigger for exactly the case the automatic trigger leaves pending. The
    // flows come from the shared singleton, so there is one login implementation,
    // never two (see `command-flows.ts`).
    registerCommands(
      ctx.command,
      createCommandEntries(
        createCommandFlows({
          onboarding: () => sharedOnboarding(ctx),
          env,
          logger,
          forcedMode: options.loginMode,
          host: () => hostSummary(ctx),
        }),
      ),
      { logger },
    )

    try {
      const onboarding = sharedOnboarding(ctx)
      const stage = await onboarding.resume()
      if (stage.stage === 'needs_login') {
        // `needs_login` is a normal state, not a failure, but it is actionable:
        // say what is wrong and what happens next.
        logger.warn(
          needsLoginStateLine(stage, {
            autoLogin: options.autoLogin,
            autoLoginSource: options.source.autoLogin,
          }),
        )
        if (options.autoLogin) {
          void runSetupLogin({
            login: (loginOptions) => onboarding.login(loginOptions),
            dataDir: onboarding.dataDir,
            env,
            forcedMode: options.loginMode,
          })
        } else {
          logger.warn(
            autoLoginDisabledStateLine({
              autoLogin: options.autoLogin,
              autoLoginSource: options.source.autoLogin,
            }),
          )
        }
      } else if (stage.stage === 'disabled') {
        logger.warn(disabledStateLine(stage))
      } else {
        logger.info(connectedStateLine(stage, { loginMode: null, fellBack: false }))
      }
    } catch (error) {
      logger.warn('onboarding resume failed; login stays pending', {
        error: error instanceof Error ? error.name : typeof error,
      })
    }

    return async () => {
      try {
        await releaseHub()
      } catch {
        // Cleanup failures are not the host's problem.
      }
    }
  },
}

export default plugin
