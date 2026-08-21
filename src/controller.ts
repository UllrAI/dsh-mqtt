import { randomUUID } from 'node:crypto'
import { connect, type IClientOptions, type MqttClient } from 'mqtt'
import type { NodeStatus } from './gateway.ts'
import type { GatewayEvent, GatewayResult } from './protocol.ts'
import { TopicLayout } from './topics.ts'

export interface ControllerInviteConfig {
  url: string
  namespace: string
  nodeId: string
  controllerId: string
  token: string
  username?: string
  password?: string
  protocolVersion?: 4 | 5
  clean?: boolean
  keepaliveSeconds?: number
  connectTimeoutMs?: number
  ca?: Buffer
  cert?: Buffer
  key?: Buffer
  rejectUnauthorized?: boolean
}

export interface SubmitOptions {
  id?: string
  input: string
  workspace?: string
  sessionId?: string
  metadata?: Record<string, unknown>
}

/**
 * Results that arrive before anyone waits for them are kept so a caller can
 * still claim them, but only this many: an unbounded map would grow for the
 * lifetime of a long-lived controller that never calls `waitForResult`.
 */
const MAX_UNCLAIMED_RESULTS = 128

export class MqttControllerClient {
  readonly topics: TopicLayout
  private client: MqttClient | undefined
  private readonly resultWaiters = new Map<string, Array<(result: GatewayResult) => void>>()
  private readonly results = new Map<string, GatewayResult>()
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>()
  private readonly statusListeners = new Set<(status: NodeStatus) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()

  constructor(private readonly config: ControllerInviteConfig) {
    this.topics = new TopicLayout(config.namespace, config.nodeId)
  }

  async connect(): Promise<void> {
    if (this.client !== undefined) throw new Error('dsh-mqtt controller is already connected')
    const options: IClientOptions = {
      clientId: `dsh-mqtt-controller-${randomUUID()}`,
      protocolVersion: this.config.protocolVersion ?? 5,
      clean: this.config.clean ?? true,
      keepalive: this.config.keepaliveSeconds ?? 30,
      connectTimeout: this.config.connectTimeoutMs ?? 10_000,
      reconnectPeriod: 1_000,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      ...this.config.username === undefined ? {} : { username: this.config.username },
      ...this.config.password === undefined ? {} : { password: this.config.password },
      ...this.config.ca === undefined ? {} : { ca: this.config.ca },
      ...this.config.cert === undefined ? {} : { cert: this.config.cert },
      ...this.config.key === undefined ? {} : { key: this.config.key },
    }
    const client = connect(this.config.url, options)
    this.client = client
    client.on('message', (topic, payload) => this.handleMessage(topic, payload))
    // mqtt.js reconnects on its own, but an unhandled 'error' event throws. This
    // listener is permanent so a broker hiccup after connect cannot kill the host.
    client.on('error', error => {
      for (const listener of this.errorListeners) listener(error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          this.errorListeners.delete(onError)
          resolve()
        }
        const onError = (error: Error): void => {
          client.off('connect', onConnect)
          reject(error)
        }
        client.once('connect', onConnect)
        this.errorListeners.add(onError)
      })
      await client.subscribeAsync({
        [this.topics.status]: { qos: 1 },
        [`${this.topics.base}/requests/+/events`]: { qos: 1 },
        [`${this.topics.base}/requests/+/result`]: { qos: 1 },
      })
    } catch (error) {
      this.client = undefined
      this.errorListeners.clear()
      await client.endAsync(true).catch(() => undefined)
      throw error
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    this.client = undefined
    await client.endAsync(true)
  }

  /**
   * Broker errors after a successful connect. Without a subscriber they are
   * swallowed rather than thrown, which is the safe default for an embedded
   * client that reconnects by itself.
   */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onStatus(listener: (status: NodeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async submit(options: SubmitOptions): Promise<string> {
    const id = options.id ?? `request-${randomUUID()}`
    await this.publish(this.topics.requests, {
      version: 1,
      id,
      type: 'request.submit',
      timestamp: new Date().toISOString(),
      input: options.input,
      ...options.workspace === undefined ? {} : { workspace: options.workspace },
      ...options.sessionId === undefined ? {} : { session_id: options.sessionId },
      ...options.metadata === undefined ? {} : { metadata: options.metadata },
      controller_id: this.config.controllerId,
      token: this.config.token,
    })
    return id
  }

  async control(requestId: string, type: 'request.steer' | 'request.inject' | 'request.cancel', input?: string): Promise<string> {
    const commandId = `command-${randomUUID()}`
    await this.publish(this.topics.control(requestId), {
      version: 1,
      id: requestId,
      command_id: commandId,
      type,
      timestamp: new Date().toISOString(),
      ...input === undefined ? {} : { input },
      controller_id: this.config.controllerId,
      token: this.config.token,
    })
    return commandId
  }

  waitForResult(requestId: string, timeoutMs = 300_000): Promise<GatewayResult> {
    return new Promise((resolve, reject) => {
      const cached = this.results.get(requestId)
      if (cached !== undefined) {
        this.results.delete(requestId)
        resolve(cached)
        return
      }
      const timer = setTimeout(() => {
        const remaining = (this.resultWaiters.get(requestId) ?? []).filter(waiter => waiter !== finish)
        if (remaining.length === 0) this.resultWaiters.delete(requestId)
        else this.resultWaiters.set(requestId, remaining)
        reject(new Error(`timed out waiting for request ${requestId}`))
      }, timeoutMs)
      const finish = (result: GatewayResult): void => {
        clearTimeout(timer)
        resolve(result)
      }
      const waiters = this.resultWaiters.get(requestId) ?? []
      waiters.push(finish)
      this.resultWaiters.set(requestId, waiters)
    })
  }

  private async publish(topic: string, value: unknown): Promise<void> {
    const client = this.client
    if (client === undefined) throw new Error('dsh-mqtt controller is not connected')
    await client.publishAsync(topic, JSON.stringify(value), { qos: 1, retain: false })
  }

  private handleMessage(topic: string, payload: Buffer): void {
    let value: unknown
    try {
      value = JSON.parse(payload.toString('utf8')) as unknown
    } catch {
      return
    }
    if (topic === this.topics.status) {
      for (const listener of this.statusListeners) listener(value as NodeStatus)
      return
    }
    if (value === null || typeof value !== 'object') return

    const resultId = this.topics.requestIdFromResult(topic)
    if (resultId !== undefined) {
      const waiters = this.resultWaiters.get(resultId)
      this.resultWaiters.delete(resultId)
      if (waiters === undefined || waiters.length === 0) this.rememberResult(resultId, value as GatewayResult)
      else for (const waiter of waiters) waiter(value as GatewayResult)
      return
    }

    if (this.topics.requestIdFromEvents(topic) !== undefined) {
      for (const listener of this.eventListeners) listener(value as GatewayEvent)
    }
  }

  /** Keep the newest results, evicting in insertion order once the cache is full. */
  private rememberResult(requestId: string, result: GatewayResult): void {
    this.results.delete(requestId)
    this.results.set(requestId, result)
    for (const stale of this.results.keys()) {
      if (this.results.size <= MAX_UNCLAIMED_RESULTS) break
      this.results.delete(stale)
    }
  }
}
