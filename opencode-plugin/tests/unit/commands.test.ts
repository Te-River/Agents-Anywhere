import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../src/shared/logger.js'
import {
  AA_COMMANDS,
  createCommandEntries,
  createCommandFlows,
  type CommandFlows,
} from '../../src/server/command-flows.js'
import {
  createCommandRegistry,
  registerCommands,
  validateCommandEntry,
  type CommandEntry,
} from '../../src/server/commands.js'
import type { CommandDraft } from '../../src/server/opencode-ctx.js'

const SILENT = createLogger('test', () => undefined)

/**
 * A throwaway `dataDir` under the OS temp dir, removed when the test ends. The
 * login flow writes `login.json` into `dataDir`; a *relative* value here used to
 * land inside the package (`opencode-plugin/unused/login.json`) and once got
 * committed — nothing this suite does may touch the repository.
 */
async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-cmd-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A host draft double: records every payload `add` actually received. */
function fakeDraft(): { draft: CommandDraft; added: unknown[]; result: Map<string, unknown> } {
  const added: unknown[] = []
  const result = new Map<string, unknown>()
  return {
    added,
    result,
    draft: {
      add: (info) => {
        added.push(info)
        if (typeof info?.name === 'string') result.set(info.name, info)
        return result
      },
    },
  }
}

function fakeApi(draft: CommandDraft): { transform: (cb: (draft: CommandDraft) => void) => unknown } {
  return { transform: (cb) => cb(draft) }
}

function entry(name: string, description = '描述'): CommandEntry {
  return { name, description, execute: () => 'ok' }
}

function fakeFlows(calls: string[]): CommandFlows {
  return {
    login: async () => {
      calls.push('login')
      return '登录结果'
    },
    status: async () => {
      calls.push('status')
      return '状态结果'
    },
    logout: async () => {
      calls.push('logout')
      return '登出结果'
    },
  }
}

// -- command names -----------------------------------------------------------------

test('the three command names are distinct and host-legal', () => {
  const names = Object.values(AA_COMMANDS)
  assert.deepEqual(names, ['aa-login', 'aa-status', 'aa-logout'])
  assert.equal(new Set(names).size, names.length)
  for (const [index, name] of names.entries()) {
    const verdict = validateCommandEntry(entry(name), index, { has: () => false })
    assert.equal(verdict.ok, true, name)
  }
})

// -- payload shape -----------------------------------------------------------------

test('the payload handed to add is exactly {name, description, execute}', () => {
  const { draft, added } = fakeDraft()
  const result = registerCommands(fakeApi(draft), createCommandEntries(fakeFlows([])), {
    logger: SILENT,
    registry: createCommandRegistry(),
  })
  assert.deepEqual(result.registered, ['aa-login', 'aa-status', 'aa-logout'])
  assert.deepEqual(result.rejected, [])
  assert.equal(added.length, 3)
  for (const payload of added) {
    assert.deepEqual(Object.keys(payload as object), ['name', 'description', 'execute'])
    const info = payload as { name: unknown; description: unknown; execute: unknown }
    assert.equal(typeof info.name, 'string')
    assert.equal(typeof info.description, 'string')
    assert.equal(typeof info.execute, 'function')
  }
  assert.equal((added[0] as { name: string }).name, 'aa-login')
})

test('a host without ctx.command.transform registers nothing and does not throw', () => {
  const result = registerCommands(undefined, createCommandEntries(fakeFlows([])), {
    logger: SILENT,
    registry: createCommandRegistry(),
  })
  assert.deepEqual(result, { registered: [], rejected: [] })
})

test('a draft without add is tolerated (the runtime draft is not trusted)', () => {
  const result = registerCommands({ transform: (cb) => cb({}) }, createCommandEntries(fakeFlows([])), {
    logger: SILENT,
    registry: createCommandRegistry(),
  })
  assert.deepEqual(result, { registered: [], rejected: [] })
})

test('an add that throws is reported per command, never fatal', () => {
  const transform = (cb: (draft: CommandDraft) => void): unknown =>
    cb({
      add: () => {
        throw new Error('registry refused')
      },
    })
  const result = registerCommands(
    { transform },
    [entry('aa-login'), entry('aa-status')],
    { logger: SILENT, registry: createCommandRegistry() },
  )
  assert.deepEqual(result.registered, [])
  assert.deepEqual(result.rejected, [])
})

test('an add that swallows a schema error (returns a Map without the name) still reports registered', () => {
  // The measured trap: `add` returns a Map and hides the failure. We must not
  // pretend the command exists when the host's Map says otherwise.
  const transform = (cb: (draft: CommandDraft) => void): unknown =>
    cb({ add: () => new Map() })
  const result = registerCommands({ transform }, [entry('aa-login')], {
    logger: SILENT,
    registry: createCommandRegistry(),
  })
  // The swallow is logged (see `commands.ts`), and the name is *not* claimed.
  assert.deepEqual(result.registered, [])
})

