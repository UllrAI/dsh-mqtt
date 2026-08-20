import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export type EventExposure = 'safe' | 'full'

export interface Config {
  url: string
  namespace: string
  nodeId: string
  displayName?: string
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
  heartbeatSeconds?: number
  managementPort?: number
  managementHost?: string
  managementCorsOrigin?: string
  managementToken?: string
  managementTokenEnv?: string
  requireControllerAuth?: boolean
}

export interface ResolvedConfig {
  url: string
  namespace: string
  nodeId: string
  displayName: string
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
  heartbeatSeconds: number
  managementPort: number
  managementHost: string
  managementCorsOrigin?: string
  managementToken?: string
  requireControllerAuth: boolean
}

/**
 * Plugin configuration schema.
 *
 * Grouped with `Schema.intersect` rather than nested objects: the DSH settings
 * form renders one titled section per member while the resolved value stays
 * flat, so grouping costs no migration.
 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    url: Schema.string().default('mqtt://127.0.0.1:1883')
      .description('Broker URL. Accepts mqtt, mqtts, ws, or wss.'),
    protocolVersion: Schema.union([Schema.const(4), Schema.const(5)]).default(5)
      .description('MQTT protocol level: 5, or 4 for MQTT 3.1.1 brokers.'),
    clientId: Schema.string()
      .description('Client identifier sent on connect. Defaults to dsh-mqtt-<namespace>-<nodeId>.'),
    clean: Schema.boolean().default(false)
      .description('Start a clean session, discarding any state the broker held for this client id.'),
    keepaliveSeconds: Schema.number().default(30)
      .description('Interval between keepalive pings.'),
    connectTimeoutMs: Schema.number().default(10_000)
      .description('How long to wait for CONNACK before giving up on an attempt.'),
    reconnectPeriodMs: Schema.number().default(1_000)
      .description('Delay between reconnect attempts. Set to 0 to disable reconnecting.'),
    sessionExpirySeconds: Schema.number().default(86_400)
      .description('How long the broker keeps this session after a disconnect (MQTT 5 only).'),
    username: Schema.string()
      .description('Broker username. Use usernameEnv instead to read it from the environment.'),
    password: Schema.string().role('secret')
      .description('Broker password. Use passwordEnv instead to read it from the environment.'),
    usernameEnv: Schema.string()
      .description('Environment variable holding the broker username.'),
    passwordEnv: Schema.string()
      .description('Environment variable holding the broker password.'),
  }).description('Broker connection'),

  Schema.object({
    caFile: Schema.string()
      .description('Path to a CA certificate for brokers using a private authority. Requires an mqtts or wss URL.'),
    certFile: Schema.string()
      .description('Client certificate for mutual TLS. Must be set together with keyFile.'),
    keyFile: Schema.string()
      .description('Private key for the client certificate. Must be set together with certFile.'),
    rejectUnauthorized: Schema.boolean().default(true)
      .description('Verify the broker certificate. Turning this off exposes the connection to interception.'),
  }).description('TLS'),

  Schema.object({
    namespace: Schema.string().default('local')
      .description('Topic namespace shared by every node in one deployment.'),
    nodeId: Schema.string().default('dsh-node')
      .description('Identifier for this node within the namespace. Must be unique.'),
    displayName: Schema.string()
      .description('Human-readable name shown to controllers. Defaults to the node id.'),
    capabilities: Schema.array(Schema.string()).default([])
      .description('Tags controllers can match on when choosing a node, such as gpu or macos.'),
  }).description('Node identity'),

  Schema.object({
    workspaces: Schema.dict(Schema.string()).default({})
      .description('Named directories requests may run in, as alias to path. Relative paths resolve against the DSH working directory.'),
    defaultWorkspace: Schema.string()
      .description('Workspace used when a request does not name one. Must be a configured alias.'),
    allowExternalSessions: Schema.boolean().default(false)
      .description('Allow requests to attach to sessions this gateway did not create.'),
    provider: Schema.string()
      .description('Model provider override. Must be set together with model; otherwise the DSH default applies.'),
    model: Schema.string()
      .description('Model override. Must be set together with provider.'),
    maxTokens: Schema.number()
      .description('Cap on output tokens per turn. Leave unset to use the model default.'),
    eventExposure: Schema.union(['safe', 'full']).default('safe')
      .description('How much of each session event to forward. "safe" omits payloads that may contain file contents or command output.'),
    stateFile: Schema.string().default('.dsh-mqtt/state.json')
      .description('Where request and controller state is persisted across restarts.'),
  }).description('Agents and workspaces'),

  Schema.object({
    maxMessageBytes: Schema.number().default(65_536)
      .description('Largest accepted inbound message. Anything bigger is rejected unread.'),
    maxMetadataBytes: Schema.number().default(8_192)
      .description('Cap on the metadata object carried by a request. Must not exceed maxMessageBytes.'),
    maxInputChars: Schema.number().default(32_768)
      .description('Cap on the prompt text of a single request or control command.'),
    maxActiveRequests: Schema.number().default(16)
      .description('How many requests may run at once. Further requests are rejected as retryable.'),
    dedupTtlSeconds: Schema.number().default(604_800)
      .description('How long completed request ids are remembered, so a redelivery returns the original result instead of running twice.'),
    heartbeatSeconds: Schema.number().default(15)
      .description('Interval between retained node status publishes. Controllers treat a node as stale after two missed beats.'),
  }).description('Limits'),

  Schema.object({
    managementPort: Schema.number().default(3210)
      .description('Port for the management API and standalone UI. Set to 0 to disable both; the DSH settings panel uses this API too.'),
    managementHost: Schema.string().default('127.0.0.1')
      .description('Address the management server binds to. Anything other than loopback requires managementToken.'),
    managementCorsOrigin: Schema.string()
      .description('Exact origin allowed to call the management API. Leave unset to allow local origins only, which is what the DSH settings panel needs.'),
    managementToken: Schema.string().role('secret')
      .description('Bearer token required by the management API. Use managementTokenEnv instead to read it from the environment.'),
    managementTokenEnv: Schema.string()
      .description('Environment variable holding the management token.'),
    requireControllerAuth: Schema.boolean().default(false)
      .description('Require controllers to be invited and approved before they may submit or steer.'),
  }).description('Management interface'),
]) as Schema<Config>

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
  const caFile = config.caFile === undefined ? undefined : resolve(config.caFile)
  const certFile = config.certFile === undefined ? undefined : resolve(config.certFile)
  const keyFile = config.keyFile === undefined ? undefined : resolve(config.keyFile)
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error('dsh-mqtt: certFile and keyFile must be configured together')
  }
  if ((caFile !== undefined || certFile !== undefined) && !['mqtts:', 'wss:'].includes(parsedUrl.protocol)) {
    throw new Error('dsh-mqtt: TLS certificate files require an mqtts or wss URL')
  }

  const namespace = topicSegment(config.namespace, 'namespace')
  const nodeId = topicSegment(config.nodeId, 'nodeId')
  const displayName = config.displayName ?? nodeId
  if (displayName.length === 0 || displayName.length > 128) {
    throw new Error('dsh-mqtt: displayName must contain 1 to 128 characters')
  }
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
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('dsh-mqtt: provider and model must be configured together')
  }
  const capabilities = [...new Set(config.capabilities ?? [])].map(value => topicSegment(value, 'capability'))
  const username = optionalSecret(config.username, config.usernameEnv, 'username', env)
  const password = optionalSecret(config.password, config.passwordEnv, 'password', env)

  const maxMessageBytes = positiveInteger(config.maxMessageBytes ?? 65_536, 'maxMessageBytes')
  const maxMetadataBytes = positiveInteger(config.maxMetadataBytes ?? 8_192, 'maxMetadataBytes')
  if (maxMetadataBytes > maxMessageBytes) {
    throw new Error('dsh-mqtt: maxMetadataBytes must not exceed maxMessageBytes')
  }
  const dedupTtlSeconds = positiveInteger(config.dedupTtlSeconds ?? 604_800, 'dedupTtlSeconds', Math.floor(MAX_TIMER_MILLIS / 1_000))
  const heartbeatSeconds = positiveInteger(config.heartbeatSeconds ?? 15, 'heartbeatSeconds', Math.floor(MAX_TIMER_MILLIS / 1_000))
  const managementPort = nonNegativeInteger(config.managementPort ?? 3210, 'managementPort', 65_535)
  const managementHost = config.managementHost ?? '127.0.0.1'
  if (managementHost.length === 0 || managementHost.length > 253) {
    throw new Error('dsh-mqtt: managementHost must contain 1 to 253 characters')
  }
  const managementCorsOrigin = config.managementCorsOrigin
  if (managementCorsOrigin !== undefined && managementCorsOrigin.length === 0) {
    throw new Error('dsh-mqtt: managementCorsOrigin must not be empty')
  }
  const managementToken = optionalSecret(config.managementToken, config.managementTokenEnv, 'managementToken', env)
  if (managementPort > 0 && !['127.0.0.1', 'localhost', '::1'].includes(managementHost) && managementToken === undefined) {
    throw new Error('dsh-mqtt: managementToken is required when managementHost is not loopback')
  }

  return {
    url: parsedUrl.toString(),
    namespace,
    nodeId,
    displayName,
    clientId,
    protocolVersion,
    clean,
    keepaliveSeconds,
    connectTimeoutMs,
    reconnectPeriodMs,
    sessionExpirySeconds,
    ...username === undefined ? {} : { username },
    ...password === undefined ? {} : { password },
    ...caFile === undefined ? {} : { caFile },
    ...certFile === undefined ? {} : { certFile },
    ...keyFile === undefined ? {} : { keyFile },
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
    heartbeatSeconds,
    managementPort,
    managementHost,
    ...managementCorsOrigin === undefined ? {} : { managementCorsOrigin },
    ...managementToken === undefined ? {} : { managementToken },
    requireControllerAuth: config.requireControllerAuth ?? false,
  }
}
