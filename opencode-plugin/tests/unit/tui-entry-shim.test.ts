import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import shim from '../../tui.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('the root tui.ts shim forwards to the TUI entry module', () => {
  // A directory plugin is resolved as `<dir>/tui` (tui.ts / tui/index.ts); the
  // shim must therefore surface the same `{ id, setup }` module as the entry.
  assert.equal(typeof shim.setup, 'function')
  assert.equal(shim.id, 'agents-anywhere-opencode')
})

test('package.json points both install forms at the right entry', async () => {
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { types: string; default: string }>
    files: string[]
  }
  // Directory form → the root `index.ts`/`tui.ts` shims (the host ignores
  // `exports` there). Package form → `exports`, which points at the **built**
  // artifacts so a Git-spec install (no build step) still resolves. Both the
  // shims and `lib` must therefore ship.
  assert.deepEqual(pkg.exports['./tui'], { types: './lib/tui.d.ts', default: './lib/tui.js' })
  assert.deepEqual(pkg.exports['.'], { types: './lib/index.d.ts', default: './lib/index.js' })
  assert.ok(pkg.files.includes('lib'))
  assert.ok(pkg.files.includes('tui.ts'))
  assert.ok(pkg.files.includes('index.ts'))
})
