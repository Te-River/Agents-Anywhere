import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUNDLED_CONNECTOR_SUBDIR,
  ConnectorOwnershipError,
  ConnectorSourceError,
  ConnectorSupervisor,
  UvUnavailableError,
  connectorEnv,
  windowsTreeKillArgs,
  type ConnectorLauncher,
  type ConnectorSpawnConfig,
} from '../../src/server/connector-supervisor.js'
import { createLogger } from '../../src/shared/logger.js'
import { readOwnership } from '../../src/server/connector-ownership.js'

const SILENT = createLogger('test', () => undefined)

// -- a fully in-memory child: no process is ever spawned by this file ---------

class FakeStream extends EventEmitter {
  setEncoding(): void {
    // The fake carries already-decoded strings; the call only needs to exist.
  }
}

class FakeStdin extends EventEmitter {
  readonly written: string[] = []
  #onEnd: (() => void) | null = null
  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }
  end(): void {
    this.#onEnd?.()
  }
  onEnd(callback: () => void): void {
    this.#onEnd = callback
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeStdin()
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly pid: number // 0 (default) keeps `#terminate` a no-op and nothing is signalled
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly methods: string[] = []
  #buffer = ''

  constructor(pid = 0) {
    super()
    this.pid = pid
    // Closing stdin is the supervisor's graceful-stop signal; answer it with the
    // `close` event a real child would emit.
    this.stdin.onEnd(() => {
      setImmediate(() => {
        if (this.exitCode === null) this.exitCode = 0
        this.emit('close', this.exitCode)
      })
    })
    // Reply to each NDJSON request exactly as the Python Connector does.
    const originalWrite = this.stdin.write.bind(this.stdin)
    this.stdin.write = (chunk: string): boolean => {
      this.#buffer += chunk
      let index = this.#buffer.indexOf('\n')
      while (index !== -1) {
        const line = this.#buffer.slice(0, index)
        this.#buffer = this.#buffer.slice(index + 1)
        if (line.trim().length > 0) this.#handle(JSON.parse(line) as { id: number; method: string })
        index = this.#buffer.indexOf('\n')
      }
      return originalWrite(chunk)
    }
  }

  #reply(id: number, result: unknown): void {
    this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  #handle(frame: { id: number; method: string }): void {
    this.methods.push(frame.method)
    if (frame.method === 'connector.getState') {
      this.#reply(frame.id, { running: this.methods.includes('connector.start'), authFailed: false })
      return
    }
    if (frame.method === 'connector.stop') {
      this.#reply(frame.id, { running: false, authFailed: false })
      return
    }
    this.#reply(frame.id, { running: true, authFailed: false })
  }

  notifyState(state: { running: boolean; authFailed: boolean }): void {
    this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', method: 'connector/state', params: state })}\n`)
  }

  crash(code = 1): void {
    this.exitCode = code
    this.emit('close', code)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Write the two paths `isConnectorSource` probes (`pyproject.toml`, `cli.py`). */
async function writeConnectorSource(dir: string): Promise<void> {
  await mkdir(join(dir, 'connector'), { recursive: true })
  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "anywhere-cli"\n', 'utf8')
  await writeFile(join(dir, 'connector', 'cli.py'), '# fake\n', 'utf8')
}

async function withFakeSource(run: (sourceDir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aa-oc-src-'))
  await writeConnectorSource(dir)
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const config = (dataDir: string): ConnectorSpawnConfig => ({
  apiBaseUrl: 'https://api.example.com',
  connectorId: 'cxt_1',
  connectorToken: 'token-value',
  dataDir,
})

// -- source / uv resolution ---------------------------------------------------

test('source resolution prefers the explicit/env override, then the bundled copy, then the dev sibling', () => {
  const explicit = new ConnectorSupervisor({ logger: SILENT, packageDir: 'D:/repo/opencode-plugin', sourceDir: 'D:/custom' })
  assert.deepEqual(explicit.sourceCandidates(), ['D:/custom'])

  const fromEnv = new ConnectorSupervisor({
    logger: SILENT,
    packageDir: 'D:/repo/opencode-plugin',
    env: { AGENT_CONNECTOR_SOURCE: 'D:/from-env' } as NodeJS.ProcessEnv,
  })
  assert.deepEqual(fromEnv.sourceCandidates(), ['D:/from-env'])

  const defaults = new ConnectorSupervisor({ logger: SILENT, packageDir: 'D:/repo/opencode-plugin', env: {} as NodeJS.ProcessEnv })
  const asPosix = (path: string): string => path.replaceAll('\\', '/')
  const bundled = asPosix(join('D:/repo/opencode-plugin', BUNDLED_CONNECTOR_SUBDIR))
  assert.deepEqual(defaults.sourceCandidates().map(asPosix), [bundled, 'D:/repo/connector'])
  assert.equal(asPosix(defaults.resolveSourceDir()), bundled)
})

test('prepare() resolves the in-package bundled Connector when no sibling exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-bundled-only-'))
  try {
    // No sibling `connector/` next to the package: only the bundled copy exists,
    // so a fall-through to the sibling would throw here.
    await writeConnectorSource(join(root, 'opencode-plugin', BUNDLED_CONNECTOR_SUBDIR))
    const supervisor = new ConnectorSupervisor({
      logger: SILENT,
      packageDir: join(root, 'opencode-plugin'),
      env: {} as NodeJS.ProcessEnv,
      resolveUv: async () => 'uv',
    })
    await supervisor.prepare()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Connector bundled into the package wins over the sibling checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aa-oc-bundled-'))
  const pkg = join(root, 'opencode-plugin')
  const bundled = join(pkg, BUNDLED_CONNECTOR_SUBDIR)
  const sibling = join(root, 'connector')
  try {
    await writeConnectorSource(bundled)
    await writeConnectorSource(sibling)
    const launchArgs: string[][] = []
    const spawn: ConnectorLauncher = (_command, args) => {
      launchArgs.push(args)
      return new FakeChild() as unknown as ReturnType<ConnectorLauncher>
    }
    const supervisor = new ConnectorSupervisor({ logger: SILENT, packageDir: pkg, spawn, resolveUv: async () => 'uv' })
    await supervisor.start(config(join(root, 'data')))
    // `--directory` names the spawned source dir: the bundled copy, not the sibling.
    assert.equal(launchArgs[0]![launchArgs[0]!.indexOf('--directory') + 1], bundled)
    await supervisor.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepare() fails with an actionable error when the source or uv is missing', async () => {
  const missingSource = new ConnectorSupervisor({
    logger: SILENT,
    packageDir: 'D:/repo/opencode-plugin',
    env: { AGENT_CONNECTOR_SOURCE: join(tmpdir(), 'definitely-not-here-aa') } as NodeJS.ProcessEnv,
    resolveUv: async () => 'uv',
  })
  await assert.rejects(
    missingSource.prepare(),
    (error: unknown) => error instanceof ConnectorSourceError && /AGENT_CONNECTOR_SOURCE/.test((error as Error).message),
  )

  await withFakeSource(async (sourceDir) => {
    const noUv = new ConnectorSupervisor({ logger: SILENT, sourceDir, resolveUv: async () => null })
    await assert.rejects(
      noUv.prepare(),
      (error: unknown) => error instanceof UvUnavailableError && /uv/.test((error as Error).message),
    )
    const ok = new ConnectorSupervisor({ logger: SILENT, sourceDir, resolveUv: async () => '/usr/bin/uv' })
    await ok.prepare()
  })
})

test('connectorEnv pins the owner kind, data dir and unbuffered Python', () => {
  const env = connectorEnv({ PATH: 'x' } as NodeJS.ProcessEnv, 'D:/data')
  assert.equal(env['AA_CONNECTOR_OWNER_KIND'], 'opencode-plugin')
  assert.equal(env['AGENT_CONNECTOR_DATA_DIR'], 'D:/data')
  assert.equal(env['PYTHONUNBUFFERED'], '1')
  assert.equal(env['PATH'], 'x')
})

test('the Windows stop targets the whole process tree, not just uv', () => {
  // `uv` runs the Connector as a grandchild python process; a plain child.kill
  // leaves it orphaned (audit M8). `/T` walks the tree, `/F` forces.
  assert.deepEqual(windowsTreeKillArgs(4242, true), ['/pid', '4242', '/T', '/F'])
  assert.deepEqual(windowsTreeKillArgs(4242, false), ['/pid', '4242', '/T'])
})

// -- lifecycle ----------------------------------------------------------------

test('start() writes the connector config and drives getState then start over stdio', async () => {
  await withFakeSource(async (sourceDir) => {
    const dataDir = join(sourceDir, 'data')
    const children: FakeChild[] = []
    const launchArgs: string[][] = []
    const spawn: ConnectorLauncher = (_command, args) => {
      launchArgs.push(args)
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ReturnType<ConnectorLauncher>
    }
    const states: Array<{ running: boolean }> = []
    const supervisor = new ConnectorSupervisor({
      logger: SILENT,
      sourceDir,
      spawn,
      resolveUv: async () => '/usr/bin/uv',
      onState: (state) => states.push({ running: state.running }),
    })
    await supervisor.start(config(dataDir))

    assert.deepEqual(children[0]!.methods, ['connector.getState', 'connector.start'])
    assert.ok(launchArgs[0]!.includes('anywhere-cli') && launchArgs[0]!.includes('rpc'))
    assert.equal(launchArgs[0]![launchArgs[0]!.indexOf('--directory') + 1], sourceDir)

    const written = JSON.parse(await readFile(join(dataDir, 'connector.json'), 'utf8')) as Record<string, unknown>
    assert.equal(written['serverUrl'], 'https://api.example.com')
    assert.equal(written['connectorId'], 'cxt_1')
    assert.equal(written['connectorToken'], 'token-value')
    assert.equal(written['syncExistingOnConnect'], true)

    children[0]!.notifyState({ running: true, authFailed: false })
    assert.equal(supervisor.running, true)
    assert.deepEqual(states.at(-1), { running: true })

    await supervisor.stop()
    assert.ok(children[0]!.methods.includes('connector.stop'))
    assert.equal(supervisor.running, false)
    assert.equal(supervisor.lastError, null)
  })
})

test('an already-running Connector maps to a recoverable ownership error', async () => {
  await withFakeSource(async (sourceDir) => {
    const spawn: ConnectorLauncher = () => {
      const child = new FakeChild()
      // `connector.start` fails the way Python reports a held OS lease.
      const original = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk: string): boolean => {
        const frame = JSON.parse(chunk) as { id: number; method: string }
        if (frame.method === 'connector.start') {
          child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32009, data: { reason: 'connector_already_running' } } })}\n`)
          return true
        }
        return original(chunk)
      }
      return child as unknown as ReturnType<ConnectorLauncher>
    }
    const supervisor = new ConnectorSupervisor({ logger: SILENT, sourceDir, spawn, resolveUv: async () => 'uv' })
    await assert.rejects(supervisor.start(config(join(sourceDir, 'data'))), (error: unknown) => error instanceof ConnectorOwnershipError)
  })
})

test('a crash reports runtime_error and reconnects on the injected schedule', async () => {
  await withFakeSource(async (sourceDir) => {
    const children: FakeChild[] = []
    const spawn: ConnectorLauncher = () => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ReturnType<ConnectorLauncher>
    }
    const reports: Array<{ code: string; retryable: boolean; attempt: number }> = []
    const retry: { fn: (() => void) | null } = { fn: null }
    const supervisor = new ConnectorSupervisor({
      logger: SILENT,
      sourceDir,
      spawn,
      resolveUv: async () => 'uv',
      scheduleRetry: (callback) => { retry.fn = callback; return () => { retry.fn = null } },
      onRuntimeError: (info) => reports.push(info),
    })
    await supervisor.start(config(join(sourceDir, 'data')))
    assert.equal(children.length, 1)

    children[0]!.crash(7)
    assert.deepEqual(reports, [{ code: 'runtime_error', retryable: true, attempt: 1 }])
    assert.equal(supervisor.running, false)
    assert.ok(retry.fn !== null, 'a retry was scheduled')

    // Fire the scheduled retry: a second child replaces the dead one.
    retry.fn!()
    await waitFor(() => children.length === 2)
    assert.equal(supervisor.attempts, 1, 'the consecutive-failure counter survives a successful restart')
    await supervisor.stop()
  })
})

test('reconnect attempts stop at the configured maximum and are marked non-retryable', async () => {
  await withFakeSource(async (sourceDir) => {
    const children: FakeChild[] = []
    const spawn: ConnectorLauncher = () => {
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ReturnType<ConnectorLauncher>
    }
    const reports: Array<{ retryable: boolean; attempt: number }> = []
    const retry: { fn: (() => void) | null } = { fn: null }
    const supervisor = new ConnectorSupervisor({
      logger: SILENT,
      sourceDir,
      spawn,
      resolveUv: async () => 'uv',
      maxRestartAttempts: 2,
      scheduleRetry: (callback) => { retry.fn = callback; return () => { retry.fn = null } },
      onRuntimeError: (info) => reports.push({ retryable: info.retryable, attempt: info.attempt }),
    })
    await supervisor.start(config(join(sourceDir, 'data')))

    // Crash 1 -> attempt 1, retry scheduled and fired.
    children[0]!.crash(1)
    assert.equal(retry.fn !== null, true)
    retry.fn!()
    await waitFor(() => children.length === 2)

    // Crash 2 -> attempt 2, still retryable.
    children[1]!.crash(1)
    assert.equal(retry.fn !== null, true)
    retry.fn!()
    await waitFor(() => children.length === 3)

    // Crash 3 -> attempt 3 exceeds the limit: reported but never re-scheduled.
    children[2]!.crash(1)
    assert.deepEqual(reports, [
      { retryable: true, attempt: 1 },
      { retryable: true, attempt: 2 },
      { retryable: false, attempt: 3 },
    ])
    assert.equal(supervisor.attempts, 3)
    await supervisor.stop()
  })
})

test('two concurrent start() calls share exactly one launch', async () => {
  await withFakeSource(async (sourceDir) => {
    const children: FakeChild[] = []
    let launches = 0
    const spawn: ConnectorLauncher = () => {
      launches += 1
      const child = new FakeChild()
      children.push(child)
      return child as unknown as ReturnType<ConnectorLauncher>
    }
    const supervisor = new ConnectorSupervisor({ logger: SILENT, sourceDir, spawn, resolveUv: async () => 'uv' })
    const cfg = config(join(sourceDir, 'data'))
    await Promise.all([supervisor.start(cfg), supervisor.start(cfg)])
    assert.equal(launches, 1, 'two concurrent starts must not fork two uv trees')
    assert.equal(children.length, 1)
    await supervisor.stop()
  })
})

test('start() records our own child (so a later setup adopts it) and stop() clears it', async () => {
  await withFakeSource(async (sourceDir) => {
    const dataDir = join(sourceDir, 'data')
    const spawn: ConnectorLauncher = () => new FakeChild(4242) as unknown as ReturnType<ConnectorLauncher>
    const seen: number[] = []
    const supervisor = new ConnectorSupervisor({
      logger: SILENT,
      sourceDir,
      spawn,
      resolveUv: async () => 'uv',
      onChild: (info) => seen.push(info.pid),
    })
    await supervisor.start(config(dataDir))
    assert.deepEqual(seen, [4242], 'the launch was announced to the owner')
    const recorded = await readOwnership(dataDir)
    assert.equal(recorded.child?.pid, 4242)
    assert.equal(recorded.child?.connectorId, 'cxt_1')
    await supervisor.stop()
    assert.equal((await readOwnership(dataDir)).child, null, 'our record is dropped on stop')
  })
})

test('stop() on a supervisor that only reused a Connector signals nothing (dispose safety)', async () => {
  let launches = 0
  const supervisor = new ConnectorSupervisor({
    logger: SILENT,
    sourceDir: join(tmpdir(), 'aa-oc-never-a-connector'),
    spawn: () => {
      launches += 1
      throw new Error('a reused Connector must never be spawned or killed')
    },
    resolveUv: async () => 'uv',
  })
  await supervisor.stop()
  assert.equal(launches, 0)
  assert.equal(supervisor.running, false)
})

test('a refused start() forks once and never schedules a reconnect', async () => {
  await withFakeSource(async (sourceDir) => {
    const children: FakeChild[] = []
    const spawn: ConnectorLauncher = () => {
      const child = new FakeChild()
      children.push(child)
      const original = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk: string): boolean => {
        const frame = JSON.parse(chunk) as { id: number; method: string }
        if (frame.method === 'connector.start') {
          child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32009, data: { reason: 'connector_already_running', owner: { kind: 'desktop-workbench', pid: 4242 } } } })}\n`)
          return true
        }
        return original(chunk)
      }
      return child as unknown as ReturnType<ConnectorLauncher>
    }
    let retries = 0
    const supervisor = new ConnectorSupervisor({
      logger: SILENT,
      sourceDir,
      spawn,
      resolveUv: async () => 'uv',
      scheduleRetry: () => {
        retries += 1
        return () => undefined
      },
    })
    await assert.rejects(
      supervisor.start(config(join(sourceDir, 'data'))),
      (error: unknown) =>
        error instanceof ConnectorOwnershipError && error.owner.pid === 4242 && error.owner.kind === 'desktop-workbench',
    )
    assert.equal(children.length, 1, 'a refused start must not fork a second tree')
    assert.equal(retries, 0, 'a refused start must not schedule a reconnect')
  })
})
