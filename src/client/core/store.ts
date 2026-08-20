/**
 * Management state with live updates.
 *
 * Subscribes to the gateway's SSE stream and falls back to polling when the
 * stream cannot be held open. Each endpoint is loaded independently so one
 * failure does not blank the whole panel, and a 401 stops the loop instead of
 * retrying against a gateway that will keep rejecting us.
 */

import {
  ManagementApiError,
  type Controller,
  type ManagementClient,
  type NodeConfig,
  type NodeStatus,
  type RequestRecord,
} from './api.ts'

export interface ManagementState {
  status: NodeStatus | undefined
  config: NodeConfig | undefined
  controllers: Controller[]
  requests: RequestRecord[]
  /** Set when the gateway demands a bearer token we do not have. */
  authRequired: boolean
  /** Last transport or server error, cleared on the next success. */
  error: string | undefined
  loading: boolean
  /** True while updates arrive over SSE rather than polling. */
  live: boolean
}

export const INITIAL_STATE: ManagementState = {
  status: undefined,
  config: undefined,
  controllers: [],
  requests: [],
  authRequired: false,
  error: undefined,
  loading: true,
  live: false,
}

const POLL_INTERVAL_MS = 15_000
/**
 * Shortest gap between stream-driven reloads.
 *
 * A running turn emits an event per output chunk, and each reload costs four
 * requests, so notices are coalesced. Short enough to still read as live.
 */
const COALESCE_MS = 400

export type StateListener = (state: ManagementState) => void

export class ManagementStore {
  private state: ManagementState = INITIAL_STATE
  private readonly listeners = new Set<StateListener>()
  private source: EventSource | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private disposed = false

  constructor(private readonly client: ManagementClient) {}

  getState(): ManagementState {
    return this.state
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private patch(partial: Partial<ManagementState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener(this.state)
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    void this.refresh()
    this.openStream()
    this.timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS)
  }

  stop(): void {
    this.started = false
    this.disposed = true
    this.closeStream()
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (this.coalesceTimer !== undefined) clearTimeout(this.coalesceTimer)
    this.coalesceTimer = undefined
    this.listeners.clear()
  }

  /** Retry after the user supplies a token or asks to reconnect. */
  retry(): void {
    if (this.disposed) return
    this.patch({ authRequired: false, error: undefined })
    void this.refresh()
    if (this.source === undefined) this.openStream()
  }

  /**
   * Reload every endpoint, tolerating partial failure.
   *
   * A 401 anywhere means the gateway wants a token: stop the stream and the
   * poll rather than hammering it, and surface the prompt instead of an error.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const [status, config, controllers, requests] = await Promise.allSettled([
      this.client.status(),
      this.client.config(),
      this.client.controllers(),
      this.client.requests(),
    ])
    if (this.disposed) return

    const failures = [status, config, controllers, requests]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown)

    if (failures.some(error => error instanceof ManagementApiError && error.status === 401)) {
      this.closeStream()
      this.patch({ authRequired: true, loading: false, live: false, error: undefined })
      return
    }

    const firstFailure = failures[0]
    this.patch({
      ...status.status === 'fulfilled' ? { status: status.value } : {},
      ...config.status === 'fulfilled' ? { config: config.value } : {},
      ...controllers.status === 'fulfilled' ? { controllers: controllers.value } : {},
      ...requests.status === 'fulfilled' ? { requests: requests.value } : {},
      authRequired: false,
      loading: false,
      error: firstFailure === undefined
        ? undefined
        : firstFailure instanceof Error ? firstFailure.message : String(firstFailure),
    })
  }

  private openStream(): void {
    if (this.source !== undefined || typeof EventSource === 'undefined') return
    const token = this.client.token
    // EventSource cannot set headers; a token-protected gateway stays on polling.
    if (token !== undefined) return
    let source: EventSource
    try {
      source = new EventSource(`${this.client.baseUrl}/stream`)
    } catch {
      return
    }
    this.source = source
    source.onopen = () => this.patch({ live: true })
    // Any notice means gateway state moved; re-read rather than mirror the diff.
    const onNotice = (): void => this.scheduleRefresh()
    source.addEventListener('status', onNotice)
    source.addEventListener('result', onNotice)
    source.addEventListener('event', onNotice)
    source.onerror = () => {
      // The browser reconnects on its own; polling covers the gap meanwhile.
      this.patch({ live: false })
    }
  }

  /** Collapse a burst of notices into one reload. */
  private scheduleRefresh(): void {
    if (this.disposed || this.coalesceTimer !== undefined) return
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined
      void this.refresh()
    }, COALESCE_MS)
  }

  private closeStream(): void {
    this.source?.close()
    this.source = undefined
  }
}
