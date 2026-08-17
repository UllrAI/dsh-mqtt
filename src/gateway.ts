import type { AgentErrorEvent, AgentStatusEvent, GatewayAgentHost } from './agent-host.ts'
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
  type GatewayResult,
  type SubmitRequest,
} from './protocol.ts'
import { RequestStore } from './state-store.ts'
import { TopicLayout } from './topics.ts'
import type { GatewayTransport, IncomingMessage, Logger } from './transport.ts'

const GATEWAY_VERSION = '0.1.0'
const SUMMARY_LIMIT = 8_000

interface ActiveRequest {
  id: string
  sessionId: string
  summary?: string
  turnEndReason?: unknown
  lastError?: string
  cancelRequested: boolean
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function reasonKind(reason: unknown): string | undefined {
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) return undefined
  const kind = (reason as Record<string, unknown>).kind
  return typeof kind === 'string' ? kind : undefined
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
  private operationQueue: Promise<void> = Promise.resolve()
  private stopping = false

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
      onEvent: event => { void this.enqueue(() => this.handleAgentEvent(event.sessionId, event.event)) },
      onStatus: event => { void this.enqueue(() => this.handleAgentStatus(event)) },
      onError: event => { void this.enqueue(() => this.handleAgentError(event)) },
    })

    try {
      await this.transport.start({
        onMessage: message => this.enqueue(() => this.handleMessage(message)),
        onConnect: async () => {
          if (this.stopping) return
          await this.publishOnlineStatus()
          for (const record of recovered) {
            if (record.result !== undefined) await this.publishResult(record.result)
          }
          recovered.length = 0
        },
      })
    } catch (error) {
      await Promise.allSettled([this.host.dispose(), this.store.close()])
      throw error
    }
    this.logger.info(`dsh-mqtt: gateway online at ${this.topics.base}`)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
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

  async whenIdle(): Promise<void> {
    await this.operationQueue
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const task = this.operationQueue.then(operation)
    this.operationQueue = task.catch(error => {
      this.logger.error('dsh-mqtt: asynchronous gateway operation failed', error)
    })
    return this.operationQueue
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

    const reservation = await this.store.reserve(request.id, fingerprint(request))
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
      }
      this.active.set(request.id, active)
      this.requestBySession.set(lease.sessionId, request.id)
      await this.store.activate(request.id, lease.sessionId)
      await this.publishEvent(request.id, 'request.session', { session_id: lease.sessionId })
      this.host.send(lease.sessionId, 'followup', request.input)
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
      await this.publishEvent(requestId, 'request.control.rejected', {
        command_id: control.command_id,
        error: gatewayError('REQUEST_NOT_ACTIVE', 'request is not active', true),
      })
      return
    }
    try {
      if (control.type === 'request.cancel') {
        active.cancelRequested = true
        this.host.cancel(active.sessionId)
      } else {
        this.host.send(active.sessionId, control.type === 'request.steer' ? 'steer' : 'inject', control.input as string)
      }
      await this.publishEvent(requestId, 'request.control.accepted', {
        command_id: control.command_id,
        action: control.type,
      })
    } catch (error) {
      await this.publishEvent(requestId, 'request.control.failed', {
        command_id: control.command_id,
        error: gatewayError('CONTROL_FAILED', errorMessage(error), true),
      })
    }
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
    if (event.status !== 'idle') return

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
          active.lastError === undefined ? `TURN_${kind?.toUpperCase().replaceAll('-', '_') ?? 'FAILED'}` : 'AGENT_ERROR',
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

  private activeForSession(sessionId: string): ActiveRequest | undefined {
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
    await this.transport.publish(this.topics.events(id), json(protocolEvent(id, type, data, sequence)), { qos: 1 })
  }

  private async publishResult(result: GatewayResult): Promise<void> {
    await this.transport.publish(this.topics.result(result.id), json(result), { qos: 1 })
  }

  private async publishOnlineStatus(): Promise<void> {
    await this.transport.publish(this.topics.status, json({
      version: 1,
      type: 'node.status',
      timestamp: new Date().toISOString(),
      node_id: this.config.nodeId,
      online: true,
      gateway_version: GATEWAY_VERSION,
      capabilities: this.config.capabilities,
    }), { qos: 1, retain: true })
  }

  private async publishOfflineStatus(): Promise<void> {
    await this.transport.publish(this.topics.status, json({
      version: 1,
      type: 'node.status',
      timestamp: new Date().toISOString(),
      node_id: this.config.nodeId,
      online: false,
      gateway_version: GATEWAY_VERSION,
    }), { qos: 1, retain: true })
  }
}

export function offlineStatus(config: ResolvedConfig): string {
  return json({
    version: 1,
    type: 'node.status',
    timestamp: new Date().toISOString(),
    node_id: config.nodeId,
    online: false,
    gateway_version: GATEWAY_VERSION,
  })
}
