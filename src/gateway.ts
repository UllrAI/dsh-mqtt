import type { AgentErrorEvent, AgentHostHealth, AgentStatusEvent, GatewayAgentHost } from './agent-host.ts'
import type { ResolvedConfig } from './config.ts'
import { errorMessage, normalizeSessionEvent } from './event-normalizer.ts'
import {
  fingerprint,
  parseControl,
  parseSubmit,
  protocolErrorResult,
  protocolEvent,
  protocolResult,
  ProtocolError,
  type ControlRequest,
  type GatewayError,
  type GatewayEvent,
  type GatewayResult,
  type SubmitRequest,
} from './protocol.ts'
import { RequestStore, type ControllerInvite, type ControllerSummary, type StoredRequest } from './state-store.ts'
import { TopicLayout } from './topics.ts'
import type { GatewayTransport, IncomingMessage, Logger, TransportState } from './transport.ts'
import { GATEWAY_VERSION } from './version.ts'

const SUMMARY_LIMIT = 8_000
/** Chain key for work that is not tied to one session; see `enqueue`. */
const SHARED_CHAIN = '@shared'

export type NodeState = 'starting' | 'connecting' | 'ready' | 'busy' | 'degraded' | 'offline' | 'stopped'

export interface NodeHealthCheck {
  name: string
  status: 'ready' | 'degraded' | 'offline'
  message?: string
}

export interface NodeStatus {
  version: 1
  type: 'node.status'
  timestamp: string
  heartbeat_at: string
  expires_at: string
  node_id: string
  display_name: string
  state: NodeState
  online: boolean
  gateway_version: string
  protocol_version: 1
  capabilities: readonly string[]
  workspaces: Array<{ alias: string; status: AgentHostHealth['workspaces'][number]['status'] }>
  active_requests: number
  request_capacity: number
  controller_auth_required: boolean
  health: NodeHealthCheck[]
}

/**
 * One history row as the management UI sees it.
 *
 * Deliberately narrower than `StoredRequest`: no fingerprint, no control-dedup
 * table. Mirrors `RequestRecord` in the client.
 */
export interface RequestSummary {
  id: string
  status: StoredRequest['status']
  createdAt: number
  updatedAt: number
  sessionId?: string
  workspace?: string
  controllerId?: string
  cancelRequested?: boolean
  result?: {
    status: string
    summary?: string
    error?: { code: string; message: string }
  }
}

interface ActiveRequest {
  id: string
  sessionId: string
  summary?: string
  turnEndReason?: unknown
  lastError?: string
  cancelRequested: boolean
  /**
   * Whether the agent has reported `running` for this request yet.
   *
   * A session can emit `idle` before it picks up our input — on resume it is
   * idle by definition. Finalizing on that would report a completed request
   * that never ran, so a bare first `idle` is only terminal once we saw
   * `running`; an `idle` carrying an error or a turn-end reason always is.
   */
  started: boolean
}

/**
 * Live gateway change pushed to management UI subscribers.
 *
 * Mirrors what already goes out over MQTT, so the UI observes the same
 * transitions controllers do instead of re-polling for them.
 */
export type GatewayNotice =
  | { kind: 'event'; event: GatewayEvent }
  | { kind: 'result'; result: GatewayResult }
  | { kind: 'status'; status: NodeStatus }

export type GatewayNoticeListener = (notice: GatewayNotice) => void

function json(value: unknown): string {
  return JSON.stringify(value)
}

function reasonKind(reason: unknown): string | undefined {
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) return undefined
  const kind = (reason as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : undefined
}

/**
 * Turn-end kinds the agent reports, mapped to protocol error codes.
 *
 * An explicit table rather than string mutation: the wire codes are part of the
 * protocol, so a new agent-side kind should fall back to `TURN_FAILED` instead
 * of silently inventing a code no controller knows how to handle.
 */
const TURN_END_CODES: Record<string, string> = {
  aborted: 'TURN_ABORTED',
  'max-turns': 'TURN_MAX_TURNS',
  'max-tokens': 'TURN_MAX_TOKENS',
  error: 'TURN_ERROR',
  refusal: 'TURN_REFUSAL',
  blocked: 'TURN_BLOCKED',
}

