/**
 * Client bundle build.
 *
 * Two artifacts from one source tree:
 *
 * - `lib/client.js` — the DSH plugin entry. The shell loads it through its
 *   `__ModuleLoader__` registry rather than as an ES module, so the CJS output
 *   is wrapped in the loader's lazy factory and `react`, `react/jsx-runtime`
 *   and the UI primitives resolve from the shell's own seeded modules. Nothing
 *   in the factory runs until the shell decides to load the plugin. publint
 *   warns that the `./client` export is CJS read as ESM; that is a Node-only
 *   heuristic misreading the convention every `@deepseek-ai/dsh-client-*`
 *   package ships, and renaming the file would break the shell's resolution.
 * - `lib/standalone/` — the standalone page, built by Vite (see
 *   `vite.client.config.ts`), which does bundle React.
 */

import { defineConfig } from 'tsdown'

/** Modules the DSH shell seeds; bundling our own copy would break hooks. */
const SHELL_PROVIDED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * The loader hands the factory a `require` and expects `module.exports` back,
 * so the CJS preamble it would otherwise get from a Node module scope has to be
 * declared by hand — same shape the shipped DSH bundles emit.
 */
const BANNER = [
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-mqtt",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
].join('\n')

export default defineConfig({
  entry: ['src/client/index.tsx'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  minify: false,
  deps: {
    neverBundle: SHELL_PROVIDED,
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: BANNER,
    footer: '\t\treturn module.exports;\n\t}\n});',
  },
})
