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
  /** Set when the token we do have was refused, rather than never supplied. */
  tokenRejected: boolean
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
  tokenRejected: false,
  error: undefined,
  loading: true,
  live: false,
}

const POLL_INTERVAL_MS = 15_000
/**
 * Gap before a spent-ticket stream is dialled again.
 *
 * Long enough that a gateway which keeps refusing is not hammered, short enough
 * that a restart is picked up before the operator reaches for Refresh. Polling
 * covers the gap either way.
 */
const STREAM_RETRY_MS = 3_000
/**
 * Shortest gap between stream-driven reloads.
 *
 * Most notices apply in place; this covers the ones that need a reload, where a
 * burst would otherwise cost four requests each. Short enough to read as live.
 */
const COALESCE_MS = 400

export type StateListener = (state: ManagementState) => void

interface Notice {
  status?: NodeStatus
  result?: unknown
  event?: unknown
}

/** A notice we cannot read is not a notice we can trust; the caller reloads. */
function parseNotice(data: unknown): Notice | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const value = JSON.parse(data) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Notice : undefined
  } catch {
    return undefined
  }
}

function noticeId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const id = (payload as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : undefined
}

const TERMINAL_STATUSES: ReadonlySet<RequestRecord['status']> = new Set(['completed', 'failed', 'cancelled'])

function terminalStatus(value: unknown): RequestRecord['status'] | undefined {
  return TERMINAL_STATUSES.has(value as RequestRecord['status']) ? value as RequestRecord['status'] : undefined
}

function resultError(value: unknown): { code: string; message: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { code, message } = value as { code?: unknown; message?: unknown }
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : undefined
}

/** Fold a `request.result` notice into its row, mirroring the history projection. */
function mergeResult(record: RequestRecord, payload: unknown): RequestRecord | undefined {
  const result = payload as { status?: unknown; timestamp?: unknown; session_id?: unknown; summary?: unknown; error?: unknown }
  const status = terminalStatus(result.status)
  if (status === undefined) return undefined
  const updatedAt = typeof result.timestamp === 'string' ? Date.parse(result.timestamp) : Number.NaN
  const error = resultError(result.error)
  return {
    ...record,
    status,
    updatedAt: Number.isNaN(updatedAt) ? record.updatedAt : updatedAt,
    ...typeof result.session_id === 'string' ? { sessionId: result.session_id } : {},
    result: {
      status,
      ...typeof result.summary === 'string' ? { summary: result.summary } : {},
      ...error === undefined ? {} : { error },
    },
  }
}

export class ManagementStore {
  private state: ManagementState = INITIAL_STATE
  private readonly listeners = new Set<StateListener>()
  private source: EventSource | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined
  private streamTimer: ReturnType<typeof setTimeout> | undefined
  private opening = false
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
    void this.openStream()
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
    if (this.streamTimer !== undefined) clearTimeout(this.streamTimer)
    this.streamTimer = undefined
    this.listeners.clear()
  }

  /** Retry after the user supplies a token or asks to reconnect. */
  retry(): void {
    if (this.disposed) return
    this.patch({ authRequired: false, tokenRejected: false, error: undefined })
    void this.refresh()
    if (this.source === undefined) void this.openStream()
  }

  /**
   * Reload every endpoint, tolerating partial failure.
   *
   * A 401 anywhere means the gateway wants a token: stop the stream and the
   * poll rather than hammering it, and surface the prompt instead of an error.
   * Whether we had sent one decides what the prompt says — "supply a token" and
   * "that token is wrong" are different instructions to the operator.
   */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const sentToken = this.client.token !== undefined
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
      this.patch({ authRequired: true, tokenRejected: sentToken, loading: false, live: false, error: undefined })
      return
    }

    const firstFailure = failures[0]
    this.patch({
      ...status.status === 'fulfilled' ? { status: status.value } : {},
      ...config.status === 'fulfilled' ? { config: config.value } : {},
      ...controllers.status === 'fulfilled' ? { controllers: controllers.value } : {},
      ...requests.status === 'fulfilled' ? { requests: requests.value } : {},
      authRequired: false,
      tokenRejected: false,
      loading: false,
      error: firstFailure === undefined
        ? undefined
        : firstFailure instanceof Error ? firstFailure.message : String(firstFailure),
    })
  }

  /**
   * Open the live stream, buying a ticket first when a token is in play.
   *
   * `EventSource` cannot carry an Authorization header, so a token-protected
   * gateway would be stuck on polling. A single-use ticket in the query string
   * closes that gap without putting the token itself in a URL. If the ticket
   * cannot be had — an old gateway, a refused token — polling stays in charge.
   */
  private async openStream(): Promise<void> {
    if (this.source !== undefined || this.opening || typeof EventSource === 'undefined') return
    this.opening = true
    try {
      let url = `${this.client.baseUrl}/stream`
      if (this.client.token !== undefined) {
        const ticket = await this.client.streamTicket().catch(() => undefined)
        if (ticket === undefined || this.disposed || this.source !== undefined) return
        url += `?ticket=${encodeURIComponent(ticket)}`
      }
      let source: EventSource
      try {
        source = new EventSource(url)
      } catch {
        return
      }
      this.source = source
      source.onopen = () => this.patch({ live: true })
      source.addEventListener('status', message => this.consume('status', message))
      source.addEventListener('result', message => this.consume('result', message))
      source.addEventListener('event', message => this.consume('event', message))
      source.onerror = () => {
        this.patch({ live: false })
        // A ticket is spent on connect, so the browser's own reconnect would
        // replay a dead query string forever. Redial with a fresh one instead;
        // an unticketed stream is left to the browser as before.
        if (this.client.token !== undefined) this.reopenStream()
      }
    } finally {
      this.opening = false
    }
  }

  private reopenStream(): void {
    if (this.disposed || this.streamTimer !== undefined) return
    this.closeStream()
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined
      void this.openStream()
    }, STREAM_RETRY_MS)
  }

  /**
   * Apply a pushed notice, reloading only when it cannot stand on its own.
   *
   * Notices carry the payloads the endpoints would return, so a status applies
   * verbatim and a result folds into the row it belongs to. Reloading is for
   * what a notice cannot tell us: a request we have never seen, or one still
   * shown as `accepted` whose events say it has started. Without that split, a
   * single running turn spends four requests per output chunk.
   */
  private consume(kind: 'status' | 'result' | 'event', message: MessageEvent): void {
    if (this.disposed) return
    const notice = parseNotice(message.data)
    if (notice === undefined) return this.scheduleRefresh()
    if (kind === 'status' && typeof notice.status?.node_id === 'string') {
      this.patch({ status: notice.status, error: undefined })
      return
    }
    const id = kind === 'status' ? undefined : noticeId(kind === 'result' ? notice.result : notice.event)
    const known = this.state.requests.find(record => record.id === id)
    if (id === undefined || known === undefined) return this.scheduleRefresh()
    if (kind === 'event') {
      // Deltas are not rendered; only the accepted -> active flip is visible.
      if (known.status === 'accepted') this.scheduleRefresh()
      return
    }
    const merged = mergeResult(known, notice.result)
    if (merged === undefined) return this.scheduleRefresh()
    this.patch({
      requests: this.state.requests.map(record => record.id === id ? merged : record),
      error: undefined,
    })
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
