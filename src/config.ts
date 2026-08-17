import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export type EventExposure = 'safe' | 'full'

export interface Config {
  url: string
  namespace: string
  nodeId: string
  clientId?: string
  protocolVersion?: 4 | 5
  clean?: boolean
  keepaliveSeconds?: number
  connectTimeoutMs?: number
  reconnectPeriodMs?: number
  sessionExpirySeconds?: number
  username?: string
  password?: string
  usernameEnv?: string
  passwordEnv?: string
  caFile?: string
  certFile?: string
  keyFile?: string
  rejectUnauthorized?: boolean
  stateFile?: string
  workspaces?: Record<string, string>
  defaultWorkspace?: string
  allowExternalSessions?: boolean
  provider?: string
  model?: string
  maxTokens?: number
  capabilities?: string[]
  eventExposure?: EventExposure
  maxMessageBytes?: number
  maxMetadataBytes?: number
  maxInputChars?: number
  maxActiveRequests?: number
  dedupTtlSeconds?: number
}

export interface ResolvedConfig {
  url: string
  namespace: string
  nodeId: string
  clientId: string
  protocolVersion: 4 | 5
  clean: boolean
  keepaliveSeconds: number
  connectTimeoutMs: number
  reconnectPeriodMs: number
  sessionExpirySeconds: number
  username?: string
  password?: string
  caFile?: string
  certFile?: string
  keyFile?: string
  rejectUnauthorized: boolean
  stateFile: string
  workspaces: Readonly<Record<string, string>>
  defaultWorkspace?: string
  allowExternalSessions: boolean
  agentOptions: {
    provider?: string
    model?: string
    maxTokens?: number
  }
  capabilities: readonly string[]
  eventExposure: EventExposure
  limits: {
    maxMessageBytes: number
    maxMetadataBytes: number
    maxInputChars: number
    maxActiveRequests: number
    dedupTtlMs: number
  }
}

export const Config: Schema<Config> = Schema.object({
  url: Schema.string().default('mqtt://127.0.0.1:1883'),
  namespace: Schema.string().default('local'),
  nodeId: Schema.string().default('dsh-node'),
  clientId: Schema.string(),
  protocolVersion: Schema.union([Schema.const(4), Schema.const(5)]).default(5),
  clean: Schema.boolean().default(false),
  keepaliveSeconds: Schema.number().default(30),
  connectTimeoutMs: Schema.number().default(10_000),
  reconnectPeriodMs: Schema.number().default(1_000),
  sessionExpirySeconds: Schema.number().default(86_400),
  username: Schema.string(),
  password: Schema.string().role('secret'),
  usernameEnv: Schema.string(),
  passwordEnv: Schema.string(),
  caFile: Schema.string(),
  certFile: Schema.string(),
  keyFile: Schema.string(),
  rejectUnauthorized: Schema.boolean().default(true),
  stateFile: Schema.string().default('.dsh-mqtt/state.json'),
  workspaces: Schema.dict(Schema.string()).default({}),
  defaultWorkspace: Schema.string(),
  allowExternalSessions: Schema.boolean().default(false),
  provider: Schema.string(),
  model: Schema.string(),
  maxTokens: Schema.number(),
  capabilities: Schema.array(Schema.string()).default([]),
  eventExposure: Schema.union(['safe', 'full']).default('safe'),
  maxMessageBytes: Schema.number().default(65_536),
  maxMetadataBytes: Schema.number().default(8_192),
  maxInputChars: Schema.number().default(32_768),
  maxActiveRequests: Schema.number().default(16),
  dedupTtlSeconds: Schema.number().default(604_800),
})

const TOPIC_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const WORKSPACE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_TIMER_MILLIS = 2_147_483_647

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`dsh-mqtt: ${name} must be a positive integer no greater than ${max}`)
  }
  return value
}

function nonNegativeInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`dsh-mqtt: ${name} must be a non-negative integer no greater than ${max}`)
  }
  return value
}

function topicSegment(value: string, name: string): string {
  if (!TOPIC_SEGMENT.test(value)) {
    throw new Error(`dsh-mqtt: ${name} must match ${TOPIC_SEGMENT.source}`)
  }
  return value
}

function optionalSecret(
  direct: string | undefined,
  envName: string | undefined,
  field: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (direct !== undefined && envName !== undefined) {
    throw new Error(`dsh-mqtt: configure only one of ${field} or ${field}Env`)
  }
  if (envName === undefined) return direct
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`dsh-mqtt: ${field}Env is not a valid environment variable name`)
  }
  const value = env[envName]
  if (value === undefined) throw new Error(`dsh-mqtt: environment variable ${envName} is not set`)
  return value
}

function resolveWorkspaces(input: Record<string, string>): Readonly<Record<string, string>> {
  const output = Object.create(null) as Record<string, string>
  for (const [alias, path] of Object.entries(input)) {
    if (!WORKSPACE_ALIAS.test(alias)) {
      throw new Error(`dsh-mqtt: workspace alias ${JSON.stringify(alias)} is invalid`)
    }
    if (path.length === 0) throw new Error(`dsh-mqtt: workspace ${JSON.stringify(alias)} has an empty path`)
    output[alias] = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path)
  }
  return Object.freeze(output)
}

