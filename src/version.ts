import { createRequire } from 'node:module'

/**
 * Gateway version advertised in `node.status` payloads.
 *
 * Read from the published manifest so a release bump cannot drift from the
 * version controllers see on the wire. Both `src/` and the bundled `lib/` sit
 * one directory below the package root, so the same specifier resolves in
 * tests and in the shipped build.
 */
export const GATEWAY_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version
