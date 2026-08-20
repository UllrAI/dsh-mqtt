import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from './config.ts'
import type { MqttAgentGateway } from './gateway.ts'
import type { Logger } from './transport.ts'

interface ManagementServerOptions {
  gateway: MqttAgentGateway
  config: ResolvedConfig
  logger: Logger
}

/**
 * Standalone page assets.
 *
 * Resolved through the package root rather than relative to this module, so the
 * path holds both when running from `src/` and from the bundled `lib/`.
 */
const STATIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/standalone')
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

class ManagementHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > 64 * 1024) throw new ManagementHttpError(413, 'request body exceeds 64 KiB')
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new ManagementHttpError(400, 'request body must be valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ManagementHttpError(400, 'request body must be a JSON object')
  return value as Record<string, unknown>
}

function requestPath(request: IncomingMessage): URL {
  // Only the path and query are used; the origin is a parsing placeholder.
  return new URL(request.url ?? '/', 'http://localhost')
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ManagementHttpError(400, 'invalid path segment')
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown, origin: string | undefined): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  if (origin !== undefined) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
    response.setHeader('access-control-allow-headers', 'content-type,authorization')
    response.setHeader('vary', 'origin')
  }
  response.end(json(value))
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Resolve the CORS origin to echo for one request.
 *
 * An explicit `managementCorsOrigin` always wins. Otherwise loopback callers are
 * reflected, so the DSH settings panel — served from the local web shell on its
 * own port — reaches this API without hand-configured CORS. Bearer-token auth is
 * unaffected either way.
 */
function allowedOrigin(request: IncomingMessage, config: ResolvedConfig): string | undefined {
  if (config.managementCorsOrigin !== undefined) return config.managementCorsOrigin
  const origin = request.headers.origin
  return origin !== undefined && isLoopbackOrigin(origin) ? origin : undefined
}

function authAllowed(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true
  const value = request.headers.authorization
  return value === `Bearer ${token}`
}

