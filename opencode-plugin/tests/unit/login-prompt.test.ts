import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOGIN_PROMPT_FILE,
  clearLoginPrompt,
  expiryText,
  formatDevicePrompt,
  formatLoginPrompt,
  formatLoopbackPrompt,
  loginPromptPath,
  readLoginPrompt,
  writeLoginPrompt,
  type LoginPrompt,
} from '../../src/shared/login-prompt.js'

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-login-prompt-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function loopbackPrompt(overrides: Partial<LoginPrompt> = {}): LoginPrompt {
  return {
    version: 1,
    status: 'pending',
    kind: 'loopback',
    createdAt: 1_000,
    expiresAt: 2_000,
    instruction: '在浏览器打开授权地址并点一次「授权」。',
    authorizationUrl: 'https://api.example.com/#/plugin-oauth?state=s',
    ...overrides,
  }
}

test('the prompt file is a single atomic 0600 file that round-trips', async () => {
  await withTempDir(async (dir) => {
    const path = await writeLoginPrompt(dir, loopbackPrompt())
    assert.equal(path, loginPromptPath(dir))
    assert.equal(path, join(dir, LOGIN_PROMPT_FILE))
    // Atomic write: the temp file is renamed, so no residue and no partial read.
    assert.deepEqual(await readdir(dir), [LOGIN_PROMPT_FILE])
    assert.deepEqual(await readLoginPrompt(dir), loopbackPrompt())
  })
})

test('the prompt file is 0600 on POSIX (same discipline as the credential store)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mode bits are not enforced by the Windows ACL model')
    return
  }
  await withTempDir(async (dir) => {
    await writeLoginPrompt(dir, loopbackPrompt())
    assert.equal((await stat(loginPromptPath(dir))).mode & 0o777, 0o600)
  })
})

test('a finished flow leaves no URL and no short code behind', async () => {
  await withTempDir(async (dir) => {
    await writeLoginPrompt(dir, loopbackPrompt())
    await writeLoginPrompt(dir, {
      version: 1,
      status: 'connected',
      kind: 'loopback',
      createdAt: 3_000,
      expiresAt: 3_000,
      instruction: '登录已完成，可以关闭本文件。',
    })
    const raw = JSON.parse(await readFile(loginPromptPath(dir), 'utf8')) as Record<string, unknown>
    assert.equal(raw['status'], 'connected')
    assert.equal('authorizationUrl' in raw, false)
    assert.equal('userCode' in raw, false)
    assert.equal((await readLoginPrompt(dir))?.authorizationUrl, undefined)
  })
})

test('a malformed record reads as null and clearLoginPrompt removes the file', async () => {
  await withTempDir(async (dir) => {
    await writeFile(loginPromptPath(dir), '{ broken', 'utf8')
    assert.equal(await readLoginPrompt(dir), null)
    await writeLoginPrompt(dir, loopbackPrompt({ kind: 'device' }))
    assert.equal((await readLoginPrompt(dir))?.kind, 'device')
    await clearLoginPrompt(dir)
    assert.equal(await readLoginPrompt(dir), null)
    assert.deepEqual(await readdir(dir), [])
  })
})

test('the loopback line carries the URL, the file path and the deadline', () => {
  const prompt = loopbackPrompt({ expiresAt: Date.UTC(2026, 0, 2, 3, 4) })
  const text = formatLoopbackPrompt(prompt, '/home/u/.agents-anywhere/opencode-plugin/login.json')
  assert.match(text, /授权/)
  assert.match(text, /https:\/\/api\.example\.com\/#\/plugin-oauth\?state=s/)
  assert.match(text, /login\.json/)
  assert.match(text, /有效期至/)

  const withoutFile = formatLoopbackPrompt(prompt, null)
  assert.match(withoutFile, /登录信息文件不可用/)
  assert.match(withoutFile, new RegExp(expiryText(prompt.expiresAt)))
})

test('the device line carries the verification URI, the short code and the pre-filled link', () => {
  const prompt: LoginPrompt = {
    version: 1,
    status: 'pending',
    kind: 'device',
    createdAt: 0,
    expiresAt: 60_000,
    instruction: 'x',
    verificationUri: 'https://web.example/#/plugin-device',
    verificationUriComplete: 'https://web.example/#/plugin-device?user_code=ABCD-EFGH',
    userCode: 'ABCD-EFGH',
  }
  const text = formatDevicePrompt(prompt, '/tmp/login.json')
  assert.match(text, /https:\/\/web\.example\/#\/plugin-device/)
  assert.match(text, /ABCD-EFGH/)
  assert.match(text, /user_code=ABCD-EFGH/)
  assert.match(text, /\/tmp\/login\.json/)
  // The dispatcher never needs the caller to branch on `kind`.
  assert.equal(formatLoginPrompt(prompt, null), formatDevicePrompt(prompt, null))
  assert.equal(formatLoginPrompt(loopbackPrompt(), null), formatLoopbackPrompt(loopbackPrompt(), null))
})

test('expiryText is local, minute-precision and locale-independent', () => {
  assert.match(expiryText(Date.UTC(2026, 0, 2, 3, 4, 5)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
})
