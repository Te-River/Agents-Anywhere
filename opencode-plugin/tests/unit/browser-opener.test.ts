import test from 'node:test'
import assert from 'node:assert/strict'
import { browserCommands, openExternal } from '../../src/server/browser-opener.js'

const URL_WITH_QUERY = 'https://api.example.com/#/plugin-oauth?state=s&code_challenge=c'

/**
 * The authorization URL the real flow builds: it always carries `&` and `%`.
 * Guard tests assert this reaches the OS launcher byte-for-byte.
 */
const REAL_URL =
  'https://api.example.com/#/plugin-oauth?response_type=code' +
  '&client_id=agents-anywhere-opencode-plugin' +
  '&redirect_uri=http%3A%2F%2F127.0.0.1%3A49321%2Fcallback' +
  '&code_challenge=abcDEF123_-xyz' +
  '&code_challenge_method=S256'

/** Channel builds register their own ProgIDs — naming any of these is a bug. */
const BROWSER_NAME = /edge|chrome|firefox|iexplore|msedge|MSEdgeHTM|ChromeHTML/i

test('each platform gets its documented, argv-direct launcher chain', () => {
  assert.deepEqual(browserCommands(URL_WITH_QUERY, 'darwin'), [
    { command: 'open', args: [URL_WITH_QUERY] },
  ])
  assert.deepEqual(browserCommands(URL_WITH_QUERY, 'linux'), [
    { command: 'xdg-open', args: [URL_WITH_QUERY] },
  ])
  // Windows: primary protocol handler, then the explorer fallback.
  assert.deepEqual(browserCommands(URL_WITH_QUERY, 'win32'), [
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', URL_WITH_QUERY] },
    { command: 'explorer.exe', args: [URL_WITH_QUERY] },
  ])
  assert.deepEqual(browserCommands(URL_WITH_QUERY, 'aix'), [])
})

test('guard: no launcher ever names a browser executable or ProgID', () => {
  const platforms: NodeJS.Platform[] = ['win32', 'darwin', 'linux', 'freebsd', 'sunos']
  for (const platform of platforms) {
    for (const launch of browserCommands(REAL_URL, platform)) {
      const commandLine = [launch.command, ...launch.args].join(' ')
      assert.doesNotMatch(commandLine, BROWSER_NAME, `${platform}: ${commandLine}`)
    }
  }
})

test('guard: a URL with `&` and `%` is passed verbatim, character for character', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
    for (const launch of browserCommands(REAL_URL, platform)) {
      // The URL is its own argv token, unquoted and unescaped — the shell that
      // is not in this path can never split it on `&`.
      assert.ok(launch.args.some((arg) => arg === REAL_URL), `${platform} lost the URL verbatim`)
      assert.ok(!launch.args.some((arg) => /[\\"]/.test(arg)), `${platform} escaped or quoted an arg`)
    }
  }
  // Same guarantee end to end, through the injected launcher.
  const seen: Array<{ command: string; args: string[] }> = []
  return openExternal(REAL_URL, {
    platform: 'win32',
    run: async (command, args) => {
      seen.push({ command, args })
    },
  }).then(() => {
    assert.equal(seen[0]?.args[1], REAL_URL)
  })
})

test('the fallback chain advances on failure and stops at the first success', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const opened = await openExternal(URL_WITH_QUERY, {
    platform: 'win32',
    run: async (command, args) => {
      calls.push({ command, args })
      // Primary fails, fallback succeeds.
      if (command === 'rundll32.exe') throw new Error('blocked by policy')
    },
  })
  assert.equal(opened, 'opened')
  assert.deepEqual(
    calls.map((call) => call.command),
    ['rundll32.exe', 'explorer.exe'],
  )
  assert.deepEqual(calls[1]?.args, [URL_WITH_QUERY])
})

test('an exhausted chain is fail-soft: reported failed, never thrown', async () => {
  const failed = await openExternal(URL_WITH_QUERY, {
    platform: 'win32',
    run: async () => {
      throw new Error('headless session')
    },
  })
  assert.equal(failed, 'failed')

  const noBrowser = await openExternal(URL_WITH_QUERY, {
    platform: 'linux',
    run: async () => {
      throw new Error('xdg-open not installed')
    },
  })
  assert.equal(noBrowser, 'failed')
})

test('a platform we cannot drive launches nothing and reports failure', async () => {
  let launches = 0
  const result = await openExternal(URL_WITH_QUERY, {
    platform: 'aix',
    run: async () => {
      launches += 1
    },
  })
  assert.equal(result, 'failed')
  assert.equal(launches, 0)
})
