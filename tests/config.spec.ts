import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('resolves safe defaults, workspace paths, and environment credentials', () => {
    const config = resolveConfig({
      url: 'mqtts://broker.example.com:8883',
      namespace: 'team-a',
      nodeId: 'mac-mini',
      usernameEnv: 'MQTT_USER',
      passwordEnv: 'MQTT_PASSWORD',
      workspaces: { app: './fixtures/app' },
      defaultWorkspace: 'app',
      capabilities: ['coding', 'coding', 'browser'],
    }, {
      MQTT_USER: 'alice',
      MQTT_PASSWORD: 'secret',
    })

    expect(config.url).toBe('mqtts://broker.example.com:8883')
    expect(config.clientId).toBe('dsh-mqtt-team-a-mac-mini')
    expect(config.protocolVersion).toBe(5)
    expect(config.clean).toBe(false)
    expect(config.username).toBe('alice')
    expect(config.password).toBe('secret')
    expect(config.workspaces.app).toBe(resolve('fixtures/app'))
    expect(config.capabilities).toEqual(['coding', 'browser'])
    expect(config.limits.dedupTtlMs).toBe(604_800_000)
  })

  it.each([
    [{ url: 'https://broker.example.com', namespace: 'a', nodeId: 'b' }, /url protocol/],
    [{ url: 'mqtt://localhost', namespace: 'bad/#', nodeId: 'b' }, /namespace/],
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', maxMessageBytes: 10, maxMetadataBytes: 11 }, /maxMetadataBytes/],
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', workspaces: {}, defaultWorkspace: 'missing' }, /defaultWorkspace/],
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', reconnectPeriodMs: -1 }, /reconnectPeriodMs/],
  ])('rejects invalid configuration %#', (input, expected) => {
    expect(() => resolveConfig(input, {})).toThrow(expected)
  })

  it('rejects ambiguous or missing environment credentials', () => {
    expect(() => resolveConfig({
      url: 'mqtt://localhost',
      namespace: 'a',
      nodeId: 'b',
      username: 'direct',
      usernameEnv: 'MQTT_USER',
    }, { MQTT_USER: 'env' })).toThrow(/only one/)

    expect(() => resolveConfig({
      url: 'mqtt://localhost',
      namespace: 'a',
      nodeId: 'b',
      passwordEnv: 'MISSING',
    }, {})).toThrow(/MISSING is not set/)
  })
})
