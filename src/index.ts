/**
 * MQTT protocol driver and agent worker gateway for DeepSeek Harness.
 *
 * The module intentionally exports named plugin fields only. Cordis Loader
 * preserves `name`, `inject`, `Config`, and `apply` when no default export is
 * present.
 *
 * @module dsh-mqtt
 */

import type { Context } from '@deepseek-ai/cordis'
import { DshAgentHost } from './agent-host.ts'
import { Config, resolveConfig, type Config as PluginConfig } from './config.ts'
import { MqttAgentGateway, offlineStatus } from './gateway.ts'
import { MqttTransport } from './mqtt-transport.ts'
import { ManagementServer } from './management-server.ts'
import { RequestStore } from './state-store.ts'
import { TopicLayout } from './topics.ts'
import type { Logger } from './transport.ts'

export { Config }
export type { Config as PluginConfig, ResolvedConfig } from './config.ts'
export { MqttAgentGateway } from './gateway.ts'
export { RequestStore } from './state-store.ts'
export { TopicLayout } from './topics.ts'
export { ManagementServer } from './management-server.ts'
export { MqttControllerClient } from './controller.ts'
export type { ControllerInviteConfig, SubmitOptions } from './controller.ts'

export const name = 'dsh-mqtt'
export const inject = ['agentDefaultModel', 'agents']

function loggerFor(ctx: Context): Logger {
  return {
    debug: (message, ...args) => ctx.logger.debug(message, ...args),
    info: (message, ...args) => ctx.logger.info(message, ...args),
    warn: (message, ...args) => ctx.logger.warn(message, ...args),
    error: (message, ...args) => ctx.logger.error(message, ...args),
  }
}

export async function apply(ctx: Context, input: PluginConfig): Promise<void> {
  const config = resolveConfig(input)
  const logger = loggerFor(ctx)
  const topics = new TopicLayout(config.namespace, config.nodeId)
  const store = new RequestStore(config.stateFile, config.limits.dedupTtlMs)
  const host = new DshAgentHost(ctx, config)
  const transport = new MqttTransport({
    config,
    topics,
    offlineStatus: offlineStatus(config),
    logger,
  })
  const gateway = new MqttAgentGateway(config, transport, host, store, logger)
  const management = new ManagementServer({ gateway, config, logger })

  await ctx.effect(async () => {
    await gateway.start()
    try {
      await management.start()
    } catch (error) {
      await gateway.stop().catch(stopError => logger.warn('dsh-mqtt: failed to stop gateway after management startup failed', stopError))
      throw error
    }
    return async () => {
      await management.stop()
      await gateway.stop()
    }
  }, 'dsh-mqtt.gateway')
}
