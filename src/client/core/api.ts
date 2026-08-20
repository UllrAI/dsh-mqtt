/**
 * Typed client for the dsh-mqtt management API.
 *
 * Shared by both UI forms: the DSH settings panel talks to the gateway
 * cross-origin, the standalone page talks to its own origin.
 */

export interface NodeHealthCheck {
  name: string
  status: 'ready' | 'degraded' | 'offline'
  message?: string
}

export interface NodeStatus {
  timestamp: string
  heartbeat_at: string
  node_id: string
  display_name: string
  state: string
  online: boolean
  gateway_version: string
  capabilities: readonly string[]
  workspaces: Array<{ alias: string; status: string }>
  active_requests: number
  request_capacity: number
  controller_auth_required: boolean
  health?: NodeHealthCheck[]
}

export interface NodeConfig {
  url: string
  namespace: string
  node_id: string
  display_name: string
  default_workspace: string | null
  workspaces: string[]
  capabilities: string[]
  controller_auth_required: boolean
}

export interface Controller {
  id: string
  name: string
  scopes: string[]
  status: 'pending' | 'authorized' | 'revoked'
  createdAt: number
  updatedAt: number
  expiresAt: number
  lastUsedAt?: number
}

export interface ControllerInvite {
  id: string
  name: string
  token: string
  scopes: string[]
  expiresAt: number
}

export interface RequestRecord {
  id: string
  status: 'accepted' | 'active' | 'completed' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  sessionId?: string
  result?: {
    status?: string
    summary?: string
    error?: { code: string; message: string }
  }
}

export class ManagementApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ManagementApiError'
  }
}

export interface ManagementClientOptions {
  /** API root, e.g. `/api` for the standalone page or an absolute gateway URL. */
  baseUrl: string
  /** Bearer token, when the gateway requires one. */
  token?: (() => string | undefined) | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ManagementClient {
  constructor(private readonly options: ManagementClientOptions) {}

  get baseUrl(): string {
    return this.options.baseUrl
  }

  get token(): string | undefined {
    return this.options.token?.()
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.token
    let response: Response
    try {
      response = await fetch(`${this.options.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...token === undefined ? {} : { authorization: `Bearer ${token}` },
          ...init.headers,
        },
      })
    } catch (error) {
      // A transport failure has no HTTP status; 0 marks "never reached the gateway".
      throw new ManagementApiError(error instanceof Error ? error.message : String(error), 0)
    }
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`
      throw new ManagementApiError(message, response.status)
    }
    return body as T
  }

  async status(): Promise<NodeStatus> {
    return this.request<NodeStatus>('/status')
  }

  async config(): Promise<NodeConfig> {
    return this.request<NodeConfig>('/config')
  }

  async controllers(): Promise<Controller[]> {
    const body = await this.request<{ controllers?: Controller[] }>('/controllers')
    return body.controllers ?? []
  }

  async requests(limit = 50): Promise<RequestRecord[]> {
    const body = await this.request<{ requests?: RequestRecord[] }>(`/requests?limit=${limit}`)
    return body.requests ?? []
  }

  async createInvite(name: string, ttlSeconds = 600): Promise<ControllerInvite> {
    const body = await this.request<{ invite: ControllerInvite }>('/controllers/invites', {
      method: 'POST',
      body: JSON.stringify({ name, scopes: ['submit', 'control'], ttl_seconds: ttlSeconds }),
    })
    return body.invite
  }

  async authorizeController(id: string): Promise<void> {
    await this.request(`/controllers/${encodeURIComponent(id)}/authorize`, { method: 'POST', body: '{}' })
  }

  async revokeController(id: string): Promise<void> {
    await this.request(`/controllers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
}
