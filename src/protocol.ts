import { createHash } from 'node:crypto'
import { isRequestId } from './topics.ts'

export const PROTOCOL_VERSION = 1 as const
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/

export type RequestStatus = 'completed' | 'failed' | 'cancelled'
export type ControlType = 'request.steer' | 'request.inject' | 'request.cancel'

export interface SubmitRequest {
  version: 1
  id: string
  type: 'request.submit'
  timestamp: string
  input: string
  workspace?: string
  session_id?: string
  metadata?: Record<string, unknown>
  controller_id?: string
  token?: string
}

export interface ControlRequest {
  version: 1
  id: string
  command_id: string
  type: ControlType
  timestamp: string
  input?: string
  reason?: string
  controller_id?: string
  token?: string
}

export interface GatewayEvent {
  version: 1
  id: string
  type: string
  timestamp: string
  sequence?: number
  data?: unknown
}

export interface GatewayError {
  code: string
  message: string
  retryable: boolean
}

export interface GatewayResult {
  version: 1
  id: string
  type: 'request.result'
  timestamp: string
  status: RequestStatus
  session_id?: string
  summary?: string
  error: GatewayError | null
}

export interface ProtocolLimits {
  maxMessageBytes: number
  maxMetadataBytes: number
  maxInputChars: number
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

export function isRfc3339DateTime(value: string): boolean {
  const match = RFC3339_DATE_TIME.exec(value)
  if (match === null) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number
  return day >= 1 && day <= daysInMonth
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  options: { optional?: boolean; max?: number; requestId?: string } = {},
): string | undefined {
  const field = value[key]
  if (field === undefined && options.optional) return undefined
  if (typeof field !== 'string') {
    throw new ProtocolError('INVALID_MESSAGE', `${key} must be a string`, options.requestId)
  }
  if (field.length === 0) throw new ProtocolError('INVALID_MESSAGE', `${key} must not be empty`, options.requestId)
  if (options.max !== undefined && field.length > options.max) {
    throw new ProtocolError('MESSAGE_TOO_LARGE', `${key} exceeds ${options.max} characters`, options.requestId)
  }
  return field
}

function parseEnvelope(payload: Uint8Array, limits: ProtocolLimits): Record<string, unknown> {
  if (payload.byteLength > limits.maxMessageBytes) {
    throw new ProtocolError('MESSAGE_TOO_LARGE', `message exceeds ${limits.maxMessageBytes} bytes`)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(payload).toString('utf8')) as unknown
  } catch {
    throw new ProtocolError('INVALID_JSON', 'message must be valid UTF-8 JSON')
  }
  if (!plainObject(value)) throw new ProtocolError('INVALID_MESSAGE', 'message must be a JSON object')
  const candidateId = typeof value.id === 'string' && isRequestId(value.id) ? value.id : undefined
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_VERSION', `version must be ${PROTOCOL_VERSION}`, candidateId)
  }
  const id = stringField(value, 'id', candidateId === undefined ? {} : { requestId: candidateId })
  if (id === undefined || !isRequestId(id)) {
    throw new ProtocolError('INVALID_REQUEST_ID', 'id must be 1 to 128 topic-safe characters', candidateId)
  }
  const timestamp = stringField(value, 'timestamp', { requestId: id })
  if (timestamp === undefined || !isRfc3339DateTime(timestamp)) {
    throw new ProtocolError('INVALID_TIMESTAMP', 'timestamp must be an RFC 3339 date-time', id)
  }
  return value
}

