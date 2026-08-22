import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from './config.ts'
import type { MqttAgentGateway } from './gateway.ts'
import { NotFoundError } from './state-store.ts'
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

/**
 * Client errors declare their own status; everything else is ours to own.
 *
 * An explicit pair rather than a `status` duck-type, so only errors written to
 * be read by a client can carry their message out of `handle`.
 */
function httpStatus(error: unknown): number {
  if (error instanceof ManagementHttpError) return error.status
  return error instanceof NotFoundError ? error.status : 500
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

function hostname(value: string): string | undefined {
  try {
    // The scheme is a parsing placeholder; `Host` carries authority only.
    return new URL(`http://${value}`).hostname
  } catch {
    return undefined
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Refuse a request that reached us under someone else's hostname.
 *
 * Without a token this API trusts the loopback interface, and a browser can be
 * pointed at it by resolving an attacker-controlled name to 127.0.0.1. After
 * that rebinding the attacker's page is same-origin with us, so it sends no
 * `Origin` and reads every response. The `Host` header still names where the
 * browser thinks it is going, and it is the only part of that setup the attacker
 * cannot forge — so a non-loopback `Host` is refused.
 *
 * Only unauthenticated deployments need this: a token the attacker does not have
 * already stops them, and requiring one is exactly how a non-loopback bind is
 * configured (see `resolveConfig`).
 */
function hostDenied(request: IncomingMessage, config: ResolvedConfig): boolean {
  if (config.managementToken !== undefined) return false
  const host = request.headers.host
  // Absent only on HTTP/1.0 clients, which are never the browser this guards.
  if (host === undefined) return false
  const name = hostname(host)
  return name === undefined || !LOOPBACK_HOSTS.has(name)
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

/** Length-independent comparison, so a wrong token leaks no timing signal. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

function authAllowed(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true
  const value = request.headers.authorization
  return value !== undefined && secretsMatch(value, `Bearer ${token}`)
}

/**
 * Reject cross-site callers whose origin we do not vouch for.
 *
 * CORS stops a foreign page from *reading* our responses, but a form-style POST
 * still executes server-side. So an `Origin` we did not allow is refused before
 * it reaches a handler; requests without one (curl, the controller CLI) are
 * unaffected, and same-origin browsers send an allowed origin.
 *
 * The opaque `null` origin is refused too: every legitimate browser caller here
 * is served over HTTP by this same server and sends a real origin, so `null`
 * only ever arrives from a sandboxed frame trying its luck.
 */
function crossSiteDenied(request: IncomingMessage, origin: string | undefined): boolean {
  const sent = request.headers.origin
  if (sent === undefined) return false
  return sent !== origin
}

/**
 * Require a JSON content type on mutating requests.
 *
 * `text/plain` and the form types are CORS-safelisted: a browser sends them
 * without a preflight, which is exactly the shape a CSRF attempt takes. Demanding
 * `application/json` puts every mutation behind a preflight we control.
 */
function assertJsonBody(request: IncomingMessage): void {
  const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') throw new ManagementHttpError(415, 'content-type must be application/json')
}

const SSE_HEARTBEAT_MS = 25_000
const TICKET_TTL_MS = 15_000
/** History page size. Mirrors `REQUEST_PAGE_SIZE` in the client, and caps `?limit`. */
const REQUEST_PAGE_SIZE = 50

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${json(data)}\n\n`
}

export class ManagementServer {
  private server: Server | undefined
  private readonly streams = new Set<() => void>()
  /** Single-use SSE tickets, keyed by value; see `ManagementClient.streamTicket`. */
  private readonly tickets = new Map<string, number>()

  constructor(private readonly options: ManagementServerOptions) {}

  private issueTicket(): string {
    const now = Date.now()
    for (const [value, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(value)
    }
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, now + TICKET_TTL_MS)
    return ticket
  }

  /** Consumes the ticket: a replayed query string buys nothing. */
  private redeemTicket(ticket: string | null): boolean {
    if (ticket === null) return false
    const expiresAt = this.tickets.get(ticket)
    this.tickets.delete(ticket)
    return expiresAt !== undefined && expiresAt > Date.now()
  }

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
        const status = httpStatus(error)
        // Only deliberate client errors carry their message out; anything else
        // could describe the filesystem or the broker.
        if (status >= 500) logger.error('dsh-mqtt: management request failed', error)
        const message = status >= 500 ? 'internal error' : error instanceof Error ? error.message : String(error)
        writeJson(response, status, { error: message }, allowedOrigin(request, config))
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
    if (hostDenied(request, config)) {
      writeJson(response, 421, { error: 'host not allowed' }, undefined)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      await this.serveUi(url.pathname, response, origin)
      return
    }
    if (request.method === 'OPTIONS') {
      writeJson(response, 204, {}, origin)
      return
    }
    if (crossSiteDenied(request, origin)) {
      writeJson(response, 403, { error: 'origin not allowed' }, origin)
      return
    }
    // The stream accepts a ticket because EventSource cannot send headers. A
    // client that *can* send one still authenticates the ordinary way.
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      if (!authAllowed(request, config.managementToken) && !this.redeemTicket(url.searchParams.get('ticket'))) {
        writeJson(response, 401, { error: 'management authorization required' }, origin)
        return
      }
      this.streamNotices(response, origin)
      return
    }
    if (!authAllowed(request, config.managementToken)) {
      writeJson(response, 401, { error: 'management authorization required' }, origin)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/stream/tickets') {
      assertJsonBody(request)
      writeJson(response, 201, { ticket: this.issueTicket() }, origin)
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
      const requested = Number(url.searchParams.get('limit') ?? REQUEST_PAGE_SIZE)
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(REQUEST_PAGE_SIZE, Math.floor(requested))) : REQUEST_PAGE_SIZE
      writeJson(response, 200, { requests: await gateway.listRequests(limit) }, origin)
      return
    }
    const cancelMatch = /^\/api\/requests\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancelMatch !== null && request.method === 'POST') {
      assertJsonBody(request)
      const outcome = await gateway.cancelRequest(decodeSegment(cancelMatch[1] as string))
      if (outcome.reason === 'not-found') throw new ManagementHttpError(404, 'request does not exist')
      // Already finished, or finishing: the operator's intent is satisfied either way.
      if (outcome.reason === 'not-active') throw new ManagementHttpError(409, 'request is no longer running')
      writeJson(response, 202, { ok: true }, origin)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/controllers/invites') {
      assertJsonBody(request)
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
      assertJsonBody(request)
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

    // A reader that stops draining must not become unbounded memory here. Notices
    // are refresh hints, so dropping frames while backed up costs the client one
    // coalesced refetch, not correctness.
    let backedUp = false
    const push = (frame: string): void => {
      if (backedUp) return
      backedUp = !response.write(frame)
      if (backedUp) response.once('drain', () => { backedUp = false })
    }

    const unsubscribe = this.options.gateway.subscribe(notice => push(sseFrame(notice.kind, notice)))
    // Comment frames keep intermediaries from reaping an idle connection.
    const heartbeat = setInterval(() => push(': ping\n\n'), SSE_HEARTBEAT_MS)
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
    // `relative()` handles the platform separator; a leading `..` or an absolute
    // result means the join escaped the asset root.
    const inside = relative(STATIC_ROOT, file)
    if (inside.startsWith('..') || isAbsolute(inside)) {
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
