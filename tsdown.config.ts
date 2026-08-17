import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/protocol.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'mqtt'],
  },
})
