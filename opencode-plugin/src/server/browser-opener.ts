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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type BrowserOpenResult = 'opened' | 'failed'

export interface BrowserCommand {
  command: string
  args: string[]
}

/**
 * The candidate argv chains that hand `url` to the platform's default browser,
 * in fallback order, or `[]` on a platform we cannot drive (the caller then
 * reports "open it yourself"). Each entry is argv-direct — nothing here is ever
 * routed through a shell — and none of them names a browser.
 */
export function browserCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserCommand[] {
  if (platform === 'win32') {
    return [
      // Primary: the documented system protocol handler. `url.dll` resolves the
      // registered shell association for the URL scheme (the user's actual
      // default handler — channel builds included). argv-direct: the `,` in the
      // first token and the `&`/`%` in the URL are never re-parsed.
      { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
      // Fallback: Explorer's "open with the default handler" path. Still
      // argv-direct, still association-driven, no browser named.
      { command: 'explorer.exe', args: [url] },
    ]
  }
  if (platform === 'darwin') return [{ command: 'open', args: [url] }]
  if (
    platform === 'linux' ||
    platform === 'freebsd' ||
    platform === 'openbsd' ||
    platform === 'sunos'
  ) {
    return [{ command: 'xdg-open', args: [url] }]
  }
  return []
}

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform
  /** Test seam: replaces the real launcher. A throw here is still fail-soft. */
  run?: (command: string, args: string[]) => Promise<void>
}

export async function openExternal(
  url: string,
  options: OpenBrowserOptions = {},
): Promise<BrowserOpenResult> {
  const launches = browserCommands(url, options.platform ?? process.platform)
  if (launches.length === 0) return 'failed'
  const run = options.run ?? defaultRun
  for (const launch of launches) {
    try {
      await run(launch.command, launch.args)
      return 'opened'
    } catch {
      // Missing browser, headless session or policy block: try the next
      // candidate. The URL is already in the log and in `login.json`, so an
      // exhausted chain only downgrades to "open it yourself" — it never
      // fails the login.
    }
  }
  return 'failed'
}

async function defaultRun(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { timeout: 10_000, windowsHide: true })
}
