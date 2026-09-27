/**
 * Defect ① regression tests: the server address must be reused from whatever
 * this machine already knows, and the order of the sources must be the
 * documented one — options → env → connector-runtime → desktop-server →
 * desktop-binding — with `not_configured` only when *none* of them answers.
 *
 * No test here touches the real machine: every file is either an in-memory
 * `readText` map or a temp dir, and the desktop candidates are injected (the
 * real `%APPDATA%\Agents Anywhere\desktop-server.json` is never read).
 *
 * The decoy tokens planted in every document are the leak oracle: if the
 * resolver ever returned or logged more than the single `serverUrl` field, the
 * `secret` assertions below would fail.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger, type LogLevel } from '../../src/shared/logger.js'
import { readLoginPrompt } from '../../src/shared/login-prompt.js'
import {
  defaultServerUrlFiles,
  desktopConfigDirs,
  locateServerUrl,
  readServerUrlField,
  type ServerUrlFile,
} from '../../src/shared/server-url.js'
import { Onboarding } from '../../src/server/onboarding.js'
import { runAutoLogin } from '../../src/server/auto-login.js'

const OPTION_URL = 'https://opt.example'
const ENV_URL = 'https://env.example'
const RUNTIME_URL = 'https://runtime.example'
const DESKTOP_URL = 'https://desktop.example'
const BINDING_URL = 'https://binding.example'

/** A token / password that must never leave the file it sits in. */
const DECOY = 'super-secret-token'

interface Captured {
  logger: ReturnType<typeof createLogger>
  lines: string[]
}

function capturing(): Captured {
  const lines: string[] = []
  const logger = createLogger('test', (level: LogLevel, _scope: string, message: string) => {
    lines.push(`${level} ${message}`)
  })
  return { logger, lines }
}

/** The three machine-file candidates in resolution order, as in-memory documents. */
function machineFiles(): { files: ServerUrlFile[]; documents: Map<string, string> } {
  const files: ServerUrlFile[] = [
    { path: 'C:\\machine\\connector-runtime.json', source: 'connector-runtime', field: 'runtime.serverUrl' },
    { path: 'C:\\machine\\desktop-server.json', source: 'desktop-server', field: 'serverUrl' },
    { path: 'C:\\machine\\connector\\desktop-binding.json', source: 'desktop-binding', field: 'serverUrl' },
  ]
  const documents = new Map<string, string>([
    [
      files[0]!.path,
      JSON.stringify({
        version: 2,
        connectorIds: ['conn_q4'],
        accessToken: DECOY,
        runtime: { pid: 24080, kind: 'desktop-workbench', connectorId: 'conn_q4', serverUrl: RUNTIME_URL },
      }),
    ],
    [
      files[1]!.path,
      JSON.stringify({ serverUrl: DESKTOP_URL, apiNamespace: '/api/v2', password: DECOY }),
    ],
    [
      files[2]!.path,
      JSON.stringify({ connectorId: 'conn_q4', serverUrl: BINDING_URL, connectorToken: DECOY }),
    ],
  ])
  return { files, documents }
}

function readFrom(documents: Map<string, string>): (path: string) => Promise<string | null> {
  return async (path) => documents.get(path) ?? null
}

test('resolution order: options → env → connector-runtime → desktop-server → desktop-binding', async () => {
  const { files, documents } = machineFiles()
  const readText = readFrom(documents)

  const option = await locateServerUrl({ optionUrl: OPTION_URL, env: { AGENT_SERVER_URL: ENV_URL } as NodeJS.ProcessEnv, files, readText })
  assert.deepEqual({ url: option.url, source: option.source }, { url: OPTION_URL, source: 'options' })

  const env = await locateServerUrl({ env: { AGENT_SERVER_URL: ENV_URL } as NodeJS.ProcessEnv, files, readText })
  assert.deepEqual({ url: env.url, source: env.source }, { url: ENV_URL, source: 'env' })

  const runtime = await locateServerUrl({ env: {} as NodeJS.ProcessEnv, files, readText })
  assert.deepEqual({ url: runtime.url, source: runtime.source, fromFile: runtime.fromFile }, {
    url: RUNTIME_URL,
    source: 'connector-runtime',
    fromFile: true,
  })

  // The lease file gone → the Desktop app's own config answers.
  const withoutRuntime = new Map(documents)
  withoutRuntime.delete(files[0]!.path)
  const desktop = await locateServerUrl({ env: {} as NodeJS.ProcessEnv, files, readText: readFrom(withoutRuntime) })
  assert.deepEqual({ url: desktop.url, source: desktop.source }, { url: DESKTOP_URL, source: 'desktop-server' })

  // …and with only the device binding left, that one answers.
  const onlyBinding = new Map(withoutRuntime)
  onlyBinding.delete(files[1]!.path)
  const binding = await locateServerUrl({ env: {} as NodeJS.ProcessEnv, files, readText: readFrom(onlyBinding) })
  assert.deepEqual({ url: binding.url, source: binding.source }, { url: BINDING_URL, source: 'desktop-binding' })

  // Nothing anywhere → `none`, never a guess.
  const none = await locateServerUrl({ env: {} as NodeJS.ProcessEnv, files, readText: async () => null })
  assert.deepEqual({ url: none.url, source: none.source }, { url: null, source: 'none' })
})

