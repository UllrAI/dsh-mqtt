import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementApiError, ManagementClient } from '../src/client/core/api.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** Stub `fetch` and record what the client sent. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string | URL, init: RequestInit = {}) => handler(String(url), init))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(token?: () => string | undefined): ManagementClient {
  return new ManagementClient({ baseUrl: 'http://gateway.test/api', token })
}

describe('ManagementClient', () => {
  it('sends JSON requests without an authorization header when no token is configured', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({ node_id: 'worker' }))
    const status = await client().status()

    expect(status).toEqual({ node_id: 'worker' })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://gateway.test/api/status')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('reads the token on every request so a mid-session token takes effect', async () => {
    let token: string | undefined
    const fetchSpy = stubFetch(() => jsonResponse({}))
    const api = client(() => token)

    await api.config()
    token = 'later'
    await api.config()

    const headers = fetchSpy.mock.calls.map(call => (call[1] as RequestInit).headers)
    expect(headers[0]).not.toHaveProperty('authorization')
    expect(headers[1]).toMatchObject({ authorization: 'Bearer later' })
    expect(api.baseUrl).toBe('http://gateway.test/api')
    expect(api.token).toBe('later')
  })

  it('surfaces the server error message and status', async () => {
    stubFetch(() => jsonResponse({ error: 'controller not found' }, 404))

    const error = await client().status().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ManagementApiError)
    expect(error).toMatchObject({ message: 'controller not found', status: 404 })
  })

  it('falls back to the status code when the error body carries no message', async () => {
    stubFetch(() => new Response('nope', { status: 503 }))

    await expect(client().status()).rejects.toMatchObject({ message: 'HTTP 503', status: 503 })
  })

  it('reports a transport failure as status 0', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })

    await expect(client().status()).rejects.toMatchObject({ message: 'Failed to fetch', status: 0 })
  })

  it('reports a non-Error transport rejection too', async () => {
    globalThis.fetch = (() => Promise.reject('boom')) as unknown as typeof fetch

    await expect(client().status()).rejects.toMatchObject({ message: 'boom', status: 0 })
  })

  it('defaults list endpoints to an empty array when the field is absent', async () => {
    stubFetch(() => jsonResponse({}))
    const api = client()

    await expect(api.controllers()).resolves.toEqual([])
    await expect(api.requests()).resolves.toEqual([])
  })

  it('returns list payloads when present', async () => {
    stubFetch(url => jsonResponse(
      url.includes('/controllers') ? { controllers: [{ id: 'a' }] } : { requests: [{ id: 'r' }] },
    ))
    const api = client()

    await expect(api.controllers()).resolves.toEqual([{ id: 'a' }])
    await expect(api.requests(5)).resolves.toEqual([{ id: 'r' }])
  })

  it('passes the history limit through', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({ requests: [] }))

    await client().requests()
    await client().requests(200)

    expect(fetchSpy.mock.calls.map(call => call[0])).toEqual([
      'http://gateway.test/api/requests?limit=50',
      'http://gateway.test/api/requests?limit=200',
    ])
  })

  it('creates an invite with the submit and control scopes', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({ invite: { id: 'c1', token: 'secret' } }))

    await expect(client().createInvite('Laptop')).resolves.toEqual({ id: 'c1', token: 'secret' })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://gateway.test/api/controllers/invites')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Laptop',
      scopes: ['submit', 'control'],
      ttl_seconds: 600,
    })
  })

  it('escapes controller ids in authorize and revoke paths', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({}))
    const api = client()

    await api.authorizeController('a/b')
    await api.revokeController('a/b')

    expect(fetchSpy.mock.calls.map(call => [call[0], (call[1] as RequestInit).method])).toEqual([
      ['http://gateway.test/api/controllers/a%2Fb/authorize', 'POST'],
      ['http://gateway.test/api/controllers/a%2Fb', 'DELETE'],
    ])
  })
})
