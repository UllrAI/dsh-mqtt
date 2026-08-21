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
    expect(config.allowExternalSessions).toBe(false)
    expect(config.displayName).toBe('mac-mini')
    expect(config.managementPort).toBe(3210)
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
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', maxMessageBytes: 10, maxMetadataBytes: 10, maxInputChars: 11 }, /maxInputChars/],
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', workspaces: {}, defaultWorkspace: 'missing' }, /defaultWorkspace/],
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', reconnectPeriodMs: -1 }, /reconnectPeriodMs/],
    [{ url: 'mqtt://localhost', namespace: 'a', nodeId: 'b', managementPort: 3210, managementHost: '0.0.0.0' }, /managementToken/],
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

  it.each([
    [{ clientId: `bad${String.fromCharCode(0)}id` }, /clientId/],
    [{ keepaliveSeconds: 0 }, /keepaliveSeconds/],
    [{ sessionExpirySeconds: -1 }, /sessionExpirySeconds/],
    [{ maxTokens: 0 }, /maxTokens/],
    [{ provider: 'deepseek-official' }, /provider and model/],
    [{ model: 'deepseek-chat' }, /provider and model/],
    [{ capabilities: ['bad/#'] }, /capability/],
    [{ workspaces: { 'bad/#': '/tmp' } }, /workspace alias/],
    [{ workspaces: { app: '' } }, /empty path/],
  ])('rejects unsafe operational values %#', (overrides, expected) => {
    expect(() => resolveConfig({
      url: 'mqtt://localhost',
      namespace: 'safe',
      nodeId: 'node',
      ...overrides,
    }, {})).toThrow(expected)
  })

  it('accepts direct credentials and MQTT 3.1.1 configuration', () => {
    const config = resolveConfig({
      url: 'ws://localhost:8080/mqtt',
      namespace: 'safe',
      nodeId: 'node',
      protocolVersion: 4,
      clean: true,
      username: 'direct-user',
      password: 'direct-password',
      reconnectPeriodMs: 0,
      allowExternalSessions: true,
    }, {})
    expect(config).toMatchObject({
      protocolVersion: 4,
      clean: true,
      username: 'direct-user',
      password: 'direct-password',
      reconnectPeriodMs: 0,
      allowExternalSessions: true,
    })
  })

  it('resolves TLS trust and mutual-authentication files', () => {
    const config = resolveConfig({
      url: 'mqtts://broker.example.com:8883',
      namespace: 'safe',
      nodeId: 'node',
      caFile: './fixtures/ca.pem',
      certFile: './fixtures/client.pem',
      keyFile: './fixtures/client-key.pem',
    }, {})
    expect(config).toMatchObject({
      caFile: resolve('fixtures/ca.pem'),
      certFile: resolve('fixtures/client.pem'),
      keyFile: resolve('fixtures/client-key.pem'),
      rejectUnauthorized: true,
    })
  })

  it.each([
    [{ url: 'mqtts://localhost', certFile: './client.pem' }, /certFile and keyFile/],
    [{ url: 'mqtts://localhost', keyFile: './client-key.pem' }, /certFile and keyFile/],
    [{ url: 'mqtt://localhost', caFile: './ca.pem' }, /require an mqtts or wss URL/],
  ])('rejects incomplete or ineffective TLS configuration %#', (overrides, expected) => {
    expect(() => resolveConfig({
      namespace: 'safe',
      nodeId: 'node',
      ...overrides,
    }, {})).toThrow(expected)
  })

  it('handles prototype property names as ordinary workspace aliases', () => {
    const config = resolveConfig({
      url: 'mqtt://localhost',
      namespace: 'safe',
      nodeId: 'node',
      workspaces: { constructor: '/tmp/prototype-workspace' },
      defaultWorkspace: 'constructor',
    }, {})
    expect(config.workspaces.constructor).toBe('/tmp/prototype-workspace')
  })
})
