import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tuiPluginModule, {
  aaCommands,
  announceStatus,
  describeSurfaces,
  registerCommandLayer,
  tuiPlugin,
  type CommandRegistrationMode,
  type TuiDispose,
} from '../../src/tui/index.js'

interface Recorded {
  toasts: Array<{ variant?: string; title?: string; message: string }>
  attention: Array<{ message: string }>
  /**
   * Calls to surfaces that do NOT exist on opencode-cli 2.0.18 (A10 §4). These
   * spies are planted on purpose: the whole point of this rewrite is that they
   * must stay EMPTY.
   */
  forbidden: string[]
}

function emptyRecorded(): Recorded {
  return { toasts: [], attention: [], forbidden: [] }
}

/** A minimal context: only the surfaces we are allowed to use. */
function fakeApi(): { api: Record<string, unknown>; recorded: Recorded } {
  const recorded = emptyRecorded()
  const api: Record<string, unknown> = {
    app: { version: '2.0.18' },
    ui: {
      toast: (input: { message: string; variant?: string; title?: string }) => {
        recorded.toasts.push(input)
      },
    },
    attention: { notify: (input: { message: string }) => recorded.attention.push(input) },
  }
  return { api, recorded }
}

/**
 * The **real** 2.0.18 TUI context as dumped by the A10 PTY probe (§4), with spies
 * planted on every surface that module used to (wrongly) call. `keymap` has NO
 * `registerLayer` and there is NO `command` domain on the real host — the spies
 * here prove we no longer touch either even when handed one.
 */
function a10Context(options: { layer?: unknown } = {}): {
  api: Record<string, unknown>
  recorded: Recorded
} {
  const recorded = emptyRecorded()
  const api: Record<string, unknown> = {
    options: {},
    location: {},
    app: {},
    renderer: {},
    data: {},
    client: {},
    theme: {},
    themeMode: 'dark',
    markdown: {
      registerCodeBlockRenderer: () => {
        recorded.forbidden.push('markdown.registerCodeBlockRenderer')
        return () => undefined
      },
    },
    keymap: {
      layer: options.layer ?? (() => undefined),
      dispatch: () => undefined,
      shortcuts: [],
      commands: [],
      pending: [],
      active: [],
      mode: 'default',
      // Does not exist on 2.0.18 — here only as a tripwire.
      registerLayer: () => {
        recorded.forbidden.push('keymap.registerLayer')
        return undefined
      },
    },
    storage: {},
    ui: {
      dialog: {
        replace: () => {
          recorded.forbidden.push('ui.dialog.replace')
        },
      },
      toast: (input: { message: string; variant?: string; title?: string }) => {
        recorded.toasts.push(input)
      },
      format: {},
      router: {},
      panel: {},
      tabs: {},
      model: {},
      slot: {},
      // Not in the real `ui` member set — tripwires.
      DialogAlert: () => {
        recorded.forbidden.push('ui.DialogAlert')
        return undefined
      },
      DialogPrompt: () => {
        recorded.forbidden.push('ui.DialogPrompt')
        return undefined
      },
    },
    attention: {
      notify: (input: { message: string }) => recorded.attention.push(input),
      dispose: () => undefined,
    },
    // The `command` domain does not exist on 2.0.18 — tripwire only.
    command: {
      register: () => {
        recorded.forbidden.push('command.register')
        return () => undefined
      },
    },
  }
  return { api, recorded }
}

/**
 * A TUI test must never look at the developer's machine: the data dir *and*
 * the Desktop config dir (which the server-address resolution reads, defect ①)
 * are both pointed at the temp dir for the duration.
 */
async function withTempDataDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-tui-'))
  const pinned = ['AGENT_CONNECTOR_DATA_DIR', 'APPDATA', 'XDG_CONFIG_HOME'] as const
  const previous = new Map(pinned.map((key) => [key, process.env[key]]))
  process.env['AGENT_CONNECTOR_DATA_DIR'] = dir
  process.env['APPDATA'] = dir
  process.env['XDG_CONFIG_HOME'] = dir
  try {
    await run(dir)
  } finally {
    for (const key of pinned) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

/** Poll until `check` is true or the deadline passes (async setup toast). */
async function waitUntil(check: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return check()
}

test('TUI module uses the V2 { id, setup } contract the host validator requires', () => {
  // A10 probe (opencode-cli 2.0.18, binary `xCt`): the ONLY accepted TUI module
  // shape is `{ id: string, setup: function }`; the old `{ id, tui(api) }` threw
  // `Invalid V2 TUI plugin module`.
  assert.equal(typeof tuiPluginModule.setup, 'function')
  assert.equal(tuiPluginModule.id, 'agents-anywhere-opencode')
  assert.equal('tui' in tuiPluginModule, false)
})

test('setup() returns the host dispose handle and never throws, even on a hostile context', () => {
  const { api } = fakeApi()
  const dispose = tuiPluginModule.setup(api)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => void (dispose as TuiDispose)())

  // Every property access throws: the entry point must still return cleanly.
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error('nope')
      },
    },
  )
  assert.doesNotThrow(() => tuiPluginModule.setup(hostile))
})

