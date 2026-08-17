import { readFile } from 'node:fs/promises'
import { connect, type IClientOptions, type MqttClient } from 'mqtt'
import type { ResolvedConfig } from './config.ts'
import type { GatewayTransport, Logger, PublishOptions, TransportHandlers } from './transport.ts'
import type { TopicLayout } from './topics.ts'

export interface MqttTransportOptions {
  config: ResolvedConfig
  topics: TopicLayout
  offlineStatus: string
  logger: Logger
}

async function optionalFile(path: string | undefined): Promise<Buffer | undefined> {
  return path === undefined ? undefined : readFile(path)
}

export class MqttTransport implements GatewayTransport {
  private client: MqttClient | undefined
  private stopping = false
  private connectGeneration = 0

  constructor(private readonly options: MqttTransportOptions) {}

  async start(handlers: TransportHandlers): Promise<void> {
    if (this.client !== undefined) throw new Error('dsh-mqtt transport is already started')
    this.stopping = false
    const { config, topics, offlineStatus, logger } = this.options
    const [ca, cert, key] = await Promise.all([
      optionalFile(config.caFile),
      optionalFile(config.certFile),
      optionalFile(config.keyFile),
    ])
    const clientOptions: IClientOptions = {
      clientId: config.clientId,
      protocolVersion: config.protocolVersion,
      clean: config.clean,
      keepalive: config.keepaliveSeconds,
      connectTimeout: config.connectTimeoutMs,
      reconnectPeriod: config.reconnectPeriodMs,
      resubscribe: false,
      queueQoSZero: false,
      rejectUnauthorized: config.rejectUnauthorized,
      will: {
        topic: topics.status,
        payload: Buffer.from(offlineStatus),
        qos: 1,
        retain: true,
      },
      ...config.protocolVersion === 5
        ? { properties: { sessionExpiryInterval: config.sessionExpirySeconds } }
        : {},
      ...config.username === undefined ? {} : { username: config.username },
      ...config.password === undefined ? {} : { password: config.password },
      ...ca === undefined ? {} : { ca },
      ...cert === undefined ? {} : { cert },
      ...key === undefined ? {} : { key },
    }

    const client = connect(config.url, clientOptions)
    this.client = client
    const messageTasks = new WeakMap<object, Promise<void>>()
    client.on('message', (topic, payload, packet) => {
      const message = {
        topic,
        payload: Buffer.from(payload),
        qos: packet.qos,
        retain: packet.retain,
      } as const
      const task = Promise.resolve().then(() => handlers.onMessage(message))
      messageTasks.set(packet, task)
    })
    client.handleMessage = (packet, callback): void => {
      const task = messageTasks.get(packet) ?? Promise.resolve()
      void task.then(
        () => {
          messageTasks.delete(packet)
          callback()
        },
        (error: unknown) => {
          messageTasks.delete(packet)
          callback(error instanceof Error ? error : new Error(String(error)))
        },
      )
    }
    client.on('reconnect', () => logger.info('dsh-mqtt: reconnecting to broker'))
    client.on('offline', () => logger.warn('dsh-mqtt: broker connection is offline'))
    client.on('error', error => logger.error('dsh-mqtt: broker error', error))

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let initializationQueue = Promise.resolve()
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const connected = (): void => {
        const generation = ++this.connectGeneration
        initializationQueue = initializationQueue.then(async () => {
          if (this.stopping || generation !== this.connectGeneration) return
          try {
            await client.subscribeAsync({
              [topics.requests]: { qos: 1 },
              [topics.controlFilter]: { qos: 1 },
            })
            if (this.stopping || generation !== this.connectGeneration) return
            await handlers.onConnect()
            if (!settled) {
              settled = true
              resolve()
            }
          } catch (error) {
            if (this.stopping || generation !== this.connectGeneration) return
            const reason = error instanceof Error ? error : new Error(String(error))
            logger.error('dsh-mqtt: failed to initialize broker subscription', reason)
            fail(reason)
          }
        })
      }
      client.on('connect', connected)
      client.once('error', fail)
    }).catch(async error => {
      await client.endAsync(true).catch(() => undefined)
      this.client = undefined
      throw error
    })
  }

  async publish(topic: string, payload: string, options: PublishOptions): Promise<void> {
    const client = this.client
    if (client === undefined || this.stopping) throw new Error('dsh-mqtt transport is not available')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const succeed = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const fail = (error?: Error): void => {
        if (settled) return
        if (error === undefined) succeed()
        else {
          settled = true
          reject(error)
        }
      }
      if (options.qos === 0) {
        client.publish(topic, payload, { qos: 0, retain: options.retain ?? false }, fail)
      } else {
        client.publish(topic, payload, {
          qos: 1,
          retain: options.retain ?? false,
          cbStorePut: succeed,
        }, fail)
      }
    })
  }

  async stop(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    this.stopping = true
    this.connectGeneration += 1
    this.client = undefined
    await client.endAsync(!client.connected)
  }
}
