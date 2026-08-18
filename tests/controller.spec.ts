import { createServer, type Server } from 'node:net'
import { createBroker } from 'aedes'
import type Aedes from 'aedes'
import { connectAsync, type MqttClient } from 'mqtt'
import { afterEach, describe, expect, it } from 'vitest'
import { MqttControllerClient } from '../src/controller.ts'
import { TopicLayout } from '../src/topics.ts'

let broker: Aedes | undefined
let server: Server | undefined
let observer: MqttClient | undefined
let controller: MqttControllerClient | undefined

afterEach(async () => {
  await controller?.disconnect()
  await observer?.endAsync(true)
  if (server !== undefined) await new Promise<void>(resolve => server?.close(() => resolve()))
  if (broker !== undefined) await new Promise<void>(resolve => broker?.close(resolve))
  broker = undefined
  server = undefined
  observer = undefined
  controller = undefined
})

describe('MqttControllerClient', () => {
  it('submits authenticated requests and receives correlated results through a real broker', async () => {
    broker = createBroker()
    server = createServer(broker.handle)
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('broker has no port')
    const url = `mqtt://127.0.0.1:${address.port}`
    const topics = new TopicLayout('test', 'worker')
    observer = await connectAsync(url, { protocolVersion: 4, clean: true })
    await observer.subscribeAsync(topics.requests, { qos: 1 })
    controller = new MqttControllerClient({
      url,
      namespace: 'test',
      nodeId: 'worker',
      controllerId: 'controller-1',
      token: 'controller-token',
      protocolVersion: 4,
    })
    await controller.connect()
    await expect(controller.connect()).rejects.toThrow(/already connected/)

    const statusReceived = new Promise<Record<string, unknown>>(resolve => {
      controller?.onStatus(status => resolve(status as unknown as Record<string, unknown>))
    })
    await observer.publishAsync(topics.status, JSON.stringify({ type: 'node.status', state: 'ready' }), { qos: 1 })
    await expect(statusReceived).resolves.toMatchObject({ state: 'ready' })

    const eventReceived = new Promise<Record<string, unknown>>(resolve => {
      controller?.onEvent(event => resolve(event as unknown as Record<string, unknown>))
    })
    await observer.publishAsync(topics.events('event-request'), JSON.stringify({
      version: 1,
      id: 'event-request',
      type: 'agent.status',
      timestamp: new Date().toISOString(),
    }), { qos: 1 })
    await expect(eventReceived).resolves.toMatchObject({ id: 'event-request', type: 'agent.status' })

    const received = new Promise<Record<string, unknown>>(resolve => {
      observer?.once('message', (_topic, payload) => resolve(JSON.parse(payload.toString()) as Record<string, unknown>))
    })
    const requestId = await controller.submit({ input: 'Run tests', workspace: 'app' })
    expect(await received).toMatchObject({
      id: requestId,
      type: 'request.submit',
      controller_id: 'controller-1',
      token: 'controller-token',
    })

    const result = controller.waitForResult(requestId, 3_000)
    await observer.publishAsync(topics.result(requestId), JSON.stringify({
      version: 1,
      id: requestId,
      type: 'request.result',
      timestamp: new Date().toISOString(),
      status: 'completed',
      error: null,
    }), { qos: 1 })
    await expect(result).resolves.toMatchObject({ id: requestId, status: 'completed' })

    await observer.subscribeAsync(topics.control(requestId), { qos: 1 })
    const controlReceived = new Promise<Record<string, unknown>>(resolve => {
      observer?.once('message', (topic, payload) => {
        if (topic === topics.control(requestId)) resolve(JSON.parse(payload.toString()) as Record<string, unknown>)
      })
    })
    const commandId = await controller.control(requestId, 'request.steer', 'Use another approach')
    await expect(controlReceived).resolves.toMatchObject({
      command_id: commandId,
      input: 'Use another approach',
      controller_id: 'controller-1',
    })

    await expect(controller.waitForResult('never-finishes', 5)).rejects.toThrow(/timed out/)
    await controller.disconnect()
    await controller.disconnect()
    await expect(controller.submit({ input: 'offline' })).rejects.toThrow(/not connected/)
  })
})
