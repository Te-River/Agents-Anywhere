/**
 * Package root entry point (packaging form **B′**, dist report §4.1).
 *
 * The OpenCode `file:` source resolves a directory plugin by looking **only**
 * for `INDEX_FILES` at the directory root (`index.ts|tsx|js|mjs|cjs`) and
 * ignores `package.json#exports` entirely — failing **silently** when it finds
 * nothing (measured: dist report 02, matrix Z1/Z7). Bun compiles TypeScript
 * directly, so this one-line forwarder is the whole reason a `file:` install
 * loads at all.
 *
 * The npm/git channel *does* consume `exports`, which is why `package.json`
 * keeps `exports["."]` pointing here and `exports["./tui"]` at the TUI source.
 * Do not delete this file, and do not let a bundler emit over it.
 */
export { default } from './src/server/index.ts'