const SSE_HEARTBEAT_MS = 25_000

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${json(data)}\n\n`
}

export class ManagementServer {
  private server: Server | undefined
  private readonly streams = new Set<() => void>()

  constructor(private readonly options: ManagementServerOptions) {}

  async start(): Promise<void> {
    if (this.options.config.managementPort === 0) return
    if (this.server !== undefined) throw new Error('dsh-mqtt management server is already started')
    const { config, logger } = this.options
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        const status = error instanceof ManagementHttpError ? error.status : 500
        writeJson(response, status, { error: error instanceof Error ? error.message : String(error) }, allowedOrigin(request, config))
      })
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.managementPort, config.managementHost, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      this.server = undefined
      throw error
    }
    const address = server.address()
    logger.info(`dsh-mqtt management UI API listening at ${typeof address === 'object' && address !== null ? `http://${config.managementHost}:${address.port}` : 'configured endpoint'}`)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    // Close live SSE streams first; `server.close()` waits for open connections.
    // Deleting the current entry mid-iteration is well-defined for a Set.
    for (const close of this.streams) close()
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { config, gateway } = this.options
    const origin = allowedOrigin(request, config)
    const url = requestPath(request)
    if (!url.pathname.startsWith('/api/')) {
      await this.serveUi(url.pathname, response, origin)
      return
    }
    if (request.method === 'OPTIONS') {
      writeJson(response, 204, {}, origin)
      return
    }
    if (!authAllowed(request, config.managementToken)) {
      writeJson(response, 401, { error: 'management authorization required' }, origin)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      this.streamNotices(response, origin)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      writeJson(response, 200, await gateway.getStatus(), origin)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      writeJson(response, 200, {
        url: config.url,
        namespace: config.namespace,
        node_id: config.nodeId,
        display_name: config.displayName,
        default_workspace: config.defaultWorkspace ?? null,
        workspaces: Object.keys(config.workspaces),
        capabilities: config.capabilities,
        controller_auth_required: config.requireControllerAuth,
      }, origin)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/controllers') {
      writeJson(response, 200, { controllers: await gateway.listControllers() }, origin)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/requests') {
      const limit = Number(url.searchParams.get('limit') ?? '100')
      writeJson(response, 200, { requests: await gateway.listRequests(Number.isFinite(limit) ? limit : 100) }, origin)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/controllers/invites') {
      const body = await readJson(request)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length === 0 || name.length > 128) throw new ManagementHttpError(400, 'name must contain 1 to 128 characters')
      if (body.scopes !== undefined && (!Array.isArray(body.scopes) || !body.scopes.every(scope => typeof scope === 'string'))) {
        throw new ManagementHttpError(400, 'scopes must be an array of strings')
      }
      const scopes = body.scopes === undefined ? ['submit', 'control'] : body.scopes as string[]
      const ttlSeconds = typeof body.ttl_seconds === 'number' && Number.isFinite(body.ttl_seconds)
        ? Math.max(60, Math.min(86_400, Math.floor(body.ttl_seconds)))
        : 600
      const invite = await gateway.createControllerInvite(name, scopes, ttlSeconds * 1_000)
      writeJson(response, 201, { invite }, origin)
      return
    }
    const authorizeMatch = /^\/api\/controllers\/([^/]+)\/authorize$/.exec(url.pathname)
    if (authorizeMatch !== null && request.method === 'POST') {
      writeJson(response, 200, { controller: await gateway.authorizeController(decodeSegment(authorizeMatch[1] as string)) }, origin)
      return
    }
    const controllerMatch = /^\/api\/controllers\/([^/]+)$/.exec(url.pathname)
    if (controllerMatch !== null && request.method === 'DELETE') {
      writeJson(response, 200, { controller: await gateway.revokeController(decodeSegment(controllerMatch[1] as string)) }, origin)
      return
    }
    writeJson(response, 404, { error: 'not found' }, origin)
  }

  /**
   * Push gateway changes over Server-Sent Events.
   *
   * Clients that cannot hold the stream open fall back to the polling endpoints,
   * which stay available unchanged.
   */
  private streamNotices(response: ServerResponse, origin: string | undefined): void {
    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('connection', 'keep-alive')
    // Defeat proxy response buffering, which would otherwise defer every frame.
    response.setHeader('x-accel-buffering', 'no')
    if (origin !== undefined) response.setHeader('access-control-allow-origin', origin)
    response.write(': connected\n\n')

    const unsubscribe = this.options.gateway.subscribe(notice => {
      response.write(sseFrame(notice.kind, notice))
    })
    // Comment frames keep intermediaries from reaping an idle connection.
    const heartbeat = setInterval(() => response.write(': ping\n\n'), SSE_HEARTBEAT_MS)
    heartbeat.unref?.()

    const close = (): void => {
      if (!this.streams.delete(close)) return
      clearInterval(heartbeat)
      unsubscribe()
      response.end()
    }
    this.streams.add(close)
    response.on('close', close)
  }

  private async serveUi(pathname: string, response: ServerResponse, origin: string | undefined): Promise<void> {
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
    const file = resolve(STATIC_ROOT, requested)
    if (!file.startsWith(`${STATIC_ROOT}/`) && file !== STATIC_ROOT) {
      writeJson(response, 400, { error: 'invalid path' }, origin)
      return
    }
    try {
      const bytes = await readFile(file)
      response.statusCode = 200
      response.setHeader('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
      response.setHeader('cache-control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable')
      response.setHeader('x-content-type-options', 'nosniff')
      response.end(bytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (extname(requested) !== '') {
        writeJson(response, 404, { error: 'not found' }, origin)
        return
      }
      const bytes = await readFile(resolve(STATIC_ROOT, 'index.html'))
      response.statusCode = 200
      response.setHeader('content-type', CONTENT_TYPES['.html'] as string)
      response.setHeader('cache-control', 'no-cache')
      response.end(bytes)
    }
  }
}