test('every source is named in the log: the winner as info, each skipped layer as debug', async () => {
  const { files, documents } = machineFiles()
  const { logger, lines } = capturing()
  const resolution = await locateServerUrl({ env: {} as NodeJS.ProcessEnv, files, readText: readFrom(documents), logger })
  assert.equal(resolution.source, 'connector-runtime')
  const text = lines.join('\n')
  assert.match(text, /debug .*插件配置 options\.serverUrl 未提供/, 'the options layer is reported as skipped')
  assert.match(text, /debug .*环境变量 AGENT_SERVER_URL 未提供/, 'the env layer is reported as skipped')
  assert.match(text, /info .*服务器地址采用本机共享记录 connector-runtime\.json 的 runtime\.serverUrl/, 'the winner is named')
  assert.ok(text.includes(RUNTIME_URL), text)
  // The two Desktop layers were never reached, so they must not be named as
  // "skipped" either — the walk stops at the first hit.
  assert.doesNotMatch(text, /desktop-server\.json 无可用地址/)

  // Each remaining layer, when it is the one that answers.
  const cases: Array<{ source: string; files: ServerUrlFile[]; url: string }> = [
    { source: '桌面端配置 desktop-server.json 的 serverUrl', files: [files[1]!], url: DESKTOP_URL },
    { source: '桌面端设备绑定 desktop-binding.json 的 serverUrl', files: [files[2]!], url: BINDING_URL },
  ]
  for (const item of cases) {
    const captured = capturing()
    const hit = await locateServerUrl({
      env: {} as NodeJS.ProcessEnv,
      files: item.files,
      readText: readFrom(documents),
      logger: captured.logger,
    })
    assert.equal(hit.url, item.url)
    assert.ok(
      captured.lines.some((line) => line.startsWith('info') && line.includes(item.source)),
      JSON.stringify(captured.lines),
    )
  }

  // An unreadable/malformed layer is a skip, never a throw.
  const broken = capturing()
  const brokenFiles: ServerUrlFile[] = [{ path: 'x.json', source: 'connector-runtime', field: 'runtime.serverUrl' }]
  const brokenResult = await locateServerUrl({
    env: {} as NodeJS.ProcessEnv,
    files: brokenFiles,
    readText: async () => 'not json at all',
    logger: broken.logger,
  })
  assert.equal(brokenResult.url, null)
  assert.ok(
    broken.lines.some((line) => line.startsWith('warn') && line.includes('未找到服务器地址')),
    JSON.stringify(broken.lines),
  )
})

test('only the serverUrl field is read — tokens and passwords never reach the result or the log', async () => {
  const { files, documents } = machineFiles()
  const { logger, lines } = capturing()
  const resolution = await locateServerUrl({ env: {} as NodeJS.ProcessEnv, files, readText: readFrom(documents), logger })
  const serialized = JSON.stringify({ resolution, lines })
  assert.doesNotMatch(serialized, new RegExp(DECOY), serialized)
  assert.doesNotMatch(serialized, /conn_q4/, 'a connector id is not the resolver\'s business either')
  assert.equal(readServerUrlField('{"a":{"b":"  https://x.example  "}}', 'a.b'), 'https://x.example')
  for (const [text, field] of [
    ['not json', 'serverUrl'],
    ['{"serverUrl":42}', 'serverUrl'],
    ['{"serverUrl":{"nested":true}}', 'serverUrl'],
    ['{"runtime":{}}', 'runtime.serverUrl'],
  ] as const) {
    assert.equal(readServerUrlField(text, field), null, `${text} / ${field}`)
  }
})

