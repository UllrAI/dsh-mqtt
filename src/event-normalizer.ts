import type { EventExposure } from './config.ts'

interface SessionEventLike {
  seq?: unknown
  type?: unknown
  data?: unknown
}

export interface NormalizedAgentEvent {
  type: string
  sequence?: number
  data?: unknown
  summaryText?: string
  turnEndReason?: unknown
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function visibleText(message: unknown): string | undefined {
  const content = object(message)?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(block => object(block))
    .filter((block): block is Record<string, unknown> => block !== undefined && block.type === 'text')
    .map(block => block.text)
    .filter((value): value is string => typeof value === 'string')
    .join('')
  return text.length === 0 ? undefined : text
}

function safeData(type: string, data: unknown): { data?: unknown; summaryText?: string; turnEndReason?: unknown } {
  const row = object(data)
  if (row === undefined) return {}
  switch (type) {
    case 'assistant/chunk': {
      const chunk = object(row.chunk)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        return { data: { text: chunk.text, turn: row.turn, step: row.step } }
      }
      return {}
    }
    case 'assistant/message': {
      const text = visibleText(row.message)
      return {
        data: {
          ...text === undefined ? {} : { text },
          ...row.usage === undefined ? {} : { usage: row.usage },
          turn: row.turn,
          step: row.step,
        },
        ...text === undefined ? {} : { summaryText: text },
      }
    }
    case 'tool/call':
      return { data: { callId: row.callId, name: row.name, turn: row.turn, step: row.step } }
    case 'tool/result': {
      const message = object(row.message)
      const block = Array.isArray(message?.content) ? object(message.content[0]) : undefined
      return {
        data: {
          callId: block?.toolCallId,
          isError: block?.isError === true || row.error !== undefined,
          ...row.error === undefined ? {} : { error: row.error },
          turn: row.turn,
          step: row.step,
        },
      }
    }
    case 'turn/end':
      return { data: row, turnEndReason: row.reason }
    case 'turn/start':
    case 'step/start':
    case 'step/end':
      return { data: row }
    default:
      return { data: { redacted: true } }
  }
}

export function normalizeSessionEvent(event: unknown, exposure: EventExposure): NormalizedAgentEvent | undefined {
  const row = object(event) as SessionEventLike | undefined
  if (row === undefined || typeof row.type !== 'string') return undefined
  const sequence = typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= 0 ? row.seq : undefined
  if (exposure === 'full') {
    const data = structuredClone(row.data)
    const eventData = object(row.data)
    const summaryText = row.type === 'assistant/message' ? visibleText(eventData?.message) : undefined
    return {
      type: `session.${row.type}`,
      ...sequence === undefined ? {} : { sequence },
      ...data === undefined ? {} : { data },
      ...summaryText === undefined ? {} : { summaryText },
      ...row.type === 'turn/end' ? { turnEndReason: eventData?.reason } : {},
    }
  }
  const normalized = safeData(row.type, row.data)
  if (normalized.data === undefined && normalized.summaryText === undefined && normalized.turnEndReason === undefined) {
    return undefined
  }
  return {
    type: row.type === 'assistant/chunk' ? 'agent.output.delta' : `session.${row.type}`,
    ...sequence === undefined ? {} : { sequence },
    ...normalized,
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