// -- uniqueness --------------------------------------------------------------------

test('a duplicate name inside one batch is rejected before add', () => {
  const { draft, added } = fakeDraft()
  const result = registerCommands(fakeApi(draft), [entry('aa-login'), entry('aa-login')], {
    logger: SILENT,
    registry: createCommandRegistry(),
  })
  assert.deepEqual(result.registered, ['aa-login'])
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]?.name, 'aa-login')
  assert.match(result.rejected[0]?.reason ?? '', /已被占用/)
  assert.equal(added.length, 1, 'only the first candidate may reach add')
})

test('a second plugin instance in the same process cannot re-register a taken name', () => {
  const registry = createCommandRegistry()
  const first = fakeDraft()
  registerCommands(fakeApi(first.draft), [entry('aa-login')], { logger: SILENT, registry })
  const second = fakeDraft()
  const result = registerCommands(fakeApi(second.draft), [entry('aa-login')], { logger: SILENT, registry })
  assert.deepEqual(result.registered, [])
  assert.equal(second.added.length, 0)
  assert.match(result.rejected[0]?.reason ?? '', /已被占用/)
})

// -- invalid input: nothing illegal may reach the registry -------------------------

test('every illegal candidate is blocked before add and reported', () => {
  const illegal: unknown[] = [
    'aa-login', // not an object
    null,
    { description: '没有 name', execute: () => 'x' },
    { name: 42, description: 'x', execute: () => 'x' }, // non-string name (the 500 case)
    { name: '', description: 'x', execute: () => 'x' },
    { name: 'AA LOGIN', description: 'x', execute: () => 'x' }, // illegal syntax
    { name: 'aa/login', description: 'x', execute: () => 'x' },
    { name: `aa-${'x'.repeat(80)}`, description: 'x', execute: () => 'x' }, // too long
    { name: 'aa-login', description: 7, execute: () => 'x' }, // non-string description
    { name: 'aa-login', description: 'x', execute: 'not a function' },
    { name: 'aa-login', description: 'x' }, // no execute
  ]
  const { draft, added } = fakeDraft()
  const result = registerCommands(fakeApi(draft), illegal, {
    logger: SILENT,
    registry: createCommandRegistry(),
  })
  assert.deepEqual(result.registered, [])
  assert.equal(result.rejected.length, illegal.length)
  assert.equal(added.length, 0, 'no rejected payload may reach the host registry')
  for (const issue of result.rejected) {
    assert.equal(typeof issue.reason, 'string')
    assert.ok(issue.reason.length > 0)
  }
})

test('a legal candidate survives even when surrounded by illegal ones', () => {
  const { draft, added } = fakeDraft()
  const result = registerCommands(
    fakeApi(draft),
    [undefined, entry('aa-status'), { name: 7 }, { name: 'aa-status', description: 3, execute: () => 'x' }],
    { logger: SILENT, registry: createCommandRegistry() },
  )
  assert.deepEqual(result.registered, ['aa-status'])
  assert.equal(result.rejected.length, 3)
  assert.equal(added.length, 1)
  assert.equal((added[0] as { name: string }).name, 'aa-status')
})

test('an over-long description is truncated, never rejected', () => {
  const verdict = validateCommandEntry(
    { name: 'aa-login', description: 'd'.repeat(500), execute: () => 'x' },
    0,
    { has: () => false },
  )
  assert.equal(verdict.ok, true)
  assert.equal(verdict.ok && verdict.entry.description.length, 200)
})

// -- execute dispatch --------------------------------------------------------------

test('each registered execute dispatches to its own flow and returns that flow text', async () => {
  const calls: string[] = []
  const entries = createCommandEntries(fakeFlows(calls))
  const byName = new Map(entries.map((item) => [item.name, item]))
  assert.equal(await byName.get(AA_COMMANDS.login)?.execute(), '登录结果')
  assert.equal(await byName.get(AA_COMMANDS.status)?.execute(), '状态结果')
  assert.equal(await byName.get(AA_COMMANDS.logout)?.execute(), '登出结果')
  assert.deepEqual(calls, ['login', 'status', 'logout'])
  // The host's `execute` argument is passed through untouched (its real shape is
  // unobserved — see the reply's "未验证项").
  assert.equal(await byName.get(AA_COMMANDS.status)?.execute({ anything: true }), '状态结果')
})

test('a throwing flow answers with an actionable line instead of rejecting', async () => {
  const flows: CommandFlows = {
    login: async () => {
      throw new Error('boom')
    },
    status: async () => 'ok',
    logout: async () => 'ok',
  }
  const entries = createCommandEntries(flows)
  const login = entries.find((item) => item.name === AA_COMMANDS.login)
  const text = await login?.execute()
  assert.equal(typeof text, 'string')
  assert.match(text ?? '', /失败/)
  assert.match(text ?? '', /下一步/)
})

