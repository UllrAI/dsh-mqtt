import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  parseControl,
  parseSubmit,
  protocolEvent,
  protocolResult,
  ProtocolError,
} from '../src/protocol.ts'

const limits = {
  maxMessageBytes: 4_096,
  maxMetadataBytes: 256,
  maxInputChars: 100,
}

function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

function submit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'req-1',
    type: 'request.submit',
    timestamp: '2026-08-17T12:00:00Z',
    input: 'Run the tests.',
    workspace: 'app',
    ...overrides,
  }
}

describe('protocol parsing', () => {
  it('parses a valid submit request and detaches metadata', () => {
    const metadata = { source: 'ci', nested: { pr: 42 } }
    const request = parseSubmit(bytes(submit({ metadata })), limits)
    metadata.nested.pr = 99

    expect(request).toEqual({
      version: 1,
      id: 'req-1',
      type: 'request.submit',
      timestamp: '2026-08-17T12:00:00Z',
      input: 'Run the tests.',
      workspace: 'app',
      metadata: { source: 'ci', nested: { pr: 42 } },
    })
  })

  it('creates stable fingerprints independent of object key order', () => {
    const left = parseSubmit(bytes(submit({ metadata: { z: 1, a: { y: 2, x: 3 } } })), limits)
    const right = parseSubmit(bytes(submit({ metadata: { a: { x: 3, y: 2 }, z: 1 } })), limits)
    expect(fingerprint(left)).toBe(fingerprint(right))
  })

  it('parses all control operations and enforces topic correlation', () => {
    const steer = parseControl(bytes({
      version: 1,
      id: 'req-1',
      command_id: 'cmd-1',
      type: 'request.steer',
      timestamp: '2026-08-17T12:01:00Z',
      input: 'Focus on integration tests.',
    }), 'req-1', limits)
    expect(steer.type).toBe('request.steer')

    const cancel = parseControl(bytes({
      version: 1,
      id: 'req-1',
      command_id: 'cmd-2',
      type: 'request.cancel',
      timestamp: '2026-08-17T12:02:00Z',
      reason: 'user_cancelled',
    }), 'req-1', limits)
    expect(cancel.input).toBeUndefined()

    expect(() => parseControl(bytes({ ...steer, id: 'req-2' }), 'req-1', limits))
      .toThrowError(expect.objectContaining({ code: 'REQUEST_ID_MISMATCH' }))
  })

  it.each([
    [Buffer.from('{'), 'INVALID_JSON'],
    [bytes(submit({ version: 2 })), 'UNSUPPORTED_VERSION'],
    [bytes(submit({ id: 'bad/#' })), 'INVALID_REQUEST_ID'],
    [bytes(submit({ input: '' })), 'INVALID_MESSAGE'],
    [bytes(submit({ input: 'x'.repeat(101) })), 'MESSAGE_TOO_LARGE'],
    [bytes(submit({ metadata: { data: 'x'.repeat(300) } })), 'METADATA_TOO_LARGE'],
  ])('rejects malformed submit input with %s', (payload, code) => {
    try {
      parseSubmit(payload, limits)
      expect.unreachable('expected parseSubmit to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(code)
    }
  })
})

describe('protocol output', () => {
  it('builds correlated event and terminal result envelopes', () => {
    const now = new Date('2026-08-17T12:00:00Z')
    expect(protocolEvent('req-1', 'agent.status', { status: 'running' }, 3, now)).toEqual({
      version: 1,
      id: 'req-1',
      type: 'agent.status',
      timestamp: '2026-08-17T12:00:00.000Z',
      sequence: 3,
      data: { status: 'running' },
    })
    expect(protocolResult('req-1', 'completed', { sessionId: 'session-1', summary: 'Done', now })).toEqual({
      version: 1,
      id: 'req-1',
      type: 'request.result',
      timestamp: '2026-08-17T12:00:00.000Z',
      status: 'completed',
      session_id: 'session-1',
      summary: 'Done',
      error: null,
    })
  })
})