export function parseSubmit(payload: Uint8Array, limits: ProtocolLimits): SubmitRequest {
  const value = parseEnvelope(payload, limits)
  const id = value.id as string
  if (value.type !== 'request.submit') {
    throw new ProtocolError('INVALID_MESSAGE_TYPE', 'requests topic accepts only request.submit', id)
  }
  const input = stringField(value, 'input', { max: limits.maxInputChars, requestId: id }) as string
  const workspace = stringField(value, 'workspace', { optional: true, max: 128, requestId: id })
  const sessionId = stringField(value, 'session_id', { optional: true, max: 256, requestId: id })
  if (sessionId !== undefined && !isRequestId(sessionId)) {
    throw new ProtocolError('INVALID_SESSION_ID', 'session_id must be topic-safe and no longer than 128 characters', id)
  }
  const controllerId = stringField(value, 'controller_id', { optional: true, max: 128, requestId: id })
  const token = stringField(value, 'token', { optional: true, max: 256, requestId: id })

  let metadata: Record<string, unknown> | undefined
  if (value.metadata !== undefined) {
    if (!plainObject(value.metadata)) {
      throw new ProtocolError('INVALID_MESSAGE', 'metadata must be a JSON object', id)
    }
    if (Buffer.byteLength(JSON.stringify(value.metadata)) > limits.maxMetadataBytes) {
      throw new ProtocolError('METADATA_TOO_LARGE', `metadata exceeds ${limits.maxMetadataBytes} bytes`, id)
    }
    metadata = structuredClone(value.metadata)
  }

  return {
    version: PROTOCOL_VERSION,
    id,
    type: 'request.submit',
    timestamp: value.timestamp as string,
    input,
    ...workspace === undefined ? {} : { workspace },
    ...sessionId === undefined ? {} : { session_id: sessionId },
    ...metadata === undefined ? {} : { metadata },
    ...controllerId === undefined ? {} : { controller_id: controllerId },
    ...token === undefined ? {} : { token },
  }
}

export function parseControl(
  payload: Uint8Array,
  topicRequestId: string,
  limits: ProtocolLimits,
): ControlRequest {
  const value = parseEnvelope(payload, limits)
  const id = value.id as string
  if (id !== topicRequestId) {
    throw new ProtocolError('REQUEST_ID_MISMATCH', 'message id does not match the control topic', id)
  }
  const type = value.type
  if (type !== 'request.steer' && type !== 'request.inject' && type !== 'request.cancel') {
    throw new ProtocolError('INVALID_MESSAGE_TYPE', 'control topic accepts steer, inject, or cancel', id)
  }
  const commandId = stringField(value, 'command_id', { max: 128, requestId: id }) as string
  if (!isRequestId(commandId)) {
    throw new ProtocolError('INVALID_COMMAND_ID', 'command_id must be 1 to 128 topic-safe characters', id)
  }
  const input = stringField(value, 'input', {
    optional: type === 'request.cancel',
    max: limits.maxInputChars,
    requestId: id,
  })
  const reason = stringField(value, 'reason', { optional: true, max: 512, requestId: id })
  const controllerId = stringField(value, 'controller_id', { optional: true, max: 128, requestId: id })
  const token = stringField(value, 'token', { optional: true, max: 256, requestId: id })

  return {
    version: PROTOCOL_VERSION,
    id,
    command_id: commandId,
    type,
    timestamp: value.timestamp as string,
    ...input === undefined ? {} : { input },
    ...reason === undefined ? {} : { reason },
    ...controllerId === undefined ? {} : { controller_id: controllerId },
    ...token === undefined ? {} : { token },
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!plainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

export function fingerprint(value: SubmitRequest | ControlRequest): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

export function protocolEvent(
  id: string,
  type: string,
  data?: unknown,
  sequence?: number,
  now = new Date(),
): GatewayEvent {
  return {
    version: PROTOCOL_VERSION,
    id,
    type,
    timestamp: now.toISOString(),
    ...sequence === undefined ? {} : { sequence },
    ...data === undefined ? {} : { data },
  }
}

export function protocolResult(
  id: string,
  status: RequestStatus,
  options: {
    sessionId?: string
    summary?: string
    error?: GatewayError | null
    now?: Date
  } = {},
): GatewayResult {
  return {
    version: PROTOCOL_VERSION,
    id,
    type: 'request.result',
    timestamp: (options.now ?? new Date()).toISOString(),
    status,
    ...options.sessionId === undefined ? {} : { session_id: options.sessionId },
    ...options.summary === undefined ? {} : { summary: options.summary },
    error: options.error ?? null,
  }
}

export function protocolErrorResult(
  error: ProtocolError,
  requestId = error.requestId ?? 'unknown',
): GatewayResult {
  return protocolResult(requestId, 'failed', {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  })
}