// -- flows (fake onboarding: no socket, no browser, no spawn) ----------------------

test('the login flow delegates to the shared Onboarding and reports the state line', async (t) => {
  const dataDir = await tempDataDir(t)
  let logins = 0
  const flows = createCommandFlows({
    logger: SILENT,
    env: {} as NodeJS.ProcessEnv,
    onboarding: () => ({
      dataDir,
      login: async () => {
        logins += 1
        return {
          ok: true,
          stage: { stage: 'connected', apiBaseUrl: 'https://api.example.com', userId: 'user_1', connectorId: 'cxt_1', reusedDevice: false },
        }
      },
      logout: async () => undefined,
      status: async () => ({
        configured: true,
        apiBaseUrl: 'https://api.example.com',
        loggedIn: true,
        accountExpiresAt: null,
        userId: 'user_1',
        displayName: 'User One',
        connectorId: 'cxt_1',
        connectorRunning: true,
        credentialProblem: null,
      }),
    }),
  })
  const text = await flows.login()
  assert.equal(logins, 1)
  assert.match(text, /已连接/)
  assert.match(text, /user_1/)
})

test('the status flow prints server/account/device/host/capability lines', async (t) => {
  const dataDir = await tempDataDir(t)
  const flows = createCommandFlows({
    logger: SILENT,
    onboarding: () => ({
      dataDir,
      login: async () => ({ ok: false, code: 'x', message: 'y' }),
      logout: async () => undefined,
      status: async () => ({
        configured: false,
        apiBaseUrl: null,
        loggedIn: false,
        accountExpiresAt: null,
        userId: null,
        displayName: null,
        connectorId: null,
        connectorRunning: false,
        credentialProblem: null,
      }),
    }),
    host: () => ({ version: '2.0.18', supported: true, capabilities: ['事件流', '命令面板'] }),
  })
  const text = await flows.status()
  assert.match(text, /Agents Anywhere 状态/)
  assert.match(text, /服务器：未配置/)
  assert.match(text, /账号：未登录/)
  assert.match(text, /设备：未绑定/)
  assert.match(text, /OpenCode 2\.0\.18/)
  assert.match(text, /事件流 · 命令面板/)
})

test('aa-status names a rejected device credential with the next step (never a bare offline)', async (t) => {
  const dataDir = await tempDataDir(t)
  const problem =
    '设备凭据被服务器拒绝（HTTP 401）：本地保存的 Connector 凭据与服务端不一致。' +
    '下一步：插件会自动轮换设备凭据并重启 Connector；若仍失败，请运行 /aa-login 重新登录。'
  const flows = createCommandFlows({
    logger: SILENT,
    onboarding: () => ({
      dataDir,
      login: async () => ({ ok: false, code: 'x', message: 'y' }),
      logout: async () => undefined,
      status: async () => ({
        configured: true,
        apiBaseUrl: 'https://api.example.com',
        loggedIn: true,
        accountExpiresAt: null,
        userId: 'user_1',
        displayName: 'User One',
        connectorId: 'cxt_1',
        connectorRunning: false,
        credentialProblem: problem,
      }),
    }),
  })
  const text = await flows.status()
  assert.match(text, /设备凭据：/)
  assert.match(text, /HTTP 401/)
  assert.match(text, /\/aa-login/)
})

test('the logout flow calls Onboarding.logout (revoke → local clear → own Connector stop)', async (t) => {
  const dataDir = await tempDataDir(t)
  let loggedOut = 0
  const flows = createCommandFlows({
    logger: SILENT,
    onboarding: () => ({
      dataDir,
      login: async () => ({ ok: false, code: 'x', message: 'y' }),
      logout: async () => {
        loggedOut += 1
      },
      status: async () => {
        throw new Error('not used')
      },
    }),
  })
  const text = await flows.logout()
  assert.equal(loggedOut, 1)
  assert.match(text, /撤销/)
})

test('a status failure is reported as text, never thrown', async (t) => {
  const dataDir = await tempDataDir(t)
  const flows = createCommandFlows({
    logger: SILENT,
    onboarding: () => ({
      dataDir,
      login: async () => ({ ok: false, code: 'x', message: 'y' }),
      logout: async () => undefined,
      status: async () => {
        throw new Error('credential store unreadable')
      },
    }),
  })
  const entries = createCommandEntries(flows)
  const text = await entries.find((item) => item.name === AA_COMMANDS.status)?.execute()
  assert.match(text ?? '', /状态查询失败/)
  assert.match(text ?? '', /下一步/)
})
