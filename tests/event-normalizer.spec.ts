import { describe, expect, it } from 'vitest'
import { errorMessage, normalizeSessionEvent } from '../src/event-normalizer.ts'

describe('normalizeSessionEvent', () => {
  it('exposes visible assistant text while keeping reasoning and tool arguments private', () => {
    expect(normalizeSessionEvent({
      seq: 3,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } },
    }, 'safe')).toEqual({
      type: 'agent.output.delta',
      sequence: 3,
      data: { text: 'Hello', turn: 1, step: 1 },
    })

    expect(normalizeSessionEvent({
      seq: 4,
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'secret thought' } },
    }, 'safe')).toBeUndefined()

    expect(normalizeSessionEvent({
      seq: 5,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"cmd":"cat secret"}' },
    }, 'safe')).toEqual({
      type: 'session.tool/call',
      sequence: 5,
      data: { callId: 'call-1', name: 'bash', turn: 1, step: 1 },
    })
  })

  it('extracts the last visible assistant message for the final summary', () => {
    const normalized = normalizeSessionEvent({
      seq: 8,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [
            { type: 'reasoning', text: 'hidden' },
            { type: 'text', text: 'Tests ' },
            { type: 'text', text: 'passed.' },
          ],
        },
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    }, 'safe')
    expect(normalized).toMatchObject({
      type: 'session.assistant/message',
      summaryText: 'Tests passed.',
      data: { text: 'Tests passed.', turn: 1, step: 2 },
    })
  })

  it('preserves turn outcomes and redacts unknown safe-mode payloads', () => {
    expect(normalizeSessionEvent({
      seq: 9,
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    }, 'safe')).toMatchObject({ turnEndReason: { kind: 'completed' } })

    expect(normalizeSessionEvent({
      seq: 10,
      type: 'plugin/private',
      data: { token: 'do-not-export' },
    }, 'safe')).toEqual({
      type: 'session.plugin/private',
      sequence: 10,
      data: { redacted: true },
    })
  })

  it('allows explicit full event exposure', () => {
    const event = { seq: 2, type: 'custom/event', data: { exact: ['payload'] } }
    expect(normalizeSessionEvent(event, 'full')).toEqual({
      type: 'session.custom/event',
      sequence: 2,
      data: { exact: ['payload'] },
    })

    expect(normalizeSessionEvent({
      seq: 3,
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'full summary' }] } },
    }, 'full')).toMatchObject({ summaryText: 'full summary' })
  })

  it('summarizes safe tool failures without exporting result content', () => {
    expect(normalizeSessionEvent({
      seq: 11,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'secret' }] }],
        },
        error: { name: 'ToolError', code: 'FAILED' },
        meta: { secret: true },
      },
    }, 'safe')).toEqual({
      type: 'session.tool/result',
      sequence: 11,
      data: {
        callId: 'call-1',
        isError: true,
        error: { name: 'ToolError', code: 'FAILED' },
        turn: 1,
        step: 1,
      },
    })
    expect(normalizeSessionEvent(null, 'safe')).toBeUndefined()
    expect(normalizeSessionEvent({ type: 42 }, 'safe')).toBeUndefined()
  })

  it('renders unknown operational errors without throwing', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage({ code: 'FAIL' })).toBe('{"code":"FAIL"}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(errorMessage(cyclic)).toBe('[object Object]')
  })
})