test('the default candidate list is the shared lease plus this OS\'s Desktop config dir', () => {
  const win = defaultServerUrlFiles({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } as NodeJS.ProcessEnv, 'win32')
  assert.deepEqual(
    win.map((file) => [file.source, file.field]),
    [
      ['connector-runtime', 'runtime.serverUrl'],
      ['desktop-server', 'serverUrl'],
      ['desktop-binding', 'serverUrl'],
    ],
  )
  assert.ok(win[1]!.path.endsWith(join('Agents Anywhere', 'desktop-server.json')), win[1]!.path)
  assert.ok(win[2]!.path.endsWith(join('Agents Anywhere', 'connector', 'desktop-binding.json')), win[2]!.path)
  assert.ok(win[0]!.path.endsWith(join('.agents-anywhere', 'connector-runtime.json')), win[0]!.path)

  const mac = desktopConfigDirs({} as NodeJS.ProcessEnv, 'darwin')
  assert.ok(mac[0]!.endsWith(join('Library', 'Application Support', 'Agents Anywhere')), mac[0])
  const linux = desktopConfigDirs({ XDG_CONFIG_HOME: '/etc/xdg' } as NodeJS.ProcessEnv, 'linux')
  assert.equal(linux[0], join('/etc/xdg', 'Agents Anywhere'))
  assert.deepEqual(desktopConfigDirs({} as NodeJS.ProcessEnv, 'freebsd'), [], 'no guess for an unknown OS')
})

test('Onboarding reuses the machine record; without any source it is a plain not_configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-server-url-'))
  try {
    const runtimePath = join(root, 'connector-runtime.json')
    await writeFile(
      runtimePath,
      JSON.stringify({ version: 2, connectorIds: ['conn_q4'], accessToken: DECOY, runtime: { pid: 1, serverUrl: RUNTIME_URL } }),
      'utf8',
    )
    const files: ServerUrlFile[] = [{ path: runtimePath, source: 'connector-runtime', field: 'runtime.serverUrl' }]
    const { logger, lines } = capturing()
    const env = { AGENT_CONNECTOR_DATA_DIR: root } as NodeJS.ProcessEnv

    const onboarding = new Onboarding({ logger, env, serverUrlFiles: files })
    const stage = await onboarding.resume()
    assert.equal(stage.stage === 'needs_login' && stage.apiBaseUrl, RUNTIME_URL)
    const status = await onboarding.status()
    assert.equal(status.apiBaseUrl, RUNTIME_URL)
    assert.equal(status.apiBaseUrlSource, 'connector-runtime')
    assert.ok(
      lines.some((line) => line.includes('connector-runtime.json 的 runtime.serverUrl')),
      JSON.stringify(lines),
    )
    assert.doesNotMatch(lines.join('\n'), new RegExp(DECOY), 'the decoy token in the same file must not be logged')

    // No source at all: `needs_login` with no address, and a login that fails
    // *before* any network call (no socket, no browser) with actionable text.
    const empty = new Onboarding({ logger, env, serverUrlFiles: [] })
    const noServer = await empty.resume()
    assert.equal(noServer.stage === 'needs_login' && noServer.apiBaseUrl, null)
    const outcome = await empty.login({ headless: true })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.code, 'not_configured')
    assert.match(outcome.ok === false ? outcome.message : '', /opencode\.json/, 'the message says where to put the address')
    assert.match(outcome.ok === false ? outcome.message : '', /"options":\{"serverUrl"/)
    assert.match(outcome.ok === false ? outcome.message : '', /README\.md/)
    assert.match(outcome.ok === false ? outcome.message : '', /AGENT_SERVER_URL/)

    // login.json must carry the same actionable sentence — and no secret from
    // the machine record that sits right next to it.
    await runAutoLogin({
      dataDir: join(root, 'opencode-plugin'),
      logger,
      env: {} as NodeJS.ProcessEnv,
      forcedMode: 'device',
      login: (loginOptions) => empty.login(loginOptions),
    })
    const record = await readLoginPrompt(join(root, 'opencode-plugin'))
    assert.equal(record?.status, 'failed')
    assert.match(record?.instruction ?? '', /not_configured/)
    assert.match(record?.instruction ?? '', /怎么设置服务器地址/)
    assert.match(record?.instruction ?? '', /AGENT_SERVER_URL/)
    assert.doesNotMatch(JSON.stringify(record), new RegExp(DECOY))
    assert.doesNotMatch(lines.join('\n'), new RegExp(DECOY))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
