import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { protocolResult } from '../src/protocol.ts'
import { RequestStore } from '../src/state-store.ts'

const directories: string[] = []

async function fixture(now: () => number = Date.now, ttl = 60_000): Promise<{ store: RequestStore; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mqtt-store-'))
  directories.push(directory)
  const file = join(directory, 'nested', 'state.json')
  const store = new RequestStore(file, ttl, now)
  await store.open()
  return { store, file }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('RequestStore', () => {
  it('persists reservation, activation, control deduplication, and result', async () => {
    const { store, file } = await fixture()
    expect((await store.reserve('req-1', 'fingerprint-a')).kind).toBe('reserved')
    expect((await store.reserve('req-1', 'fingerprint-a')).kind).toBe('duplicate')
    expect((await store.reserve('req-1', 'fingerprint-b')).kind).toBe('conflict')

    await store.activate('req-1', 'session-1')
    expect(await store.list()).toHaveLength(1)
    expect(await store.hasSession('session-1')).toBe(true)
    expect(await store.hasSession('other-session')).toBe(false)
    expect((await store.claimControl('req-1', 'cmd-1', 'control-a')).kind).toBe('claimed')
    expect((await store.claimControl('req-1', 'cmd-1', 'control-a')).kind).toBe('duplicate')
    expect((await store.claimControl('req-1', 'cmd-1', 'control-b')).kind).toBe('conflict')

    const result = protocolResult('req-1', 'completed', { sessionId: 'session-1', summary: 'Done' })
    await store.finish('req-1', result)
    expect((await store.claimControl('req-1', 'cmd-2', 'control-c')).kind).toBe('terminal')
    await store.close()

    const reopened = new RequestStore(file, 60_000)
    await reopened.open()
    expect(await reopened.get('req-1')).toMatchObject({
      status: 'completed',
      sessionId: 'session-1',
      result,
    })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('marks interrupted requests terminal and expires only terminal records', async () => {
    let clock = 1_000
    const { store } = await fixture(() => clock, 100)
    await store.reserve('active', 'a')
    await store.activate('active', 'session-active')
    const recovered = await store.recoverInterrupted(record => protocolResult(record.id, 'failed', {
      ...record.sessionId === undefined ? {} : { sessionId: record.sessionId },
      error: { code: 'RESTART', message: 'restarted', retryable: true },
    }))
    expect(recovered).toHaveLength(1)
    expect((await store.get('active'))?.status).toBe('failed')

    clock += 101
    await store.reserve('new', 'b')
    expect(await store.get('active')).toBeUndefined()
    expect(await store.activeCount()).toBe(1)
    expect(await store.hasSession('session-active')).toBe(true)
  })

  it('persists session ownership after request records expire', async () => {
    let clock = 1_000
    const { store, file } = await fixture(() => clock, 100)
    await store.reserve('original', 'fingerprint')
    await store.activate('original', 'owned-session')
    await store.finish('original', protocolResult('original', 'completed', { sessionId: 'owned-session' }))
    clock += 101
    await store.reserve('cleanup-trigger', 'fingerprint')
    expect(await store.get('original')).toBeUndefined()
    await store.close()

    const reopened = new RequestStore(file, 100, () => clock)
    await reopened.open()
    expect(await reopened.hasSession('owned-session')).toBe(true)
  })

  it('handles topic-safe prototype property names without corrupting dictionaries', async () => {
    const { store } = await fixture()
    expect((await store.reserve('constructor', 'request-fingerprint')).kind).toBe('reserved')
    expect((await store.claimControl('constructor', 'toString', 'control-fingerprint')).kind).toBe('claimed')
    expect((await store.claimControl('constructor', 'toString', 'control-fingerprint')).kind).toBe('duplicate')
  })

  it('persists controller invites, authorization, usage, and revocation without exposing token hashes', async () => {
    const { store, file } = await fixture()
    const invite = await store.createController('MacBook', ['submit', 'control'], 60_000)
    expect(invite.token).toHaveLength(43)
    expect((await store.listControllers())).toMatchObject([{ id: invite.id, status: 'pending', name: 'MacBook' }])
    expect(await store.authenticateController(invite.id, invite.token, 'submit')).toMatchObject({ ok: false, reason: 'pending' })
    await store.authorizeController(invite.id)
    expect(await store.authenticateController(invite.id, invite.token, 'submit')).toMatchObject({ ok: true, controller: { id: invite.id } })
    expect(await store.authenticateController(invite.id, 'wrong-token', 'submit')).toMatchObject({ ok: false, reason: 'invalid-token' })
    await store.revokeController(invite.id)
    expect(await store.authenticateController(invite.id, invite.token, 'control')).toMatchObject({ ok: false, reason: 'revoked' })
    await store.close()
    expect(await readFile(file, 'utf8')).not.toContain(invite.token)
  })

  it('fails loudly on a corrupt state file', async () => {
    const { file } = await fixture()
    await rm(file)
    const directory = file.slice(0, file.lastIndexOf('/'))
    const corrupt = new RequestStore(file, 1_000)
    await import('node:fs/promises').then(({ mkdir, writeFile }) => Promise.all([
      mkdir(directory, { recursive: true }),
      writeFile(file, '{"version":99}'),
    ]))
    await expect(corrupt.open()).rejects.toThrow(/failed to load state file/)
  })

  it.each([
    '{"version":1,"requests":{"bad/#":{}},"sessions":[]}',
    '{"version":1,"requests":{"req":{"id":"req","fingerprint":"x","status":"unknown","createdAt":1,"updatedAt":1,"expiresAt":2,"controls":{}}},"sessions":[]}',
    '{"version":1,"requests":{"req":{"id":"req","fingerprint":"x","status":"completed","createdAt":1,"updatedAt":1,"expiresAt":2,"controls":{}}},"sessions":[]}',
    '{"version":1,"requests":{},"sessions":["bad/#"]}',
  ])('rejects structurally invalid persisted state: %s', async raw => {
    const { file } = await fixture()
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, raw))
    const corrupt = new RequestStore(file, 1_000)
    await expect(corrupt.open()).rejects.toThrow(/failed to load state file/)
  })
})
