import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagementApiError, type ManagementClient } from '../src/client/core/api.ts'
import { INITIAL_STATE, ManagementStore } from '../src/client/core/store.ts'

/**
 * Minimal `EventSource` double.
 *
 * The store only needs open/error/named-event delivery and `close()`, so the
 * test drives those directly rather than pulling in a DOM environment.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  static failConstruction = false

  onopen: (() => void) | undefined
  onerror: (() => void) | undefined
  closed = false
  private readonly handlers = new Map<string, Array<() => void>>()

  constructor(readonly url: string) {
    if (FakeEventSource.failConstruction) throw new Error('blocked')
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: () => void): void {
    const existing = this.handlers.get(type) ?? []
    existing.push(handler)
    this.handlers.set(type, existing)
  }

  emit(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler()
  }

  close(): void {
    this.closed = true
  }
}

function stubClient(overrides: Partial<Record<keyof ManagementClient, unknown>> = {}): ManagementClient {
  return {
    baseUrl: 'http://gateway.test/api',
    token: undefined,
    status: vi.fn().mockResolvedValue({ node_id: 'worker' }),
    config: vi.fn().mockResolvedValue({ namespace: 'ns' }),
    controllers: vi.fn().mockResolvedValue([{ id: 'c1' }]),
    requests: vi.fn().mockResolvedValue([{ id: 'r1' }]),
    ...overrides,
  } as unknown as ManagementClient
}

const stores: ManagementStore[] = []

function createStore(client: ManagementClient): ManagementStore {
  const store = new ManagementStore(client)
  stores.push(store)
  return store
}

/** Let the `Promise.allSettled` in `refresh()` and its `patch` land. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  FakeEventSource.instances = []
  FakeEventSource.failConstruction = false
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  for (const store of stores.splice(0)) store.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ManagementStore', () => {
  it('starts empty and loading', () => {
    expect(createStore(stubClient()).getState()).toEqual(INITIAL_STATE)
  })

  it('loads every endpoint and notifies subscribers', async () => {
    const store = createStore(stubClient())
    const listener = vi.fn()
    store.subscribe(listener)

    await store.refresh()

    expect(store.getState()).toMatchObject({
      status: { node_id: 'worker' },
      config: { namespace: 'ns' },
      controllers: [{ id: 'c1' }],
      requests: [{ id: 'r1' }],
      loading: false,
      error: undefined,
      authRequired: false,
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps the endpoints that succeeded when one fails', async () => {
    const store = createStore(stubClient({
      controllers: vi.fn().mockRejectedValue(new ManagementApiError('gateway is busy', 503)),
    }))

    await store.refresh()

    expect(store.getState()).toMatchObject({
      status: { node_id: 'worker' },
      controllers: [],
      error: 'gateway is busy',
      loading: false,
    })
  })

  it('stringifies a non-Error rejection', async () => {
    const store = createStore(stubClient({ status: vi.fn().mockRejectedValue('offline') }))

    await store.refresh()

    expect(store.getState().error).toBe('offline')
  })

  it('asks for a token on 401 and stops the stream instead of reporting an error', async () => {
    const store = createStore(stubClient({
      status: vi.fn().mockRejectedValue(new ManagementApiError('unauthorized', 401)),
    }))
    store.start()
    await settle()

    expect(store.getState()).toMatchObject({ authRequired: true, error: undefined, live: false })
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })

  it('drops subscribers on unsubscribe', async () => {
    const store = createStore(stubClient())
    const listener = vi.fn()
    store.subscribe(listener)()

    await store.refresh()

    expect(listener).not.toHaveBeenCalled()
  })

  it('polls on an interval after start', async () => {
    vi.useFakeTimers()
    const client = stubClient()
    const store = createStore(client)

    store.start()
    store.start() // idempotent
    await vi.advanceTimersByTimeAsync(30_000)

    expect(client.status).toHaveBeenCalledTimes(3)
  })

  it('opens the stream and refreshes on every notice kind', async () => {
    vi.useFakeTimers()
    const client = stubClient()
    const store = createStore(client)
    store.start()
    await settle()

    const source = FakeEventSource.instances[0]
    expect(source?.url).toBe('http://gateway.test/api/stream')

    source?.onopen?.()
    expect(store.getState().live).toBe(true)

    source?.emit('status')
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(client.status).toHaveBeenCalledTimes(2)

    source?.emit('result')
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(client.status).toHaveBeenCalledTimes(3)

    source?.emit('event')
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(client.status).toHaveBeenCalledTimes(4)
  })

  it('collapses a burst of notices into one reload', async () => {
    vi.useFakeTimers()
    const client = stubClient()
    const store = createStore(client)
    store.start()
    await settle()
    const source = FakeEventSource.instances[0]

    // A running turn emits one event per output chunk; four requests each
    // would be a self-inflicted flood.
    for (let index = 0; index < 50; index += 1) source?.emit('event')
    await settle()
    expect(client.status).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(client.status).toHaveBeenCalledTimes(2)
  })

  it('drops a pending coalesced reload on stop', async () => {
    vi.useFakeTimers()
    const client = stubClient()
    const store = createStore(client)
    store.start()
    await settle()

    FakeEventSource.instances[0]?.emit('event')
    store.stop()
    await vi.advanceTimersByTimeAsync(500)
    await settle()

    expect(client.status).toHaveBeenCalledTimes(1)
  })

  it('falls back to polling when the stream errors', async () => {
    const store = createStore(stubClient())
    store.start()
    await settle()

    FakeEventSource.instances[0]?.onopen?.()
    FakeEventSource.instances[0]?.onerror?.()

    expect(store.getState().live).toBe(false)
  })

  it('stays on polling when a token is configured, because EventSource cannot send headers', async () => {
    const store = createStore(stubClient({ token: 'secret' }))
    store.start()
    await settle()

    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('survives an EventSource constructor that throws', async () => {
    FakeEventSource.failConstruction = true
    const store = createStore(stubClient())

    store.start()
    await settle()

    expect(store.getState().live).toBe(false)
  })

  it('skips the stream entirely where EventSource is unavailable', async () => {
    vi.stubGlobal('EventSource', undefined)
    const store = createStore(stubClient())

    store.start()
    await settle()

    expect(store.getState().status).toEqual({ node_id: 'worker' })
  })

  it('clears the token prompt and reopens the stream on retry', async () => {
    const status = vi.fn().mockRejectedValueOnce(new ManagementApiError('unauthorized', 401))
      .mockResolvedValue({ node_id: 'worker' })
    const store = createStore(stubClient({ status }))
    store.start()
    await settle()
    expect(store.getState().authRequired).toBe(true)

    store.retry()
    await settle()

    expect(store.getState()).toMatchObject({ authRequired: false, status: { node_id: 'worker' } })
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('ignores work after stop', async () => {
    vi.useFakeTimers()
    const client = stubClient()
    const store = createStore(client)
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    const callsAtStop = (client.status as ReturnType<typeof vi.fn>).mock.calls.length

    store.stop()
    store.retry()
    await store.refresh()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(client.status).toHaveBeenCalledTimes(callsAtStop)
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
    expect(store.getState().loading).toBe(false)
  })

  it('does not restart after stop', async () => {
    const client = stubClient()
    const store = createStore(client)
    store.stop()

    store.start()
    await settle()

    expect(client.status).not.toHaveBeenCalled()
  })

  it('drops a late response that arrives after stop', async () => {
    let release = (): void => {}
    const client = stubClient({
      status: vi.fn(async () => {
        await new Promise<void>(resolve => { release = resolve })
        return { node_id: 'worker' }
      }),
    })
    const store = createStore(client)
    const pending = store.refresh()

    store.stop()
    release()
    await pending

    expect(store.getState().status).toBeUndefined()
  })
})