test('surface probe: the real 2.0.18 context yields usable ui/attention/keymap.layer and JSX-only members', () => {
  const { api } = a10Context()
  const surfaces = describeSurfaces(api as never)
  assert.deepEqual(surfaces.usable, ['ui.toast', 'attention.notify', 'keymap.layer'])
  // Exists on the host but needs JSX we do not ship → reported, never used.
  assert.deepEqual(surfaces.jsxOnly, ['ui.slot', 'ui.panel', 'markdown.registerCodeBlockRenderer'])
})

test('surface probe: a context with no surfaces reports nothing usable and never throws', () => {
  assert.deepEqual(describeSurfaces({} as never), { usable: [], jsxOnly: [] })
  assert.equal(registerCommandLayer({} as never, []), 'none')
})

test('command registration uses keymap.layer only and degrades silently to "none"', () => {
  const layers: unknown[] = []
  const withLayer = a10Context({ layer: (layer: unknown) => layers.push(layer) })
  assert.equal(
    registerCommandLayer(withLayer.api as never, aaCommands(withLayer.api as never)),
    'keymap' satisfies CommandRegistrationMode,
  )
  assert.equal(layers.length, 1)

  // `layer` present but not a function → probe must refuse it, not call it.
  assert.equal(registerCommandLayer(a10Context({ layer: {} }).api as never, []), 'none')

  // A throwing `layer` must degrade, never escape.
  const throwing = a10Context({
    layer: () => {
      throw new Error('unsupported layer shape')
    },
  })
  assert.equal(registerCommandLayer(throwing.api as never, []), 'none')
})

test('REGRESSION: removed surfaces (registerLayer / command.register / dialogs) are never called', async () => {
  // A10 §4: `keymap.registerLayer`, the `command` domain, `DialogAlert` /
  // `DialogPrompt` / `ui.dialog.replace` and the markdown renderer do not exist
  // (or need JSX). The tripwires planted above must stay empty through a full
  // setup + command dispatch + device-code announcement.
  await withTempDataDir(async () => {
    const { api, recorded } = a10Context()
    const dispose = tuiPlugin(api as never)
    for (const command of aaCommands(api as never)) {
      await command.onSelect?.()
    }
    await announceStatus(api as never)
    await (dispose as TuiDispose)()
    assert.deepEqual(recorded.forbidden, [])
  })
})

test('the /aa command family exposes the login/status/logout aliases', () => {
  const { api } = fakeApi()
  const commands = aaCommands(api as never)
  assert.equal(commands.length, 4)
  const bySlash = new Map(commands.map((command) => [command.slash?.name ?? '', command]))
  assert.deepEqual([...bySlash.keys()].sort(), ['aa', 'login', 'login-headless', 'logout'])
  assert.deepEqual(bySlash.get('aa')?.slash?.aliases, ['agents-anywhere'])
  assert.deepEqual(bySlash.get('login')?.slash?.aliases, ['connect'])
  for (const command of commands) {
    assert.equal(typeof command.onSelect, 'function', `${command.value} must be selectable`)
    assert.equal(command.category, 'Agents Anywhere')
  }
})

test('announceStatus() toasts an actionable, login-state-aware message via ui.toast', async () => {
  await withTempDataDir(async () => {
    const { api, recorded } = fakeApi()
    await announceStatus(api as never)
    const message = recorded.toasts.map((entry) => entry.message).join('\n')
    assert.match(message, /已加载/)
    assert.match(message, /未登录/)
    // The login trigger is the SERVER-side command, not a TUI `/aa` command.
    assert.match(message, /\/aa-login/)
    assert.equal(recorded.toasts.at(-1)?.variant, 'info')
  })
})

test('setup() itself emits the status toast without being awaited', async () => {
  await withTempDataDir(async () => {
    const { api, recorded } = fakeApi()
    tuiPlugin(api as never)
    assert.ok(await waitUntil(() => recorded.toasts.length > 0))
    assert.match(recorded.toasts[0]!.message, /已加载/)
  })
})

test('/aa status reads the credential store and reports "not configured"', async () => {
  await withTempDataDir(async () => {
    const { api, recorded } = fakeApi()
    tuiPlugin(api as never)
    const status = aaCommands(api as never).find((command) => command.value.endsWith('.status'))!
    await status.onSelect!()
    const message = recorded.toasts.map((entry) => entry.message).join('\n')
    assert.match(message, /未配置/)
    assert.match(message, /未登录/)
    assert.match(message, /Connector：未运行/)
  })
})

test('/aa logout on a machine with no credentials is a clean no-op', async () => {
  await withTempDataDir(async () => {
    const { api, recorded } = fakeApi()
    tuiPlugin(api as never)
    const logout = aaCommands(api as never).find((command) => command.value.endsWith('.logout'))!
    await logout.onSelect!()
    const outcome = recorded.toasts.at(-1)
    assert.equal(outcome?.variant, 'success')
    assert.match(outcome?.message ?? '', /撤销设备凭据/)
  })
})
