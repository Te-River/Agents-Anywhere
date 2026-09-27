import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBooleanOption, parseLoginMode, resolvePluginOptions } from '../../src/shared/plugin-options.js'

const EMPTY = {} as NodeJS.ProcessEnv

test('env wins when the option is absent; defaults when neither exists', () => {
  const fromEnv = resolvePluginOptions(undefined, {
    AGENT_SERVER_URL: 'https://env.example/api/v2',
    AGENT_AA_AUTO_LOGIN: 'off',
    AGENT_AA_LOGIN: ' DEVICE ',
    AGENT_CONNECTOR_SOURCE: '/env/connector',
  } as NodeJS.ProcessEnv)
  assert.equal(fromEnv.serverUrl, 'https://env.example')
  assert.equal(fromEnv.source.serverUrl, 'env')
  assert.equal(fromEnv.autoLogin, false)
  assert.equal(fromEnv.source.autoLogin, 'env')
  assert.equal(fromEnv.loginMode, 'device')
  assert.equal(fromEnv.source.loginMode, 'env')
  assert.equal(fromEnv.connectorSource, '/env/connector')
  assert.equal(fromEnv.source.connectorSource, 'env')

  const defaults = resolvePluginOptions(undefined, EMPTY)
  assert.equal(defaults.serverUrl, null)
  assert.equal(defaults.source.serverUrl, 'default')
  assert.equal(defaults.autoLogin, true, 'automatic login is on unless someone says otherwise')
  assert.equal(defaults.source.autoLogin, 'default')
  assert.equal(defaults.loginMode, null)
  assert.equal(defaults.connectorSource, null)
})

test('the plugin config wins per setting, over the environment', () => {
  const options = resolvePluginOptions(
    { serverUrl: 'https://opt.example/', autoLogin: false, loginMode: 'device', connectorSource: '/opt/connector' },
    { AGENT_SERVER_URL: 'https://env.example' } as NodeJS.ProcessEnv,
  )
  assert.equal(options.serverUrl, 'https://opt.example')
  assert.equal(options.source.serverUrl, 'options')
  assert.equal(options.autoLogin, false)
  assert.equal(options.source.autoLogin, 'options')
  assert.equal(options.loginMode, 'device')
  assert.equal(options.source.loginMode, 'options')
  assert.equal(options.connectorSource, '/opt/connector')
  assert.equal(options.source.connectorSource, 'options')
})

test('the whole opencode.json entry shape ({ package, options }) is unwrapped', () => {
  const options = resolvePluginOptions(
    { package: 'agents-anywhere', options: { autoLogin: false, serverUrl: 'https://opt.example' } },
    EMPTY,
  )
  assert.equal(options.autoLogin, false)
  assert.equal(options.source.autoLogin, 'options')
  assert.equal(options.serverUrl, 'https://opt.example')
})

test('an unusable option degrades to the next layer instead of throwing', () => {
  const options = resolvePluginOptions(
    { serverUrl: 'not a url', autoLogin: 'maybe', loginMode: 'neither', connectorSource: '   ' },
    { AGENT_SERVER_URL: 'https://env.example', AGENT_AA_AUTO_LOGIN: '0' } as NodeJS.ProcessEnv,
  )
  assert.equal(options.serverUrl, 'https://env.example')
  assert.equal(options.autoLogin, false)
  assert.equal(options.source.autoLogin, 'env')
  assert.equal(options.loginMode, null, 'a bogus mode means "decide automatically"')
  assert.equal(options.connectorSource, null)
  // A non-object `ctx.options` (an older host) is simply "no options".
  assert.equal(resolvePluginOptions('nonsense', EMPTY).autoLogin, true)
  assert.equal(resolvePluginOptions([] as unknown, EMPTY).serverUrl, null)
})

test('boolean and mode words are read tolerantly, anything else is "no opinion"', () => {
  for (const value of [true, 1, '1', 'true', ' TRUE ', 'yes', 'on']) {
    assert.equal(parseBooleanOption(value), true, `expected ${String(value)} to be true`)
  }
  for (const value of [false, 0, '0', 'false', 'no', 'OFF']) {
    assert.equal(parseBooleanOption(value), false, `expected ${String(value)} to be false`)
  }
  for (const value of ['maybe', 2, null, undefined, {}, []]) {
    assert.equal(parseBooleanOption(value), null, `expected ${String(value)} to be unset`)
  }
  assert.equal(parseLoginMode('Device'), 'device')
  assert.equal(parseLoginMode(' LOOPBACK '), 'loopback')
  assert.equal(parseLoginMode('browser'), null)
  assert.equal(parseLoginMode(7), null)
})
