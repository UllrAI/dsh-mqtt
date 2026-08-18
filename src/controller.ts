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

export class MqttControllerClient {
  readonly topics: TopicLayout
  private client: MqttClient | undefined
  private readonly resultWaiters = new Map<string, Array<(result: GatewayResult) => void>>()
  private readonly results = new Map<string, GatewayResult>()
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>()
  private readonly statusListeners = new Set<(status: NodeStatus) => void>()

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
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          client.off('error', onError)
          resolve()
        }
        const onError = (error: Error): void => {
          client.off('connect', onConnect)
          reject(error)
        }
        client.once('connect', onConnect)
        client.once('error', onError)
      })
      await client.subscribeAsync({
        [this.topics.status]: { qos: 1 },
        [`${this.topics.base}/requests/+/events`]: { qos: 1 },
        [`${this.topics.base}/requests/+/result`]: { qos: 1 },
      })
    } catch (error) {
      this.client = undefined
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
        const waiters = this.resultWaiters.get(requestId) ?? []
        this.resultWaiters.set(requestId, waiters.filter(waiter => waiter !== finish))
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
    const resultMatch = new RegExp(`^${this.topics.base.replaceAll('/', '\\/')}\\/requests\\/([^/]+)\\/result$`).exec(topic)
    if (resultMatch !== null && value !== null && typeof value === 'object') {
      const waiters = this.resultWaiters.get(resultMatch[1] as string)
      const result = value as GatewayResult
      if (waiters === undefined || waiters.length === 0) this.results.set(resultMatch[1] as string, result)
      for (const waiter of waiters ?? []) waiter(result)
      this.resultWaiters.delete(resultMatch[1] as string)
      return
    }
    const eventMatch = new RegExp(`^${this.topics.base.replaceAll('/', '\\/')}\\/requests\\/([^/]+)\\/events$`).exec(topic)
    if (eventMatch !== null && value !== null && typeof value === 'object') {
      for (const listener of this.eventListeners) listener(value as GatewayEvent)
    }
  }
}
