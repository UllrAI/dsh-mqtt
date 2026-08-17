import { createServer, type Server } from 'node:net'
import { createBroker } from 'aedes'
import type Aedes from 'aedes'
import { connectAsync, type MqttClient } from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { MqttTransport } from '../src/mqtt-transport.ts'
import { TopicLayout } from '../src/topics.ts'
import type { IncomingMessage, Logger } from '../src/transport.ts'

interface BrokerFixture {
  broker: Aedes
  server: Server
  url: string
}

const brokers: BrokerFixture[] = []
const clients: MqttClient[] = []
const transports: MqttTransport[] = []

function logger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }
}

async function brokerFixture(): Promise<BrokerFixture> {
  const broker = createBroker()
  const server = createServer(broker.handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test broker has no TCP address')
  const fixture = { broker, server, url: `mqtt://127.0.0.1:${address.port}` }
  brokers.push(fixture)
  return fixture
}

async function observer(url: string): Promise<MqttClient> {
  const client = await connectAsync(url, {
    protocolVersion: 4,
    clientId: `observer-${crypto.randomUUID()}`,
    clean: true,
    reconnectPeriod: 0,
  })
  clients.push(client)
  return client
}

function nextMessage(client: MqttClient, predicate: (topic: string, payload: Buffer) => boolean): Promise<{
  topic: string
  payload: Buffer
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage)
      reject(new Error('timed out waiting for MQTT message'))
    }, 3_000)
    const onMessage = (topic: string, payload: Buffer): void => {
      if (!predicate(topic, payload)) return
      clearTimeout(timer)
      client.off('message', onMessage)
      resolve({ topic, payload })
    }
    client.on('message', onMessage)
  })
}

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map(transport => transport.stop()))
  await Promise.allSettled(clients.splice(0).map(client => client.endAsync(true)))
  await Promise.all(brokers.splice(0).map(async ({ broker, server }) => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => broker.close(resolve))
  }))
})

describe('MqttTransport integration', () => {
  it('subscribes to commands and publishes correlated output through a real broker', async () => {
    const fixture = await brokerFixture()
    const config = resolveConfig({
      url: fixture.url,
      namespace: 'integration',
      nodeId: 'worker',
      clientId: 'dsh-mqtt-integration-worker',
      protocolVersion: 4,
      clean: true,
      reconnectPeriodMs: 0,
    })
    const topics = new TopicLayout(config.namespace, config.nodeId)
    const transport = new MqttTransport({
      config,
      topics,
      offlineStatus: JSON.stringify({ type: 'node.status', online: false }),
      logger: logger(),
    })
    transports.push(transport)
    const received: IncomingMessage[] = []
    let finishHandling: (() => void) | undefined
    let handling = new Promise<void>(resolve => { finishHandling = resolve })
    let connections = 0
    await transport.start({
      onMessage: async message => {
        received.push(message)
        await handling
      },
      onConnect: async () => {
        connections += 1
        await transport.publish(topics.status, JSON.stringify({ type: 'node.status', online: true }), {
          qos: 1,
          retain: true,
        })
      },
    })
    expect(connections).toBe(1)

    const client = await observer(fixture.url)
    const publish = client.publishAsync(topics.requests, JSON.stringify({ id: 'req-1' }), { qos: 1 })
    await expect.poll(() => received.length).toBe(1)
    finishHandling?.()
    await publish
    expect(received[0]).toMatchObject({ topic: topics.requests, qos: 1, retain: false })
    expect(Buffer.from(received[0]?.payload ?? []).toString()).toBe('{"id":"req-1"}')

    handling = new Promise<void>(resolve => { finishHandling = resolve })
    const packet = { qos: 1, retain: false }
    const internal = transport as unknown as { client: MqttClient }
    internal.client.emit('message', topics.requests, Buffer.from('{}'), packet as never)
    let handled = false
    internal.client.handleMessage(packet as never, () => { handled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(handled).toBe(false)
    finishHandling?.()
    await expect.poll(() => handled).toBe(true)

    await client.subscribeAsync(topics.result('req-1'), { qos: 1 })
    const output = nextMessage(client, topic => topic === topics.result('req-1'))
    await transport.publish(topics.result('req-1'), JSON.stringify({ status: 'completed' }), { qos: 1 })
    expect(JSON.parse((await output).payload.toString())).toEqual({ status: 'completed' })
  })

  it('publishes its retained Last Will after an ungraceful disconnect', async () => {
    const fixture = await brokerFixture()
    const config = resolveConfig({
      url: fixture.url,
      namespace: 'integration',
      nodeId: 'will-worker',
      clientId: 'dsh-mqtt-will-worker',
      protocolVersion: 4,
      clean: true,
      reconnectPeriodMs: 0,
    })
    const topics = new TopicLayout(config.namespace, config.nodeId)
    const offline = JSON.stringify({ type: 'node.status', online: false, node_id: config.nodeId })
    const transport = new MqttTransport({ config, topics, offlineStatus: offline, logger: logger() })
    transports.push(transport)

    const client = await observer(fixture.url)
    await client.subscribeAsync(topics.status, { qos: 1 })
    const online = nextMessage(client, (_topic, payload) => JSON.parse(payload.toString()).online === true)
    await transport.start({
      onMessage: () => undefined,
      onConnect: () => transport.publish(topics.status, JSON.stringify({ type: 'node.status', online: true }), {
        qos: 1,
        retain: true,
      }),
    })
    await online

    const will = nextMessage(client, (_topic, payload) => JSON.parse(payload.toString()).online === false)
    const internal = transport as unknown as { client: MqttClient }
    internal.client.stream.destroy()
    expect((await will).payload.toString()).toBe(offline)

    const late = await observer(fixture.url)
    const retained = nextMessage(late, topic => topic === topics.status)
    await late.subscribeAsync(topics.status, { qos: 1 })
    expect(JSON.parse((await retained).payload.toString())).toMatchObject({ online: false, node_id: 'will-worker' })
  })
})
