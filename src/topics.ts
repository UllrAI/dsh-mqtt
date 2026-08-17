const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function isRequestId(value: string): boolean {
  return REQUEST_ID.test(value)
}

export class TopicLayout {
  readonly base: string
  readonly requests: string
  readonly controlFilter: string
  readonly status: string

  constructor(namespace: string, nodeId: string) {
    this.base = `dsh/v1/${namespace}/nodes/${nodeId}`
    this.requests = `${this.base}/requests`
    this.controlFilter = `${this.base}/requests/+/control`
    this.status = `${this.base}/status`
  }

  control(requestId: string): string {
    this.assertRequestId(requestId)
    return `${this.base}/requests/${requestId}/control`
  }

  events(requestId: string): string {
    this.assertRequestId(requestId)
    return `${this.base}/requests/${requestId}/events`
  }

  result(requestId: string): string {
    this.assertRequestId(requestId)
    return `${this.base}/requests/${requestId}/result`
  }

  requestIdFromControl(topic: string): string | undefined {
    const prefix = `${this.base}/requests/`
    if (!topic.startsWith(prefix) || !topic.endsWith('/control')) return undefined
    const requestId = topic.slice(prefix.length, -'/control'.length)
    if (requestId.includes('/') || !isRequestId(requestId)) return undefined
    return requestId
  }

  private assertRequestId(requestId: string): void {
    if (!isRequestId(requestId)) throw new Error(`invalid request id: ${JSON.stringify(requestId)}`)
  }
}
