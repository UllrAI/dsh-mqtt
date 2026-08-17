import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentAction,
  AgentHostHandlers,
  AgentLease,
  AcquireAgentOptions,
  GatewayAgentHost,
} from '../src/agent-host.ts'
import { resolveConfig, type Config as PluginConfig } from '../src/config.ts'
import { MqttAgentGateway } from '../src/gateway.ts'
import type { GatewayResult } from '../src/protocol.ts'
import { RequestStore } from '../src/state-store.ts'
import type {
  GatewayTransport,
  IncomingMessage,
  Logger,
  PublishOptions,
  TransportHandlers,
} from '../src/transport.ts'

interface Publication {
  topic: string
  value: Record<string, unknown>
  options: PublishOptions
}

class FakeTransport implements GatewayTransport {
  handlers: TransportHandlers | undefined
  publications: Publication[] = []
  stopped = false

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers
    await handlers.onConnect()
  }

  async publish(topic: string, payload: string, options: PublishOptions): Promise<void> {
    this.publications.push({ topic, value: JSON.parse(payload) as Record<string, unknown>, options })
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  emit(message: IncomingMessage): void {
    this.handlers?.onMessage(message)
  }
}

class FakeAgentHost implements GatewayAgentHost {
  handlers: AgentHostHandlers | undefined
  acquisitions: AcquireAgentOptions[] = []
  sends: Array<{ sessionId: string; action: AgentAction; input: string }> = []
  cancellations: string[] = []
  releases: string[] = []
  disposed = false
  acquireError: Error | undefined
  sendError: Error | undefined

  start(handlers: AgentHostHandlers): void {
    this.handlers = handlers
  }

  async acquire(options: AcquireAgentOptions): Promise<AgentLease> {
    if (this.acquireError !== undefined) throw this.acquireError
    this.acquisitions.push(options)
    return {
      sessionId: options.sessionId ?? `session-${options.requestId}`,
      owned: options.sessionId === undefined,
    }
  }

  send(sessionId: string, action: AgentAction, input: string): void {
    if (this.sendError !== undefined) throw this.sendError
    this.sends.push({ sessionId, action, input })
  }

  cancel(sessionId: string): void {
    this.cancellations.push(sessionId)
  }

  async release(sessionId: string): Promise<void> {
    this.releases.push(sessionId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }

  event(sessionId: string, event: unknown): void {
    this.handlers?.onEvent({ sessionId, event })
  }

  status(sessionId: string, status: 'idle' | 'running'): void {
    this.handlers?.onStatus({ sessionId, status })
  }

  error(sessionId: string, error: unknown): void {
    this.handlers?.onError({ sessionId, turn: 1, step: 1, error })
  }
}

function quietLogger(): Logger & { errors: unknown[][]; warnings: unknown[][] } {
  const errors: unknown[][] = []
  const warnings: unknown[][] = []
  return {
    errors,
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (...args) => { warnings.push(args) },
    error: (...args) => { errors.push(args) },
  }
}

const directories: string[] = []

async function setup(overrides: Partial<PluginConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mqtt-gateway-'))
  directories.push(directory)
  const config = resolveConfig({
    url: 'mqtt://broker.test:1883',
    namespace: 'test',
    nodeId: 'worker',
    stateFile: join(directory, 'state.json'),
    workspaces: { app: directory },
    defaultWorkspace: 'app',
    ...overrides,
  })
  const transport = new FakeTransport()
  const host = new FakeAgentHost()
  const store = new RequestStore(config.stateFile, config.limits.dedupTtlMs)
  const logger = quietLogger()
  const gateway = new MqttAgentGateway(config, transport, host, store, logger)
  await gateway.start()
  return { config, transport, host, store, logger, gateway }
}

function submit(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id,
    type: 'request.submit',
    timestamp: '2026-08-17T12:00:00Z',
    input: `work for ${id}`,
    workspace: 'app',
    ...overrides,
  }
}

function control(id: string, commandId: string, type: string, input?: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    command_id: commandId,
    type,
    timestamp: '2026-08-17T12:01:00Z',
    ...input === undefined ? {} : { input },
  }
}

