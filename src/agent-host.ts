import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentOptions,
  type AgentSetup,
  type AgentStatus,
  type ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.ts'

export type AgentAction = 'followup' | 'steer' | 'inject'

export interface AgentEvent {
  sessionId: string
  event: unknown
}

export interface AgentStatusEvent {
  sessionId: string
  status: 'idle' | 'running'
}

export interface AgentErrorEvent {
  sessionId: string
  turn: number
  step: number
  error: unknown
}

export interface AgentHostHandlers {
  onEvent(event: AgentEvent): void
  onStatus(event: AgentStatusEvent): void
  onError(event: AgentErrorEvent): void
}

export interface AcquireAgentOptions {
  requestId: string
  sessionId?: string
  workspace?: string
}

export interface AgentLease {
  sessionId: string
  owned: boolean
}

interface AgentDefaultModel {
  currentSelection(): ModelSelection
}

export interface GatewayAgentHost {
  start(handlers: AgentHostHandlers): void
  acquire(options: AcquireAgentOptions): Promise<AgentLease>
  send(sessionId: string, action: AgentAction, input: string): void
  cancel(sessionId: string): void
  release(sessionId: string): Promise<void>
  dispose(): Promise<void>
}

export class AgentHostError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
    this.name = 'AgentHostError'
  }
}

export class DshAgentHost implements GatewayAgentHost {
  private readonly owned = new Map<string, AgentHandle>()
  private readonly disposers: Array<() => void> = []
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(handlers: AgentHostHandlers): void {
    if (this.started) throw new Error('dsh-mqtt agent host is already started')
    this.started = true
    this.disposers.push(this.ctx.on('session/event', (session, event: SessionEvent) => {
      handlers.onEvent({ sessionId: String(session.id), event })
    }))
    this.disposers.push(this.ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
      handlers.onStatus({ sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(this.ctx.on('agent/error', ({ agent, turn, step, error }: {
      agent: Agent
      turn: number
      step: number
      error: unknown
    }) => {
      handlers.onError({ sessionId: String(agent.session.id), turn, step, error })
    }))
  }

  async acquire(options: AcquireAgentOptions): Promise<AgentLease> {
    this.assertStarted()
    const requestedSessionId = options.sessionId
    const sessionId = requestedSessionId ?? `mqtt-${randomUUID()}`
    const id = SessionId(sessionId)
    const existing = this.ctx.agents.get(id)
    if (existing !== undefined) {
      if (requestedSessionId === undefined) {
        throw new AgentHostError('SESSION_ID_CONFLICT', 'generated session id is already in use', true)
      }
      return { sessionId, owned: false }
    }

    const existingOwned = this.owned.get(sessionId)
    if (existingOwned !== undefined) return { sessionId, owned: true }

    const selection = this.modelSelection()
    const agentOptions: AgentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...this.config.agentOptions.maxTokens === undefined ? {} : { maxTokens: this.config.agentOptions.maxTokens },
    }
    const setup = this.modelSetup(selection)
    let handle: AgentHandle
    try {
      if (requestedSessionId !== undefined) {
        handle = await this.ctx.agents.resume({
          resumeSessionId: id,
          agentOptions,
          setup,
        })
      } else {
        const cwd = await this.resolveWorkspace(options.workspace)
        handle = await this.ctx.agents.create({
          sessionId: id,
          meta: { cwd },
          agentOptions,
          setup,
        })
      }
    } catch (error) {
      if (error instanceof AgentHostError) throw error
      throw new AgentHostError(
        requestedSessionId === undefined ? 'AGENT_CREATE_FAILED' : 'SESSION_RESUME_FAILED',
        error instanceof Error ? error.message : String(error),
        true,
      )
    }
    this.owned.set(sessionId, handle)
    return { sessionId, owned: true }
  }

  send(sessionId: string, action: AgentAction, input: string): void {
    const agent = this.requireAgent(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: 'user' },
    })
    agent[action](message)
  }

  cancel(sessionId: string): void {
    this.requireAgent(sessionId).cancel({ kind: 'user' })
  }

  async release(sessionId: string): Promise<void> {
    const handle = this.owned.get(sessionId)
    if (handle === undefined) return
    this.owned.delete(sessionId)
    await handle.dispose()
  }

  async dispose(): Promise<void> {
    while (this.disposers.length > 0) this.disposers.pop()?.()
    const handles = [...this.owned.values()]
    this.owned.clear()
    this.started = false
    const results = await Promise.allSettled(handles.map(handle => handle.dispose()))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'failed to dispose dsh-mqtt agents')
  }

  private requireAgent(sessionId: string): Agent {
    this.assertStarted()
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new AgentHostError('AGENT_NOT_LIVE', `session ${sessionId} has no live agent`)
    return agent
  }

  private async resolveWorkspace(requested: string | undefined): Promise<string> {
    const alias = requested ?? this.config.defaultWorkspace
    if (alias === undefined) {
      throw new AgentHostError('WORKSPACE_REQUIRED', 'request must select a configured workspace')
    }
    const path = this.config.workspaces[alias]
    if (path === undefined) {
      throw new AgentHostError('WORKSPACE_NOT_ALLOWED', `workspace ${JSON.stringify(alias)} is not allowed`)
    }
    try {
      const metadata = await stat(path)
      if (!metadata.isDirectory()) throw new Error('path is not a directory')
    } catch (error) {
      throw new AgentHostError(
        'WORKSPACE_UNAVAILABLE',
        `workspace ${JSON.stringify(alias)} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        true,
      )
    }
    return path
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('dsh-mqtt agent host is not started')
  }

  private modelSelection(): ModelSelection {
    const { provider, model } = this.config.agentOptions
    if (provider !== undefined && model !== undefined) return { provider, model }
    return (this.ctx as Context & { agentDefaultModel: AgentDefaultModel }).agentDefaultModel.currentSelection()
  }

  private modelSetup(fallback: ModelSelection): AgentSetup {
    return agentCtx => {
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('dsh-mqtt: agent setup has no scoped agent')
      const logged = agent.session.requestHeader()?.config
      const current: ModelSelection = logged === undefined
        ? fallback
        : {
            provider: logged.provider,
            model: logged.model,
            ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
          }
      installModelSelection(agentCtx, { current, assembled: undefined })
    }
  }
}
