/**
 * TUI entry point shim (packaging form **B′**, A10 probe §「对实现路径的建议」).
 *
 * A **directory** plugin is resolved by the host looking *only* for
 * `<dir>/index.ts` (server) and `<dir>/tui` → `tui.ts` / `tui/index.ts`; it
 * **never** reads `package.json#exports["./tui"]` (dist report 02 §3). Only the
 * package/npm channel consumes `exports`. This one-line forwarder, sitting next
 * to `index.ts` at the package root, is therefore what makes the directory form
 * expose a TUI entry at all.
 *
 * Bun compiles TypeScript directly, so no build step is involved. The target
 * module is the real TUI entry (`export default { id, setup }`).
 */
export { default } from './src/tui/index.ts'
