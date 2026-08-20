/**
 * Standalone page build.
 *
 * The fallback UI for deployments without a DSH web shell in front of the
 * operator. Unlike `lib/client.js` this one bundles React and the design
 * tokens, because nothing else on the page provides them. The management
 * server serves the output from `lib/standalone`.
 */

import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('src/client/standalone', import.meta.url))
const outDir = fileURLToPath(new URL('lib/standalone', import.meta.url))

export default defineConfig({
  root,
  // The management server mounts this at its own root.
  base: '/',
  build: {
    outDir,
    emptyOutDir: true,
    // The primitives barrel declares no `sideEffects` and initialises shiki at
    // module scope, so the markdown stack rides along even though this page
    // renders five atoms. The grammars are dynamic imports the page never
    // reaches, so the actual load is the entry chunk; the rest sits unfetched
    // on disk. Not worth stubbing a sibling package's private import graph.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.DSH_MQTT_MANAGEMENT_API ?? 'http://127.0.0.1:3210',
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
})
