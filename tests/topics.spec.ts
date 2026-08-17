import { describe, expect, it } from 'vitest'
import { TopicLayout, isRequestId } from '../src/topics.ts'

describe('TopicLayout', () => {
  const topics = new TopicLayout('ullrai', 'mac-mini')

  it('builds the five node-scoped protocol topics', () => {
    expect(topics.requests).toBe('dsh/v1/ullrai/nodes/mac-mini/requests')
    expect(topics.controlFilter).toBe('dsh/v1/ullrai/nodes/mac-mini/requests/+/control')
    expect(topics.control('req:1')).toBe('dsh/v1/ullrai/nodes/mac-mini/requests/req:1/control')
    expect(topics.events('req:1')).toBe('dsh/v1/ullrai/nodes/mac-mini/requests/req:1/events')
    expect(topics.result('req:1')).toBe('dsh/v1/ullrai/nodes/mac-mini/requests/req:1/result')
  })

  it('extracts only exact, valid control request ids', () => {
    expect(topics.requestIdFromControl(topics.control('req-1'))).toBe('req-1')
    expect(topics.requestIdFromControl(`${topics.base}/requests/a/b/control`)).toBeUndefined()
    expect(topics.requestIdFromControl(`${topics.base}/requests/+/control`)).toBeUndefined()
    expect(topics.requestIdFromControl(`${topics.base}/requests/req-1/events`)).toBeUndefined()
  })

  it('validates request identifiers before constructing a topic', () => {
    expect(isRequestId('01JABC.test:1')).toBe(true)
    expect(isRequestId('bad/id')).toBe(false)
    expect(() => topics.result('bad/#')).toThrow(/invalid request id/)
  })
})
