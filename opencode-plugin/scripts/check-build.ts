/**
 * `yarn check:build` — prove the **committed** build output is exactly what a
 * fresh build produces, so a Git-spec install (which never runs a build) cannot
 * ship stale or hand-edited artifacts.
 *
 * It re-builds in isolation and compares byte-for-byte, instead of trusting a
 * prior `yarn build` (which would make the comparison vacuous):
 *   1. every `main` / `types` / `exports` target exists and the directory-form
 *      shims are present;
 *   2. `lib/connector/` == a freshly re-bundled Connector (source of truth
 *      `../connector`, via `bundleConnector`);
 *   3. `lib/` (the tsdown output) == a fresh tsdown build into a scratch dir;
 *   4. both packaged entry points still load and expose a default export.
 *
 * The scratch dir sits **one level under the package root**, the same depth as
 * `lib/`, so source-map `sources` stay relative and comparable.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BUNDLED_CONNECTOR_SUBDIR,
  CONNECTOR_BUNDLE_IGNORED_DIRS,
  PACKAGE_ROOT,
  bundleConnector,
} from './bundle-connector.ts'

interface Manifest {
  main: string
  types: string
  exports: Record<string, string | { types: string; default: string }>
  files: string[]
}

const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as Manifest

const entryTargets: string[] = [manifest.main, manifest.types]
for (const target of Object.values(manifest.exports)) {
  entryTargets.push(...(typeof target === 'string' ? [target] : [target.types, target.default]))
}

// 1. Entry targets + directory-form shims must exist on disk.
for (const target of entryTargets) {
  if (!target.startsWith('./') || target.includes('*')) continue
  await access(resolve(PACKAGE_ROOT, target))
}
await access(join(PACKAGE_ROOT, 'index.ts'))
await access(join(PACKAGE_ROOT, 'tui.ts'))

// The Git-spec installer ships only `files`; the artifacts and the bundled
// Connector must be listed there or a package install arrives empty-handed.
for (const required of ['lib', 'index.ts', 'tui.ts', 'src']) {
  assert.ok(manifest.files.includes(required), `package.json#files must ship "${required}"`)
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)))
    else out.push(rel)
  }
  return out.sort()
}

async function digest(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Assert `actualRoot` matches `expectedRoot` byte-for-byte (same file set). */
async function compareTrees(expectedRoot: string, actualRoot: string, label: string, ignore: readonly string[] = []): Promise<void> {
  // A runtime `uv` resolve leaves `.venv`/`__pycache__` inside `lib/connector`;
  // neither is part of a fresh bundle, so they are excluded from the drift
  // comparison exactly as `bundleConnector` excludes them from the copy.
  const keep = (rel: string): boolean =>
    !rel.endsWith('.pyc') && !ignore.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
  const expected = (await listFiles(expectedRoot)).filter(keep)
  const actual = (await listFiles(actualRoot)).filter(keep)
  const missing = expected.filter((rel) => !actual.includes(rel))
  const extra = actual.filter((rel) => !expected.includes(rel))
  const changed: string[] = []
  for (const rel of expected.filter((item) => actual.includes(item))) {
    if ((await digest(join(expectedRoot, rel))) !== (await digest(join(actualRoot, rel)))) changed.push(rel)
  }
  assert.deepEqual(
    { missing, extra, changed },
    { missing: [], extra: [], changed: [] },
    `${label} 与重新构建的结果不一致（missing=${missing.join(',')} extra=${extra.join(',')} changed=${changed.join(',')}）`,
  )
}

const tsdownBin = createRequire(import.meta.url).resolve('tsdown/run')

/** Re-run the real tsdown build into `outDir` — the same pipeline `yarn build` uses. */
function rebuildBundles(outDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsdownBin, '--config', 'tsdown.config.ts', '--out-dir', outDir], {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`tsdown 重新构建失败（exit ${code ?? 'signal'}）`))
    })
  })
}

// 2. The bundled Connector must equal a fresh bundle of `../connector`.
const connectorScratch = await mkdtemp(join(tmpdir(), 'aa-oc-connector-'))
try {
  await bundleConnector(join(connectorScratch, 'connector'))
  await compareTrees(
    join(connectorScratch, 'connector'),
    resolve(PACKAGE_ROOT, BUNDLED_CONNECTOR_SUBDIR),
    '打包进包的 Connector',
    // `uv run` in this directory also writes a lock file beside `.venv`.
    [...CONNECTOR_BUNDLE_IGNORED_DIRS, 'uv.lock'],
  )
} finally {
  await rm(connectorScratch, { recursive: true, force: true })
}

// 3. The committed tsdown output must equal a fresh build into a scratch dir.
//    Drive the real `tsdown` CLI (not the programmatic API) so the pipeline —
//    including code-splitting decisions — is exactly the one `yarn build` uses.
const driftDir = resolve(PACKAGE_ROOT, '.drift-check')
try {
  await rm(driftDir, { recursive: true, force: true })
  await rebuildBundles(driftDir)
  // `lib/` also holds `connector/` (checked above), so ignore it here.
  await compareTrees(driftDir, resolve(PACKAGE_ROOT, 'lib'), '构建产物 lib/', ['connector'])
} finally {
  await rm(driftDir, { recursive: true, force: true })
}

// 4. Both packaged entry points must load and expose a default export.
for (const target of ['./lib/index.js', './lib/tui.js']) {
  const url = pathToFileURL(resolve(PACKAGE_ROOT, target)).href
  const loaded = (await import(url)) as { default?: unknown }
  assert.ok(loaded.default !== undefined, `${target} must have a default export`)
}

console.log(
  '构建产物检查通过：入口/`files` 完整、打包进包的 Connector 与 `lib/` 均与重新构建的结果逐字节一致、两个入口可加载。',
)
