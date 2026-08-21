import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { MqttAgentGateway } from '../src/gateway.ts'
import { ManagementServer } from '../src/management-server.ts'
import type { Logger } from '../src/transport.ts'

const servers: ManagementServer[] = []

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
})

describe('ManagementServer', () => {
  it('serves real status, safe config, controller, and request operations', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://broker.test:1883',
      namespace: 'test',
      nodeId: 'worker',
      displayName: 'Build worker',
      workspaces: { app: '/workspace/app' },
      managementPort: port,
    })
    const invite = { id: 'controller-1', name: 'MacBook', scopes: ['submit'], token: 'secret', createdAt: 1, expiresAt: 2 }
    const gateway = {
      getStatus: vi.fn().mockResolvedValue({ type: 'node.status', state: 'ready' }),
      listControllers: vi.fn().mockResolvedValue([]),
      listRequests: vi.fn().mockResolvedValue([]),
      createControllerInvite: vi.fn().mockResolvedValue(invite),
      authorizeController: vi.fn().mockResolvedValue({ id: invite.id, status: 'authorized' }),
      revokeController: vi.fn().mockResolvedValue({ id: invite.id, status: 'revoked' }),
    } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()
    await expect(server.start()).rejects.toThrow(/already started/)
    const base = `http://127.0.0.1:${port}/api`

    const html = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text())
    expect(html).toContain('<div id="root"></div>')
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1]
    expect(asset).toBeDefined()
    expect((await fetch(`http://127.0.0.1:${port}${asset}`).then(response => response.headers.get('content-type')))).toContain('javascript')
    expect(await fetch(`http://127.0.0.1:${port}/settings/worker`).then(response => response.text())).toContain('<div id="root"></div>')
    expect((await fetch(`http://127.0.0.1:${port}/missing.js`)).status).toBe(404)
    expect(await fetch(`${base}/status`).then(response => response.json())).toMatchObject({ state: 'ready' })
    expect(await fetch(`${base}/config`).then(response => response.json())).toEqual(expect.objectContaining({
      display_name: 'Build worker',
      workspaces: ['app'],
    }))
    const created = await fetch(`${base}/controllers/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'MacBook', scopes: ['submit'] }),
    }).then(response => response.json())
    expect(created).toEqual({ invite })
    expect(gateway.createControllerInvite).toHaveBeenCalledWith('MacBook', ['submit'], 600_000)
    expect(await fetch(`${base}/controllers`).then(response => response.json())).toEqual({ controllers: [] })
    expect(await fetch(`${base}/requests?limit=5`).then(response => response.json())).toEqual({ requests: [] })
    expect(gateway.listRequests).toHaveBeenCalledWith(5)

    await fetch(`${base}/controllers/${invite.id}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(gateway.authorizeController).toHaveBeenCalledWith(invite.id)
    // A CORS-safelisted content type would let a foreign form POST here without
    // a preflight, so mutations demand JSON.
    expect((await fetch(`${base}/controllers/${invite.id}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    })).status).toBe(415)
    await fetch(`${base}/controllers/${invite.id}`, { method: 'DELETE' })
    expect(gateway.revokeController).toHaveBeenCalledWith(invite.id)
    expect((await fetch(`${base}/missing`)).status).toBe(404)
    expect((await fetch(`${base}/status`, { method: 'OPTIONS' })).status).toBe(204)
    expect((await fetch(`${base}/status`)).headers.get('access-control-allow-origin')).toBeNull()
    expect((await fetch(`${base}/controllers/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })).status).toBe(400)
    expect((await fetch(`${base}/controllers/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })).status).toBe(400)
    expect((await fetch(`${base}/controllers/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })).status).toBe(400)
    expect((await fetch(`${base}/controllers/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'MacBook', scopes: 'submit' }),
    })).status).toBe(400)
  })

  it('translates a cancel outcome into the status the operator deserves', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://broker.test:1883',
      namespace: 'test',
      nodeId: 'worker',
      managementPort: port,
    })
    const cancelRequest = vi.fn()
      .mockResolvedValueOnce({ reason: 'requested' })
      .mockResolvedValueOnce({ reason: 'not-found' })
      .mockResolvedValueOnce({ reason: 'not-active' })
    const gateway = { cancelRequest } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()
    const cancel = (id: string): Promise<Response> => fetch(
      `http://127.0.0.1:${port}/api/requests/${id}/cancel`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    )

    // Accepted, not completed: the agent may still be finishing.
    expect((await cancel('req%2F1')).status).toBe(202)
    expect(cancelRequest).toHaveBeenCalledWith('req/1')
    expect((await cancel('gone')).status).toBe(404)
    expect((await cancel('done')).status).toBe(409)
    expect((await fetch(`http://127.0.0.1:${port}/api/requests/req-1/cancel`, { method: 'POST' })).status).toBe(415)
  })

  it('issues a single-use stream ticket that EventSource can spend once', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://broker.test:1883',
      namespace: 'test',
      nodeId: 'worker',
      managementPort: port,
      managementToken: 'management-secret',
    })
    const gateway = { subscribe: vi.fn(() => () => undefined) } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()
    const base = `http://127.0.0.1:${port}/api`
    const auth = { 'content-type': 'application/json', authorization: 'Bearer management-secret' }

    // The ticket itself is behind the bearer token; only the stream may use one.
    expect((await fetch(`${base}/stream/tickets`, { method: 'POST' })).status).toBe(401)
    const issued = await fetch(`${base}/stream/tickets`, { method: 'POST', headers: auth })
    expect(issued.status).toBe(201)
    const { ticket } = await issued.json() as { ticket: string }
    expect(ticket).toMatch(/^[\w-]{20,}$/)

    const stream = await fetch(`${base}/stream?ticket=${ticket}`)
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    await stream.body?.cancel()

    // Spent: a replayed query string buys nothing.
    expect((await fetch(`${base}/stream?ticket=${ticket}`)).status).toBe(401)
    expect((await fetch(`${base}/stream?ticket=forged`)).status).toBe(401)
  })

  it('requires a bearer token when management authentication is configured', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://127.0.0.1:1883',
      namespace: 'test',
      nodeId: 'worker',
      managementPort: port,
      managementToken: 'management-secret',
      managementCorsOrigin: 'https://control.example.com',
    })
    const gateway = { getStatus: vi.fn() } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()
    const url = `http://127.0.0.1:${port}/api/status`
    expect(await fetch(`http://127.0.0.1:${port}/`).then(response => response.text())).toContain('<div id="root"></div>')
    expect((await fetch(url)).status).toBe(401)
    const response = await fetch(url, { headers: { authorization: 'Bearer management-secret' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://control.example.com')
  })

  it('reflects loopback origins so the DSH settings panel reaches the API unconfigured', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://127.0.0.1:1883',
      namespace: 'test',
      nodeId: 'worker',
      managementPort: port,
    })
    const gateway = { getStatus: vi.fn().mockResolvedValue({ state: 'ready' }) } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()
    const url = `http://127.0.0.1:${port}/api/status`

    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080']) {
      const response = await fetch(url, { headers: { origin } })
      expect(response.headers.get('access-control-allow-origin')).toBe(origin)
      // Caches must not serve one origin's response to another.
      expect(response.headers.get('vary')).toBe('origin')
    }

    // A cross-site caller is refused server-side, not merely denied the response:
    // CORS alone would still let the handler run.
    for (const origin of ['https://evil.example.com', 'null']) {
      const response = await fetch(url, { headers: { origin } })
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }

    const preflight = await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('pushes gateway notices over SSE and stops cleanly with the stream still open', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://127.0.0.1:1883',
      namespace: 'test',
      nodeId: 'worker',
      managementPort: port,
    })
    let publish: ((notice: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    const gateway = {
      subscribe: vi.fn((listener: (notice: unknown) => void) => {
        publish = listener
        return unsubscribe
      }),
    } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()

    const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
      headers: { origin: 'http://localhost:5173' },
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    // Proxy buffering would defer every frame until the stream closed.
    expect(response.headers.get('x-accel-buffering')).toBe('no')

    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n')

    publish?.({ kind: 'status', status: { state: 'ready' } })
    expect(decoder.decode((await reader.read()).value))
      .toBe('event: status\ndata: {"kind":"status","status":{"state":"ready"}}\n\n')

    // `server.close()` waits on open connections, so `stop()` must end this one.
    await server.stop()
    servers.length = 0
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect((await reader.read()).done).toBe(true)
  })

  it('rejects an unauthenticated stream request', async () => {
    const port = await freePort()
    const config = resolveConfig({
      url: 'mqtt://127.0.0.1:1883',
      namespace: 'test',
      nodeId: 'worker',
      managementPort: port,
      managementToken: 'management-secret',
    })
    const gateway = { subscribe: vi.fn() } as unknown as MqttAgentGateway
    const server = new ManagementServer({ gateway, config, logger: logger() })
    servers.push(server)
    await server.start()

    expect((await fetch(`http://127.0.0.1:${port}/api/stream`)).status).toBe(401)
    expect(gateway.subscribe).not.toHaveBeenCalled()
  })
})
