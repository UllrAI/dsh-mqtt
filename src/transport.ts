export interface IncomingMessage {
  topic: string
  payload: Uint8Array
  qos: 0 | 1 | 2
  retain: boolean
}

export interface PublishOptions {
  qos: 0 | 1
  retain?: boolean
}

export interface TransportHandlers {
  onMessage(message: IncomingMessage): void | Promise<void>
  onConnect(): void | Promise<void>
  onState?(state: TransportState): void | Promise<void>
}

export type TransportState = 'connecting' | 'connected' | 'degraded' | 'offline' | 'stopped'

export interface GatewayTransport {
  start(handlers: TransportHandlers): Promise<void>
  publish(topic: string, payload: string, options: PublishOptions): Promise<void>
  stop(): Promise<void>
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
