/**
 * Bundle the Python Connector's **runtime** source into the plugin package's
 * build output, so a package-channel install is self-contained.
 *
 * Why this exists (investigation `opencode-dist/03`, hard-measured): a Git-spec
 * install (`opencode plugin add 'github:…#<ref>::path:opencode-plugin'`) packages
 * **only this subdirectory** into `node_modules`, and the installer **never runs
 * lifecycle scripts** (`ignoreScripts: true`, `saveType: "prod"` — report 01).
 * There is therefore no sibling `../connector/` at runtime and no chance to build
 * on install: the Connector can only be there if it is copied in here at build
 * time **and committed**. The supervisor looks for it at `lib/connector/`.
 *
 * Mirrors `dsh-bridge-next/scripts/bundle-connector.ts`. Only runtime material
 * travels: `pyproject.toml` + `README.md` (hatchling reads it via `readme =`) +
 * the `connector/` package. Tests, caches, `_deprecated/`, `_reference/` and
 * byte code are excluded — they are not needed to `uv run anywhere-cli`.
 *
 * `uv.lock` is deliberately **not** copied: the repository `.gitignore` ignores
 * `uv.lock`, so a copied lock would be un-committable; `uv` resolves from
 * `pyproject.toml` on first run instead.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Package root (`.../opencode-plugin/`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the Connector lands **inside the package** (repo-relative, POSIX form). */
export const BUNDLED_CONNECTOR_SUBDIR = 'lib/connector'

/** Top-level entries copied from `connector/`; everything else stays behind. */
const ENTRIES = ['pyproject.toml', 'README.md', 'connector'] as const

/** Path segments and file suffixes that are never runtime material. */
const IGNORED_DIRS = new Set([
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '_deprecated',
  '_reference',
  'tests',
])

/**
 * The same exclusion, exposed so `check-build.ts` can accept a `lib/connector/`
 * that a *running* Connector has resolved `uv` in: `uv run --directory
 * lib/connector` creates `.venv`/`__pycache__` there at runtime, which are not
 * part of any fresh bundle and must not be reported as drift.
 */
export const CONNECTOR_BUNDLE_IGNORED_DIRS: ReadonlySet<string> = IGNORED_DIRS

const defaultTarget = resolve(PACKAGE_ROOT, BUNDLED_CONNECTOR_SUBDIR)

/**
 * Copy the Connector runtime source into `target` (default `lib/connector/`).
 * Returns the copied top-level entry names. Fails loudly if the upstream layout
 * moved — a silent partial copy would only surface later, inside `uv run`.
 */
export async function bundleConnector(target: string = defaultTarget): Promise<readonly string[]> {
  const source = resolve(PACKAGE_ROOT, '..', 'connector')
  // Guard the two paths the supervisor probes: `<dir>/pyproject.toml` and
  // `<dir>/connector/cli.py`.
  await stat(resolve(source, 'connector', 'cli.py'))
  await stat(resolve(source, 'pyproject.toml'))

  await clearTarget(target)
  await mkdir(target, { recursive: true })
  for (const entry of ENTRIES) {
    await cp(`${source}/${entry}`, `${target}/${entry}`, {
      recursive: true,
      filter: (path) => {
        const parts = relative(source, path).split(sep)
        return !parts.some((part) => IGNORED_DIRS.has(part)) && !basename(path).endsWith('.pyc')
      },
    })
  }
  return ENTRIES
}

/**
 * Clear `target` so the copy below starts from the source's file set.
 *
 * A **running** Connector keeps its own `cwd` and `uv`-created `.venv` inside
 * `lib/connector/`; on Windows that makes `rm` fail with EBUSY even though every
 * runtime file is copyable. Failing the whole build there was an environment
 * trap — instead the three runtime entries are removed best-effort and the copy
 * lands in place. `.venv`/caches are excluded from the fresh bundle and from
 * `check-build`'s comparison, so they never count as drift.
 */
async function clearTarget(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true })
    return
  } catch (error) {
    if (!isLocked(error)) throw error
  }
  for (const entry of ENTRIES) {
    await rm(resolve(target, entry), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Windows sharing violations a live process can hold on its own tree. */
function isLocked(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY'
}

/** True when this module is the process entry point (not imported by a checker). */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return pathToFileURL(resolve(entry)).href.toLowerCase() === import.meta.url.toLowerCase()
}

if (invokedDirectly()) {
  await bundleConnector()
  console.log(
    `已把 Connector 运行所需源码打包进 ${BUNDLED_CONNECTOR_SUBDIR}/（含 pyproject.toml/README.md/connector/；` +
      '已排除 tests/、_deprecated/、_reference/ 与各类缓存）。',
  )
}
