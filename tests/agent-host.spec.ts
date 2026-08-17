import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHostError, DshAgentHost, type AgentHostHandlers } from '../src/agent-host.ts'
import { resolveConfig } from '../src/config.ts'

type FakeAgent = Agent & {
  followupMock: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  steerMock: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  injectMock: ReturnType<typeof vi.fn<(message: UserMessage) => void>>
  cancelMock: ReturnType<typeof vi.fn>
}

function fakeAgent(id: string): FakeAgent {
  const followupMock = vi.fn<(message: UserMessage) => void>()
  const steerMock = vi.fn<(message: UserMessage) => void>()
  const injectMock = vi.fn<(message: UserMessage) => void>()
  const cancelMock = vi.fn()
  return {
    id,
    session: { id } as Agent['session'],
    status: 'idle',
    options: {},
    inbox: {} as Agent['inbox'],
    ctx: {} as Context,
    followup: followupMock,
    steer: steerMock,
    inject: injectMock,
    cancel: cancelMock,
    followupMock,
    steerMock,
    injectMock,
    cancelMock,
    whenIdle: vi.fn(async () => undefined),
    runMaintenance: vi.fn(),
    send: vi.fn(),
  } as unknown as FakeAgent
}

function fakeContext() {
  const agents = new Map<string, FakeAgent>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const currentSelection = vi.fn(() => ({ provider: 'profile-provider', model: 'profile-model' }))
  const create = vi.fn(async (options: CreateAgentOptions) => {
    const sessionId = String(options.sessionId)
    const agent = fakeAgent(sessionId)
    agents.set(sessionId, agent)
    const handle: AgentHandle = {
      agent,
      dispose: vi.fn(async () => { agents.delete(sessionId) }),
    }
    return handle
  })
  const resume = vi.fn(async (options: ResumeAgentOptions) => {
    const sessionId = String(options.resumeSessionId)
    const agent = fakeAgent(sessionId)
    agents.set(sessionId, agent)
    return {
      agent,
      dispose: vi.fn(async () => { agents.delete(sessionId) }),
    } satisfies AgentHandle
  })
  const context = {
    agentDefaultModel: { currentSelection },
    agents: {
      get: (id: string) => agents.get(id),
      create,
      resume,
    },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const bucket = listeners.get(name) ?? new Set()
      bucket.add(listener)
      listeners.set(name, bucket)
      return () => { bucket.delete(listener) }
    },
  } as unknown as Context
  return {
    context,
    agents,
    create,
    currentSelection,
    resume,
    emit(name: string, ...args: unknown[]) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
}

const directories: string[] = []

async function setup(useProfileModel = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mqtt-agent-host-'))
  directories.push(directory)
  const config = resolveConfig({
    url: 'mqtt://localhost',
    namespace: 'test',
    nodeId: 'node',
    workspaces: { app: directory },
    defaultWorkspace: 'app',
    ...useProfileModel ? {} : { provider: 'deepseek-official', model: 'deepseek-chat' },
    maxTokens: 2_048,
  })
  const fake = fakeContext()
  const host = new DshAgentHost(fake.context, config)
  const handlers: AgentHostHandlers = {
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
  }
  host.start(handlers)
  return { directory, config, fake, host, handlers }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('DshAgentHost', () => {
  it('creates an agent in an allowlisted workspace and delivers all input modes', async () => {
    const fixture = await setup()
    const lease = await fixture.host.acquire({ requestId: 'req-1', workspace: 'app' })
    expect(lease).toEqual({ sessionId: expect.stringMatching(/^mqtt-[0-9a-f-]{36}$/), owned: true })
    expect(fixture.fake.create).toHaveBeenCalledWith({
      sessionId: lease.sessionId,
      meta: { cwd: fixture.directory },
      agentOptions: {
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        maxTokens: 2_048,
      },
      setup: expect.any(Function),
    })

    const agent = fixture.fake.agents.get(lease.sessionId) as FakeAgent
    fixture.host.send(lease.sessionId, 'followup', 'first')
    fixture.host.send(lease.sessionId, 'steer', 'second')
    fixture.host.send(lease.sessionId, 'inject', 'third')
    fixture.host.cancel(lease.sessionId)

    expect(agent.followupMock.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user' },
    })
    expect(agent.steerMock).toHaveBeenCalledOnce()
    expect(agent.injectMock).toHaveBeenCalledOnce()
    expect(agent.cancelMock).toHaveBeenCalledWith({ kind: 'user' })

    await fixture.host.release(lease.sessionId)
    expect(fixture.fake.agents.has(lease.sessionId)).toBe(false)
  })

  it('reuses live agents and resumes persisted sessions otherwise', async () => {
    const fixture = await setup()
    const live = fakeAgent('live-session')
    fixture.fake.agents.set('live-session', live)

    await expect(fixture.host.acquire({ requestId: 'one', sessionId: 'live-session' }))
      .resolves.toEqual({ sessionId: 'live-session', owned: false })
    expect(fixture.fake.resume).not.toHaveBeenCalled()

    await expect(fixture.host.acquire({ requestId: 'two', sessionId: 'persisted-session' }))
      .resolves.toEqual({ sessionId: 'persisted-session', owned: true })
    expect(fixture.fake.resume).toHaveBeenCalledWith({
      resumeSessionId: 'persisted-session',
      agentOptions: fixture.config.agentOptions,
      setup: expect.any(Function),
    })
  })

  it('uses the profile default model when no explicit model override is configured', async () => {
    const fixture = await setup(true)
    await fixture.host.acquire({ requestId: 'default-model', workspace: 'app' })
    expect(fixture.fake.currentSelection).toHaveBeenCalledOnce()
    expect(fixture.fake.create).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: {
        provider: 'profile-provider',
        model: 'profile-model',
        maxTokens: 2_048,
      },
      setup: expect.any(Function),
    }))
  })

  it('forwards only live DSH lifecycle events while started', async () => {
    const fixture = await setup()
    const agent = fakeAgent('session-events')
    fixture.fake.emit('session/event', agent.session, { seq: 1, type: 'turn/start', data: { turn: 1 } })
    fixture.fake.emit('agent/status', { agent, status: 'running' })
    fixture.fake.emit('agent/error', { agent, turn: 1, step: 2, error: new Error('boom') })

    expect(fixture.handlers.onEvent).toHaveBeenCalledWith({
      sessionId: 'session-events',
      event: { seq: 1, type: 'turn/start', data: { turn: 1 } },
    })
    expect(fixture.handlers.onStatus).toHaveBeenCalledWith({ sessionId: 'session-events', status: 'running' })
    expect(fixture.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-events',
      turn: 1,
      step: 2,
    }))

    await fixture.host.dispose()
    fixture.fake.emit('agent/status', { agent, status: 'idle' })
    expect(fixture.handlers.onStatus).toHaveBeenCalledTimes(1)
  })

  it('rejects unconfigured or unavailable workspaces and dead agents', async () => {
    const fixture = await setup()
    await expect(fixture.host.acquire({ requestId: 'bad', workspace: 'missing' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_ALLOWED' } satisfies Partial<AgentHostError>)
    expect(() => fixture.host.send('missing-session', 'followup', 'input'))
      .toThrowError(expect.objectContaining({ code: 'AGENT_NOT_LIVE' }))
  })
})