async function inbound(
  fixture: Awaited<ReturnType<typeof setup>>,
  topic: string,
  value: unknown,
  retain = false,
): Promise<void> {
  fixture.transport.emit({
    topic,
    payload: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    qos: 1,
    retain,
  })
  await fixture.gateway.whenIdle()
}

function publications(fixture: Awaited<ReturnType<typeof setup>>, type: string): Publication[] {
  return fixture.transport.publications.filter(item => item.value.type === type)
}

function lastResult(fixture: Awaited<ReturnType<typeof setup>>, id: string): GatewayResult | undefined {
  return fixture.transport.publications
    .filter(item => item.topic === fixture.gateway.topics.result(id))
    .at(-1)?.value as unknown as GatewayResult | undefined
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('MqttAgentGateway', () => {
  it('runs request → agent events → completed result end to end', async () => {
    const fixture = await setup()
    expect(fixture.transport.publications[0]).toMatchObject({
      topic: fixture.gateway.topics.status,
      value: { type: 'node.status', online: true, node_id: 'worker' },
      options: { qos: 1, retain: true },
    })

    await inbound(fixture, fixture.gateway.topics.requests, submit('req-1', { metadata: { source: 'test' } }))
    expect(fixture.host.acquisitions).toEqual([{ requestId: 'req-1', workspace: 'app' }])
    expect(fixture.host.sends).toEqual([{
      sessionId: 'session-req-1',
      action: 'followup',
      input: 'work for req-1',
    }])
    expect((await fixture.store.get('req-1'))?.status).toBe('active')

    fixture.host.status('session-req-1', 'running')
    fixture.host.event('session-req-1', {
      seq: 4,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Done' } },
    })
    fixture.host.event('session-req-1', {
      seq: 5,
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'All tests passed.' }] } },
    })
    fixture.host.event('session-req-1', {
      seq: 6,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    fixture.host.status('session-req-1', 'idle')
    await fixture.gateway.whenIdle()

    expect(publications(fixture, 'agent.output.delta').at(-1)?.value).toMatchObject({
      id: 'req-1',
      sequence: 4,
      data: { text: 'Done' },
    })
    expect(lastResult(fixture, 'req-1')).toMatchObject({
      status: 'completed',
      session_id: 'session-req-1',
      summary: 'All tests passed.',
      error: null,
    })
    expect((await fixture.store.get('req-1'))?.status).toBe('completed')
    expect(fixture.host.releases).toEqual(['session-req-1'])
    expect(fixture.logger.errors).toEqual([])
  })

  it('deduplicates submits and rejects conflicting request ids', async () => {
    const fixture = await setup()
    await inbound(fixture, fixture.gateway.topics.requests, submit('same'))
    await inbound(fixture, fixture.gateway.topics.requests, submit('same'))
    expect(fixture.host.sends).toHaveLength(1)
    expect(publications(fixture, 'request.duplicate')).toHaveLength(1)

    await inbound(fixture, fixture.gateway.topics.requests, submit('same', { input: 'different' }))
    expect(lastResult(fixture, 'same')).toMatchObject({
      status: 'failed',
      error: { code: 'REQUEST_ID_CONFLICT' },
    })
    expect(fixture.host.sends).toHaveLength(1)

    fixture.host.event('session-same', {
      seq: 1,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    fixture.host.status('session-same', 'idle')
    await fixture.gateway.whenIdle()
    const terminalResults = fixture.transport.publications
      .filter(item => item.topic === fixture.gateway.topics.result('same')).length
    await inbound(fixture, fixture.gateway.topics.requests, submit('same'))
    expect(fixture.transport.publications
      .filter(item => item.topic === fixture.gateway.topics.result('same'))).toHaveLength(terminalResults + 1)
    expect(fixture.host.sends).toHaveLength(1)
  })

  it('routes steer/inject/cancel once and reports a cancelled terminal state', async () => {
    const fixture = await setup()
    await inbound(fixture, fixture.gateway.topics.requests, submit('req-control'))
    const topic = fixture.gateway.topics.control('req-control')

    await inbound(fixture, topic, control('req-control', 'cmd-steer', 'request.steer', 'new direction'))
    await inbound(fixture, topic, control('req-control', 'cmd-steer', 'request.steer', 'new direction'))
    await inbound(fixture, topic, control('req-control', 'cmd-inject', 'request.inject', 'extra context'))
    await inbound(fixture, topic, control('req-control', 'cmd-cancel', 'request.cancel'))

    expect(fixture.host.sends).toEqual([
      { sessionId: 'session-req-control', action: 'followup', input: 'work for req-control' },
      { sessionId: 'session-req-control', action: 'steer', input: 'new direction' },
      { sessionId: 'session-req-control', action: 'inject', input: 'extra context' },
    ])
    expect(fixture.host.cancellations).toEqual(['session-req-control'])
    expect(publications(fixture, 'request.control.duplicate')).toHaveLength(1)

    fixture.host.event('session-req-control', {
      seq: 4,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
    fixture.host.status('session-req-control', 'idle')
    await fixture.gateway.whenIdle()
    expect(lastResult(fixture, 'req-control')).toMatchObject({ status: 'cancelled', error: null })
  })

  it('never executes retained commands and enforces capacity and session exclusivity', async () => {
    const fixture = await setup({ maxActiveRequests: 1 })
    await inbound(fixture, fixture.gateway.topics.requests, submit('retained'), true)
    expect(lastResult(fixture, 'retained')).toMatchObject({ error: { code: 'RETAINED_COMMAND' } })
    expect(fixture.host.sends).toHaveLength(0)

    await inbound(fixture, fixture.gateway.topics.requests, submit('first', { session_id: 'shared' }))
    await inbound(fixture, fixture.gateway.topics.requests, submit('second', { session_id: 'shared' }))
    expect(lastResult(fixture, 'second')).toMatchObject({ error: { code: 'CAPACITY_EXCEEDED' } })

    const controlTopic = fixture.gateway.topics.control('first')
    await inbound(fixture, controlTopic, control('first', 'retained-cancel', 'request.cancel'), true)
    expect(fixture.host.cancellations).toHaveLength(0)
    expect(publications(fixture, 'request.control.rejected').at(-1)?.value)
      .toMatchObject({ data: { error: { code: 'RETAINED_COMMAND' } } })
  })

  it('enforces one active MQTT request per resumed session independently of capacity', async () => {
    const fixture = await setup({ maxActiveRequests: 2 })
    await inbound(fixture, fixture.gateway.topics.requests, submit('first', { session_id: 'shared' }))
    await inbound(fixture, fixture.gateway.topics.requests, submit('second', { session_id: 'shared' }))
    expect(lastResult(fixture, 'second')).toMatchObject({
      status: 'failed',
      error: { code: 'SESSION_BUSY', retryable: true },
    })
    expect(fixture.host.acquisitions).toHaveLength(1)
  })

  it('rejects missing, mismatched, and conflicting control commands', async () => {
    const fixture = await setup()
    await inbound(
      fixture,
      fixture.gateway.topics.control('missing'),
      control('missing', 'cmd-missing', 'request.cancel'),
    )
    expect(publications(fixture, 'request.control.rejected').at(-1)?.value)
      .toMatchObject({ data: { error: { code: 'REQUEST_NOT_FOUND' } } })

    await inbound(fixture, fixture.gateway.topics.requests, submit('controlled'))
    const topic = fixture.gateway.topics.control('controlled')
    await inbound(fixture, topic, control('controlled', 'cmd-1', 'request.steer', 'first'))
    await inbound(fixture, topic, control('controlled', 'cmd-1', 'request.steer', 'changed'))
    expect(publications(fixture, 'request.control.rejected').at(-1)?.value)
      .toMatchObject({ data: { error: { code: 'COMMAND_ID_CONFLICT' } } })

    await inbound(fixture, topic, control('other', 'cmd-2', 'request.cancel'))
    expect(lastResult(fixture, 'controlled')).toMatchObject({ error: { code: 'REQUEST_ID_MISMATCH' } })
  })

  it('turns agent acquisition and initial delivery failures into durable results', async () => {
    const acquisition = await setup()
    acquisition.host.acquireError = new Error('factory offline')
    await inbound(acquisition, acquisition.gateway.topics.requests, submit('acquire-failed'))
    expect(lastResult(acquisition, 'acquire-failed')).toMatchObject({
      status: 'failed',
      error: { code: 'AGENT_START_FAILED', message: 'factory offline' },
    })

    const delivery = await setup()
    delivery.host.sendError = new Error('agent disposed')
    await inbound(delivery, delivery.gateway.topics.requests, submit('send-failed'))
    expect(lastResult(delivery, 'send-failed')).toMatchObject({
      status: 'failed',
      session_id: 'session-send-failed',
      error: { code: 'AGENT_START_FAILED', message: 'agent disposed' },
    })
    expect(delivery.host.releases).toEqual(['session-send-failed'])
  })

  it('turns agent errors and non-completed outcomes into failed results', async () => {
    const fixture = await setup()
    await inbound(fixture, fixture.gateway.topics.requests, submit('failure'))
    fixture.host.error('session-failure', new Error('provider unavailable'))
    fixture.host.event('session-failure', {
      seq: 4,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { code: 'UPSTREAM' } } },
    })
    fixture.host.status('session-failure', 'idle')
    await fixture.gateway.whenIdle()
    expect(lastResult(fixture, 'failure')).toMatchObject({
      status: 'failed',
      error: { code: 'AGENT_ERROR', message: 'provider unavailable' },
    })
  })

  it('maps a blocked turn without an operational error to a stable result code', async () => {
    const fixture = await setup()
    await inbound(fixture, fixture.gateway.topics.requests, submit('blocked'))
    fixture.host.event('session-blocked', {
      seq: 4,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'blocked' } },
    })
    fixture.host.status('session-blocked', 'idle')
    await fixture.gateway.whenIdle()
    expect(lastResult(fixture, 'blocked')).toMatchObject({
      status: 'failed',
      error: { code: 'TURN_BLOCKED' },
    })
  })

  it('recovers interrupted records once and republishes their result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mqtt-gateway-recovery-'))
    directories.push(directory)
    const stateFile = join(directory, 'state.json')
    const seed = new RequestStore(stateFile, 60_000)
    await seed.open()
    await seed.reserve('interrupted', 'fingerprint')
    await seed.activate('interrupted', 'old-session')
    await seed.close()

    const fixture = await setup({ stateFile })
    expect(lastResult(fixture, 'interrupted')).toMatchObject({
      status: 'failed',
      session_id: 'old-session',
      error: { code: 'GATEWAY_RESTARTED', retryable: true },
    })
    const beforeReconnect = fixture.transport.publications.length
    await fixture.transport.handlers?.onConnect()
    expect(fixture.transport.publications.slice(beforeReconnect)
      .filter(item => item.value.type === 'request.result')).toHaveLength(0)
  })

  it('finishes active requests and publishes retained offline presence on stop', async () => {
    const fixture = await setup()
    await inbound(fixture, fixture.gateway.topics.requests, submit('stopping'))
    await fixture.gateway.stop()

    expect(lastResult(fixture, 'stopping')).toMatchObject({
      status: 'failed',
      error: { code: 'GATEWAY_STOPPED', retryable: true },
    })
    expect(fixture.transport.publications.at(-1)).toMatchObject({
      topic: fixture.gateway.topics.status,
      value: { online: false },
      options: { retain: true },
    })
    expect(fixture.host.disposed).toBe(true)
    expect(fixture.transport.stopped).toBe(true)
    await expect(fixture.gateway.stop()).resolves.toBeUndefined()
  })

  it('logs invalid uncorrelated JSON without publishing to an unsafe topic', async () => {
    const fixture = await setup()
    const before = fixture.transport.publications.length
    await inbound(fixture, fixture.gateway.topics.requests, '{')
    expect(fixture.transport.publications).toHaveLength(before)
    expect(fixture.logger.warnings).toHaveLength(1)
  })
})
