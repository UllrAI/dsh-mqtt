import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * The primitives bundle ends with a `sourceMappingURL` comment but ships no map,
 * so Vite logs a failed map load on every run. Serve the file without that
 * comment; nothing in a test run needs the mapping.
 */
const dropMissingSourcemap: Plugin = {
  name: 'dsh-mqtt:drop-missing-sourcemap',
  enforce: 'pre',
  async load(id) {
    if (!id.includes('dsh-client-ui-primitives') || !id.endsWith('.js')) return null
    const code = await readFile(id, 'utf8')
    return code.replace(/\n\/\/# sourceMappingURL=.*$/, '')
  },
}

export default defineConfig({
  // The root tsconfig has no `jsx` setting — it excludes `src/client` — so the
  // JSX transform is spelled out here for the panel tests.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  plugins: [dropMissingSourcemap],
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // The primitives ship CSS modules; left external, Node would try to `import`
    // them as JavaScript. Routing the package through Vite resolves them.
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 75,
      },
    },
  },
})