function turnEndCode(kind: string | undefined): string {
  return (kind === undefined ? undefined : TURN_END_CODES[kind]) ?? 'TURN_FAILED'
}

function trimSummary(value: string): string {
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT - 1)}…`
}

function gatewayError(code: string, message: string, retryable = false): GatewayError {
  return { code, message, retryable }
}

export class MqttAgentGateway {
  readonly topics: TopicLayout
  private readonly active = new Map<string, ActiveRequest>()
  private readonly requestBySession = new Map<string, string>()
  /** Serialization chains, keyed by session; `SHARED_CHAIN` holds the rest. */
  private readonly chains = new Map<string, Promise<void>>()
  private stopping = false
  private connectionState: TransportState = 'offline'
  private nodeState: NodeState = 'starting'
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private readonly noticeListeners = new Set<GatewayNoticeListener>()

  constructor(
    private readonly config: ResolvedConfig,
    private readonly transport: GatewayTransport,
    private readonly host: GatewayAgentHost,
    private readonly store: RequestStore,
    private readonly logger: Logger,
  ) {
    this.topics = new TopicLayout(config.namespace, config.nodeId)
  }

  async start(): Promise<void> {
    await this.store.open()
    const recovered = await this.store.recoverInterrupted(record => protocolResult(record.id, 'failed', {
      ...record.sessionId === undefined ? {} : { sessionId: record.sessionId },
      error: gatewayError('GATEWAY_RESTARTED', 'the gateway restarted before this request completed', true),
    }))

    this.host.start({
      onEvent: event => { void this.enqueue(() => this.handleAgentEvent(event.sessionId, event.event), event.sessionId) },
      onStatus: event => { void this.enqueue(() => this.handleAgentStatus(event), event.sessionId) },
      onError: event => { void this.enqueue(() => this.handleAgentError(event), event.sessionId) },
    })

    try {
      await this.transport.start({
        onMessage: message => this.enqueue(() => this.handleMessage(message)),
        onConnect: async () => {
          if (this.stopping) return
          this.connectionState = 'connected'
          await this.publishOnlineStatus()
          for (const record of recovered) {
            if (record.result !== undefined) await this.publishResult(record.result)
          }
          recovered.length = 0
        },
        onState: state => this.enqueue(async () => {
          if (this.stopping) return
          this.connectionState = state
          if (state === 'connecting') this.nodeState = 'connecting'
          if (state === 'degraded') this.nodeState = 'degraded'
          if (state === 'offline') this.nodeState = 'offline'
          if (state === 'offline') await this.publishOfflineStatus()
          else if (state === 'degraded') await this.publishOnlineStatus()
        }),
      })
    } catch (error) {
      await Promise.allSettled([this.host.dispose(), this.store.close()])
      throw error
    }
    this.heartbeatTimer = setInterval(() => {
      void this.enqueue(() => this.publishOnlineStatus())
    }, this.config.heartbeatSeconds * 1_000)
    this.logger.info(`dsh-mqtt: gateway started at ${this.topics.base}`)
    // Broker credentials alone decide who may drive an agent that reads files and
    // runs commands. That is a fine default for a private broker and a bad one
    // everywhere else, so it should never be a silent default.
    if (!this.config.requireControllerAuth) {
      this.logger.warn(
        'dsh-mqtt: controller approval is off, so anyone who can publish to this broker can run agent work here.'
        + ' Set requireControllerAuth: true unless the broker is fully trusted.',
      )
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    await this.enqueue(async () => {
      for (const request of this.active.values()) {
        try {
          this.host.cancel(request.sessionId)
        } catch {
          // The agent may already be disposing; the terminal result remains authoritative.
        }
        await this.finalize(request, protocolResult(request.id, 'failed', {
          sessionId: request.sessionId,
          ...request.summary === undefined ? {} : { summary: request.summary },
          error: gatewayError('GATEWAY_STOPPED', 'the gateway stopped before this request completed', true),
        }))
      }
    })
    await this.publishOfflineStatus().catch(error => this.logger.warn('dsh-mqtt: failed to publish offline status', error))
    const results = await Promise.allSettled([this.host.dispose(), this.transport.stop(), this.store.close()])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh-mqtt gateway shutdown failed')
  }

  /**
   * Settle every chain.
   *
   * A draining chain can enqueue more work, so this loops until no chain is
   * left rather than awaiting one snapshot.
   */
  async whenIdle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all(this.chains.values())
  }

  /**
   * Observe gateway changes as they happen. Returns an unsubscribe function.
   *
   * A listener that throws is dropped rather than allowed to break the publish
   * path: management UI delivery must never take the gateway down.
   */
  subscribe(listener: GatewayNoticeListener): () => void {
    this.noticeListeners.add(listener)
    return () => this.noticeListeners.delete(listener)
  }

  private notify(notice: GatewayNotice): void {
    for (const listener of this.noticeListeners) {
      try {
        listener(notice)
      } catch (error) {
        this.noticeListeners.delete(listener)
        this.logger.warn('dsh-mqtt: dropped a management subscriber that threw', error)
      }
    }
  }

  async getStatus(): Promise<NodeStatus> {
    return this.buildStatus()
  }

  /**
   * History for the management UI.
   *
   * Projected rather than returned raw: the stored record also holds the request
   * fingerprint and the control-dedup table, neither of which the UI needs and
   * both of which describe payloads we should not hand back out.
   */
  async listRequests(limit = 100): Promise<RequestSummary[]> {
    const records = await this.store.list({ limit })
    return records.map(record => ({
      id: record.id,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...record.sessionId === undefined ? {} : { sessionId: record.sessionId },
      ...record.workspace === undefined ? {} : { workspace: record.workspace },
      ...record.controllerId === undefined ? {} : { controllerId: record.controllerId },
      ...this.active.get(record.id)?.cancelRequested === true ? { cancelRequested: true } : {},
      ...record.result === undefined ? {} : {
        result: {
          status: record.result.status,
          ...record.result.summary === undefined ? {} : { summary: record.result.summary },
          ...record.result.error === null ? {} : {
            error: { code: record.result.error.code, message: record.result.error.message },
          },
        },
      },
    }))
  }

  async listControllers(): Promise<ControllerSummary[]> {
    return this.store.listControllers()
  }

  async createControllerInvite(name: string, scopes: string[], ttlMs: number): Promise<ControllerInvite> {
    return this.store.createController(name, scopes, ttlMs)
  }

  async authorizeController(id: string): Promise<ControllerSummary> {
    return this.store.authorizeController(id)
  }

  async revokeController(id: string): Promise<ControllerSummary> {
    return this.store.revokeController(id)
  }

  /**
   * Cancel a running request from the management UI.
   *
   * Goes through the same queue as an MQTT `request.cancel` so the operator and
   * a controller cannot race, and emits the same events — a controller watching
   * the request sees an operator cancel exactly as it would see its own.
   */
  async cancelRequest(id: string): Promise<{ ok: boolean; reason?: 'not-found' | 'not-active' }> {
    let outcome: { ok: boolean; reason?: 'not-found' | 'not-active' } = { ok: true }
    let failure: unknown
    await this.enqueue(async () => {
      try {
        const active = this.active.get(id)
        if (active === undefined) {
          outcome = { ok: false, reason: await this.store.get(id) === undefined ? 'not-found' : 'not-active' }
          return
        }
        if (active.cancelRequested) return
        this.applyControl(active, { type: 'request.cancel' })
        await this.publishEvent(id, 'request.control.accepted', { action: 'request.cancel', source: 'management' })
        await this.publishOnlineStatus()
      } catch (error) {
        failure = error
      }
    })
    if (failure !== undefined) throw failure
    return outcome
  }

  /**
   * Serialize gateway work, per chain.
   *
   * Broker publishes are QoS 1 awaits, so one shared chain lets a slow ack for
   * one session stall every other session's events. Work for a session goes on
   * its own chain — ordering within a session still holds, which is what
   * consumers rely on — while unkeyed work (submits, control, status) stays on
   * the shared chain, where mutual exclusion over `active` is load-bearing.
   */
  private enqueue(operation: () => void | Promise<void>, key = SHARED_CHAIN): Promise<void> {
    const chain = (this.chains.get(key) ?? Promise.resolve()).then(operation).catch(error => {
      this.logger.error('dsh-mqtt: asynchronous gateway operation failed', error)
    })
    this.chains.set(key, chain)
    // Drop a drained chain, so long-lived gateways do not accumulate one settled
    // promise per session ever seen, and `whenIdle` has an empty map to observe.
    void chain.then(() => {
      if (this.chains.get(key) === chain) this.chains.delete(key)
    })
    return chain
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (this.stopping) return
    if (message.topic === this.topics.requests) {
      await this.handleSubmitMessage(message)
      return
    }
    const requestId = this.topics.requestIdFromControl(message.topic)
    if (requestId !== undefined) await this.handleControlMessage(message, requestId)
  }

  private async handleSubmitMessage(message: IncomingMessage): Promise<void> {
    let request: SubmitRequest
    try {
      request = parseSubmit(message.payload, this.config.limits)
    } catch (error) {
      await this.handleProtocolError(error)
      return
    }
    if (message.retain) {
      await this.publishResult(protocolResult(request.id, 'failed', {
        error: gatewayError('RETAINED_COMMAND', 'retained request messages are never executed'),
      }))
      return
    }

    const authorization = await this.authorize(request.controller_id, request.token, 'submit')
    if (!authorization.ok) {
      await this.failUnauthenticated(request.id, authorization.reason)
      return
    }

    const reservation = await this.store.reserve(request.id, fingerprint(request), {
      ...request.workspace === undefined ? {} : { workspace: request.workspace },
      ...request.controller_id === undefined ? {} : { controllerId: request.controller_id },
    })
    if (reservation.kind === 'conflict') {
      await this.publishResult(protocolResult(request.id, 'failed', {
        error: gatewayError('REQUEST_ID_CONFLICT', 'request id was already used with a different payload'),
      }))
      return
    }
    if (reservation.kind === 'duplicate') {
      if (reservation.record.result !== undefined) await this.publishResult(reservation.record.result)
      else await this.publishEvent(request.id, 'request.duplicate', {
        status: reservation.record.status,
        session_id: reservation.record.sessionId,
      })
      return
    }

    if (await this.store.activeCount() > this.config.limits.maxActiveRequests) {
      await this.failReserved(request.id, 'CAPACITY_EXCEEDED', 'gateway has reached its active request limit', true)
      return
    }
    if (request.session_id !== undefined
      && !this.config.allowExternalSessions
      && !(await this.store.hasSession(request.session_id))) {
      await this.failReserved(
        request.id,
        'SESSION_NOT_OWNED',
        'session was not created by this gateway; set allowExternalSessions to opt in',
      )
      return
    }
    if (request.session_id !== undefined && this.requestBySession.has(request.session_id)) {
      await this.failReserved(request.id, 'SESSION_BUSY', 'the requested session already has an active MQTT request', true)
      return
    }

    await this.publishEvent(request.id, 'request.accepted', { metadata: request.metadata })
    try {
      const lease = await this.host.acquire({
        requestId: request.id,
        ...request.session_id === undefined ? {} : { sessionId: request.session_id },
        ...request.workspace === undefined ? {} : { workspace: request.workspace },
      })
      if (this.requestBySession.has(lease.sessionId)) {
        await this.host.release(lease.sessionId)
        await this.failReserved(request.id, 'SESSION_BUSY', 'the resolved session already has an active MQTT request', true)
        return
      }
      const active: ActiveRequest = {
        id: request.id,
        sessionId: lease.sessionId,
        cancelRequested: false,
        started: false,
      }
      this.active.set(request.id, active)
      this.requestBySession.set(lease.sessionId, request.id)
      await this.store.activate(request.id, lease.sessionId)
      await this.publishEvent(request.id, 'request.session', { session_id: lease.sessionId })
      this.host.send(lease.sessionId, 'followup', request.input)
      await this.publishOnlineStatus()
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'AGENT_START_FAILED'
      const retryable = error !== null && typeof error === 'object' && 'retryable' in error && error.retryable === true
      await this.failReserved(request.id, code, errorMessage(error), retryable)
    }
  }

  private async handleControlMessage(message: IncomingMessage, requestId: string): Promise<void> {
    let control: ControlRequest
    try {
      control = parseControl(message.payload, requestId, this.config.limits)
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error
      await this.publishEvent(requestId, 'request.control.rejected', {
        error: gatewayError(error.code, error.message, error.retryable),
      })
      return
    }
    if (message.retain) {
      await this.publishEvent(requestId, 'request.control.rejected', {
        command_id: control.command_id,
        error: gatewayError('RETAINED_COMMAND', 'retained control messages are never executed'),
      })
      return
    }

    const authorization = await this.authorize(control.controller_id, control.token, 'control')
    if (!authorization.ok) {
      await this.publishEvent(requestId, 'request.control.rejected', {
        command_id: control.command_id,
        error: gatewayError('AUTH_REQUIRED', authorization.reason),
      })
      return
    }

    const claim = await this.store.claimControl(requestId, control.command_id, fingerprint(control))
    if (claim.kind === 'not-found') {
      await this.publishEvent(requestId, 'request.control.rejected', {
        command_id: control.command_id,
        error: gatewayError('REQUEST_NOT_FOUND', 'request does not exist'),
      })
      return
    }
    if (claim.kind === 'terminal') {
      if (claim.record.result !== undefined) await this.publishResult(claim.record.result)
      return
    }
    if (claim.kind === 'conflict') {
      await this.publishEvent(requestId, 'request.control.rejected', {
        command_id: control.command_id,
        error: gatewayError('COMMAND_ID_CONFLICT', 'command id was already used with a different payload'),
      })
      return
    }
    if (claim.kind === 'duplicate') {
      await this.publishEvent(requestId, 'request.control.duplicate', { command_id: control.command_id })
      return
    }

    const active = this.active.get(requestId)
    if (active === undefined) {
      // Retryable, so the command id must not stay consumed by the dedup table.
      await this.store.releaseControl(requestId, control.command_id)
      await this.publishEvent(requestId, 'request.control.rejected', {
        command_id: control.command_id,
        error: gatewayError('REQUEST_NOT_ACTIVE', 'request is not active', true),
      })
      return
    }
    try {
      this.applyControl(active, control)
      await this.publishEvent(requestId, 'request.control.accepted', {
        command_id: control.command_id,
        action: control.type,
      })
      await this.publishOnlineStatus()
    } catch (error) {
      await this.store.releaseControl(requestId, control.command_id)
      await this.publishEvent(requestId, 'request.control.failed', {
        command_id: control.command_id,
        error: gatewayError('CONTROL_FAILED', errorMessage(error), true),
      })
    }
  }

  private applyControl(active: ActiveRequest, control: Pick<ControlRequest, 'type' | 'input'>): void {
    if (control.type === 'request.cancel') {
      active.cancelRequested = true
      this.host.cancel(active.sessionId)
      return
    }
    this.host.send(active.sessionId, control.type === 'request.steer' ? 'steer' : 'inject', control.input as string)
  }

  private async handleAgentEvent(sessionId: string, event: unknown): Promise<void> {
    const active = this.activeForSession(sessionId)
    if (active === undefined) return
    const normalized = normalizeSessionEvent(event, this.config.eventExposure)
    if (normalized === undefined) return
    if (normalized.summaryText !== undefined) active.summary = trimSummary(normalized.summaryText)
    if (normalized.turnEndReason !== undefined) active.turnEndReason = normalized.turnEndReason
    await this.publishEvent(active.id, normalized.type, normalized.data, normalized.sequence)
  }

  private async handleAgentStatus(event: AgentStatusEvent): Promise<void> {
    const active = this.activeForSession(event.sessionId)
    if (active === undefined) return
    await this.publishEvent(active.id, 'agent.status', { status: event.status })
    if (event.status === 'running') {
      active.started = true
      return
    }
    // A resume-idle is the one status with nothing behind it: no run, no error,
    // no turn-end reason. Anything else is a turn we owe a result for, and
    // dropping it would strand the request in `active` for the node's lifetime.
    if (!active.started && active.lastError === undefined && active.turnEndReason === undefined) return

    const kind = reasonKind(active.turnEndReason)
    let result: GatewayResult
    if (kind === 'aborted' && active.cancelRequested) {
      result = protocolResult(active.id, 'cancelled', {
        sessionId: active.sessionId,
        ...active.summary === undefined ? {} : { summary: active.summary },
      })
    } else if (active.lastError !== undefined || (kind !== undefined && kind !== 'completed')) {
      result = protocolResult(active.id, 'failed', {
        sessionId: active.sessionId,
        ...active.summary === undefined ? {} : { summary: active.summary },
        error: gatewayError(
          active.lastError === undefined ? turnEndCode(kind) : 'AGENT_ERROR',
          active.lastError ?? `agent turn ended with ${kind}`,
        ),
      })
    } else {
      result = protocolResult(active.id, 'completed', {
        sessionId: active.sessionId,
        ...active.summary === undefined ? {} : { summary: active.summary },
      })
    }
    await this.finalize(active, result)
  }

  private async handleAgentError(event: AgentErrorEvent): Promise<void> {
    const active = this.activeForSession(event.sessionId)
    if (active === undefined) return
    active.lastError = errorMessage(event.error)
    await this.publishEvent(active.id, 'agent.error', {
      turn: event.turn,
      step: event.step,
      message: active.lastError,
    })
  }

  /**
   * The request an agent session belongs to, or `undefined` once stopping.
   *
   * Session work runs on its own chain, so without the stopping guard a late
   * agent event could publish after `stop()` has already written the terminal
   * result for that request.
   */
  private activeForSession(sessionId: string): ActiveRequest | undefined {
    if (this.stopping) return undefined
    const requestId = this.requestBySession.get(sessionId)
    return requestId === undefined ? undefined : this.active.get(requestId)
  }

  private async finalize(active: ActiveRequest, result: GatewayResult): Promise<void> {
    this.active.delete(active.id)
    this.requestBySession.delete(active.sessionId)
    await this.host.release(active.sessionId).catch(error => {
      this.logger.warn(`dsh-mqtt: failed to release session ${active.sessionId}`, error)
    })
    await this.store.finish(active.id, result)
    await this.publishResult(result)
    await this.publishOnlineStatus()
  }

  private async failReserved(id: string, code: string, message: string, retryable = false): Promise<void> {
    const active = this.active.get(id)
    const sessionId = active?.sessionId
    if (active !== undefined) {
      this.active.delete(id)
      this.requestBySession.delete(active.sessionId)
      await this.host.release(active.sessionId).catch(() => undefined)
    }
    const result = protocolResult(id, 'failed', {
      ...sessionId === undefined ? {} : { sessionId },
      error: gatewayError(code, message, retryable),
    })
    await this.store.finish(id, result)
    await this.publishResult(result)
    await this.publishOnlineStatus()
  }

  private async failUnauthenticated(id: string, reason: string): Promise<void> {
    await this.publishResult(protocolResult(id, 'failed', {
      error: gatewayError('AUTH_REQUIRED', reason),
    }))
  }

  private async authorize(controllerId: string | undefined, token: string | undefined, scope: string): Promise<
    { ok: true } | { ok: false; reason: string }
  > {
    if (!this.config.requireControllerAuth) return { ok: true }
    if (controllerId === undefined || token === undefined) {
      return { ok: false, reason: 'a controller id and token are required' }
    }
    const result = await this.store.authenticateController(controllerId, token, scope)
    if (result.ok) return { ok: true }
    const messages: Record<typeof result.reason, string> = {
      'not-found': 'controller is not authorized',
      pending: 'controller approval is still pending',
      revoked: 'controller has been revoked',
      expired: 'controller authorization has expired',
      'invalid-token': 'controller token is invalid',
      'scope-denied': `controller is not allowed to ${scope}`,
    }
    return { ok: false, reason: messages[result.reason] }
  }

  private async handleProtocolError(error: unknown): Promise<void> {
    if (!(error instanceof ProtocolError)) throw error
    const id = error.requestId
    if (id === undefined) {
      this.logger.warn(`dsh-mqtt: rejected uncorrelated message: ${error.code}: ${error.message}`)
      return
    }
    await this.publishResult(protocolErrorResult(error, id))
  }

  private async publishEvent(id: string, type: string, data?: unknown, sequence?: number): Promise<void> {
    const event = protocolEvent(id, type, data, sequence)
    this.notify({ kind: 'event', event })
    await this.transport.publish(this.topics.events(id), json(event), { qos: 1 })
  }

  private async publishResult(result: GatewayResult): Promise<void> {
    this.notify({ kind: 'result', result })
    await this.transport.publish(this.topics.result(result.id), json(result), { qos: 1 })
  }

  private async publishOnlineStatus(): Promise<void> {
    if (this.connectionState !== 'connected' && this.connectionState !== 'degraded') return
    const status = await this.buildStatus()
    this.notify({ kind: 'status', status })
    await this.transport.publish(this.topics.status, json(status), { qos: 1, retain: true })
  }

  private async publishOfflineStatus(): Promise<void> {
    this.nodeState = 'offline'
    if (this.connectionState !== 'connected' && !this.stopping) return
    const status = await this.buildStatus()
    this.notify({ kind: 'status', status })
    await this.transport.publish(this.topics.status, json(status), { qos: 1, retain: true })
  }

  private async buildStatus(): Promise<NodeStatus> {
    const now = new Date()
    const health: NodeHealthCheck[] = [{
      name: 'broker',
      status: this.connectionState === 'connected' ? 'ready' : this.connectionState === 'offline' ? 'offline' : 'degraded',
    }]
    let hostHealth: AgentHostHealth
    try {
      hostHealth = await this.host.health()
      health.push({
        name: 'agent',
        status: hostHealth.agent === 'ready' ? 'ready' : 'degraded',
        ...hostHealth.error === undefined ? {} : { message: hostHealth.error },
      })
      health.push({ name: 'model', status: hostHealth.model === 'ready' ? 'ready' : 'degraded' })
      for (const workspace of hostHealth.workspaces) {
        health.push({
          name: `workspace:${workspace.alias}`,
          status: workspace.status === 'ready' ? 'ready' : 'degraded',
          ...workspace.status === 'ready' ? {} : { message: workspace.status },
        })
      }
    } catch (error) {
      hostHealth = { agent: 'degraded', model: 'unavailable', workspaces: [], error: errorMessage(error) }
      health.push({ name: 'agent', status: 'degraded', ...hostHealth.error === undefined ? {} : { message: hostHealth.error } })
    }
    const activeRequests = this.active.size
    const allReady = this.connectionState === 'connected' && health.every(item => item.status === 'ready')
    this.nodeState = this.stopping
      ? 'stopped'
      : this.connectionState !== 'connected'
        ? this.connectionState === 'offline' ? 'offline' : this.connectionState === 'connecting' ? 'connecting' : 'degraded'
        : !allReady ? 'degraded' : activeRequests > 0 ? 'busy' : 'ready'
    const heartbeatAt = now.toISOString()
    return {
      version: 1,
      type: 'node.status',
      timestamp: heartbeatAt,
      heartbeat_at: heartbeatAt,
      expires_at: new Date(now.getTime() + this.config.heartbeatSeconds * 2_000).toISOString(),
      node_id: this.config.nodeId,
      display_name: this.config.displayName,
      state: this.nodeState,
      online: this.nodeState === 'ready' || this.nodeState === 'busy' || this.nodeState === 'degraded',
      gateway_version: GATEWAY_VERSION,
      protocol_version: 1,
      capabilities: this.config.capabilities,
      workspaces: hostHealth.workspaces.map(workspace => ({ alias: workspace.alias, status: workspace.status })),
      active_requests: activeRequests,
      request_capacity: this.config.limits.maxActiveRequests,
      controller_auth_required: this.config.requireControllerAuth,
      health,
    }
  }
}

/**
 * The Last Will payload, published by the broker if this node drops.
 *
 * MQTT fixes the will at CONNECT, so every value here is frozen at session
 * setup: `timestamp` and `heartbeat_at` mark when the will was armed, not when
 * the node died, and `expires_at` is already in the past by the time a broker
 * delivers this. Treat the message as "the session is gone" rather than as a
 * timeline. Same field set as a live status so a controller can decode both
 * with one parser; the counters read zero because a dead node is running
 * nothing, and `workspaces` is empty because a dead node cannot vouch for what
 * is still readable on disk.
 */
export function offlineStatus(config: ResolvedConfig): string {
  const armedAt = new Date().toISOString()
  return json({
    version: 1,
    type: 'node.status',
    timestamp: armedAt,
    heartbeat_at: armedAt,
    expires_at: armedAt,
    node_id: config.nodeId,
    display_name: config.displayName,
    state: 'offline',
    online: false,
    gateway_version: GATEWAY_VERSION,
    protocol_version: 1,
    capabilities: config.capabilities,
    workspaces: [],
    active_requests: 0,
    request_capacity: config.limits.maxActiveRequests,
    controller_auth_required: config.requireControllerAuth,
    health: [{ name: 'broker', status: 'offline' }],
  })
}
