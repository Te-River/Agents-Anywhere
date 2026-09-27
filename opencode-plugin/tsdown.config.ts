import { defineConfig } from 'tsdown'

// Two entry points ship from one package: the OpenCode *service* plugin (".")
// and the TUI plugin ("./tui"). Zero runtime dependencies: the bridge only uses
// Node built-ins, so nothing is bundled.
export default defineConfig([
  {
    name: 'server',
    entry: { index: 'src/server/index.ts' },
    tsconfig: 'tsconfig.server.json',
    outDir: 'lib',
    platform: 'node',
    format: 'esm',
    target: 'es2023',
    clean: true,
    sourcemap: true,
    dts: true,
    deps: { neverBundle: true },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
  {
    name: 'tui',
    entry: { tui: 'src/tui/index.ts' },
    tsconfig: 'tsconfig.tui.json',
    outDir: 'lib',
    platform: 'node',
    format: 'esm',
    target: 'es2023',
    clean: false,
    sourcemap: true,
    dts: true,
    deps: { neverBundle: true },
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  },
])