export function resolveConfig(config: Config, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(config.url)
  } catch {
    throw new Error(`dsh-mqtt: url is not a valid URL: ${JSON.stringify(config.url)}`)
  }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(parsedUrl.protocol)) {
    throw new Error(`dsh-mqtt: url protocol must be mqtt, mqtts, ws, or wss`)
  }

  const namespace = topicSegment(config.namespace, 'namespace')
  const nodeId = topicSegment(config.nodeId, 'nodeId')
  const clientId = config.clientId ?? `dsh-mqtt-${namespace}-${nodeId}`
  if (clientId.length === 0 || clientId.length > 128 || clientId.includes(String.fromCharCode(0))) {
    throw new Error('dsh-mqtt: clientId must contain 1 to 128 non-NUL characters')
  }

  const protocolVersion = config.protocolVersion ?? 5
  if (protocolVersion !== 4 && protocolVersion !== 5) {
    throw new Error('dsh-mqtt: protocolVersion must be 4 (MQTT 3.1.1) or 5')
  }
  const clean = config.clean ?? false
  const keepaliveSeconds = positiveInteger(config.keepaliveSeconds ?? 30, 'keepaliveSeconds', 65_535)
  const connectTimeoutMs = positiveInteger(config.connectTimeoutMs ?? 10_000, 'connectTimeoutMs', MAX_TIMER_MILLIS)
  const reconnectPeriodMs = nonNegativeInteger(config.reconnectPeriodMs ?? 1_000, 'reconnectPeriodMs', MAX_TIMER_MILLIS)
  const sessionExpirySeconds = nonNegativeInteger(config.sessionExpirySeconds ?? 86_400, 'sessionExpirySeconds', 0xffff_ffff)
  if (!clean && clientId.length === 0) throw new Error('dsh-mqtt: a stable clientId is required when clean is false')

  const workspaces = resolveWorkspaces(config.workspaces ?? {})
  if (config.defaultWorkspace !== undefined && workspaces[config.defaultWorkspace] === undefined) {
    throw new Error(`dsh-mqtt: defaultWorkspace ${JSON.stringify(config.defaultWorkspace)} is not configured in workspaces`)
  }

  const maxTokens = config.maxTokens
  if (maxTokens !== undefined) positiveInteger(maxTokens, 'maxTokens')
  const capabilities = [...new Set(config.capabilities ?? [])].map(value => topicSegment(value, 'capability'))
  const username = optionalSecret(config.username, config.usernameEnv, 'username', env)
  const password = optionalSecret(config.password, config.passwordEnv, 'password', env)

  const maxMessageBytes = positiveInteger(config.maxMessageBytes ?? 65_536, 'maxMessageBytes')
  const maxMetadataBytes = positiveInteger(config.maxMetadataBytes ?? 8_192, 'maxMetadataBytes')
  if (maxMetadataBytes > maxMessageBytes) {
    throw new Error('dsh-mqtt: maxMetadataBytes must not exceed maxMessageBytes')
  }
  const dedupTtlSeconds = positiveInteger(config.dedupTtlSeconds ?? 604_800, 'dedupTtlSeconds', Math.floor(MAX_TIMER_MILLIS / 1_000))

  return {
    url: parsedUrl.toString(),
    namespace,
    nodeId,
    clientId,
    protocolVersion,
    clean,
    keepaliveSeconds,
    connectTimeoutMs,
    reconnectPeriodMs,
    sessionExpirySeconds,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    ...config.caFile === undefined ? {} : { caFile: resolve(config.caFile) },
    ...config.certFile === undefined ? {} : { certFile: resolve(config.certFile) },
    ...config.keyFile === undefined ? {} : { keyFile: resolve(config.keyFile) },
    rejectUnauthorized: config.rejectUnauthorized ?? true,
    stateFile: resolve(config.stateFile ?? '.dsh-mqtt/state.json'),
    workspaces,
    ...config.defaultWorkspace === undefined ? {} : { defaultWorkspace: config.defaultWorkspace },
    allowExternalSessions: config.allowExternalSessions ?? false,
    agentOptions: {
      ...config.provider === undefined ? {} : { provider: config.provider },
      ...config.model === undefined ? {} : { model: config.model },
      ...maxTokens === undefined ? {} : { maxTokens },
    },
    capabilities,
    eventExposure: config.eventExposure ?? 'safe',
    limits: {
      maxMessageBytes,
      maxMetadataBytes,
      maxInputChars: positiveInteger(config.maxInputChars ?? 32_768, 'maxInputChars'),
      maxActiveRequests: positiveInteger(config.maxActiveRequests ?? 16, 'maxActiveRequests'),
      dedupTtlMs: dedupTtlSeconds * 1_000,
    },
  }
}
