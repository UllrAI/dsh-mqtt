import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

  it('claims a session the agent reports only in its result', async () => {
    const { store } = await fixture()
    await store.reserve('resumed', 'fingerprint')
    await store.activate('resumed', 'first-session')
    // A resumed conversation answers on a different session than it started on.
    await store.finish('resumed', protocolResult('resumed', 'completed', { sessionId: 'agent-chosen' }))

    expect(await store.hasSession('agent-chosen')).toBe(true)
    expect(await store.hasSession('first-session')).toBe(true)
  })

  it('keeps the session ledger free of duplicates so it cannot grow unbounded', async () => {
    const { store, file } = await fixture()
    for (const id of ['a', 'b', 'c']) {
      await store.reserve(id, 'fingerprint')
      // Every request lands on the same session, as a resumed conversation does.
      await store.activate(id, 'shared-session')
    }

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { sessions: string[] }
    expect(persisted.sessions).toEqual(['shared-session'])
  })

  it('reads a state file written before the session ledger existed', async () => {
    const { store, file } = await fixture()
    await store.close()
    await writeFile(file, JSON.stringify({ version: 1, requests: {} }), 'utf8')

    const reopened = new RequestStore(file, 100)
    await reopened.open()
    expect(await reopened.hasSession('anything')).toBe(false)
    await reopened.close()
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

  it('holds the request ledger at its cap by dropping the oldest terminal records', async () => {
    // Seeded directly: driving 5 000 requests through the API would spend the
    // whole test budget rewriting the same file.
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mqtt-store-'))
    directories.push(directory)
    const file = join(directory, 'state.json')
    const requests: Record<string, unknown> = {}
    for (let index = 0; index < 5_100; index += 1) {
      const id = `req-${index}`
      requests[id] = {
        id,
        fingerprint: id,
        status: 'completed',
        createdAt: index,
        updatedAt: index,
        expiresAt: 10_000_000,
        controls: {},
        result: protocolResult(id, 'completed', {}),
      }
    }
    await writeFile(file, JSON.stringify({ version: 1, requests, sessions: [] }))

    const store = new RequestStore(file, 60_000, () => 1_000)
    await store.open()
    // Any mutation sweeps first; the reservation itself is one more record.
    await store.reserve('fresh', 'fingerprint')

    // The sweep runs before the operation: 5 100 records, cap 5 000, so the
    // 100 least recently updated go and the new reservation lands on top.
    expect(await store.get('req-0')).toBeUndefined()
    expect(await store.get('req-99')).toBeUndefined()
    expect(await store.get('req-100')).toBeDefined()
    expect(await store.get('fresh')).toBeDefined()
  })

  it('keeps a live request even when the ledger is over its cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mqtt-store-'))
    directories.push(directory)
    const file = join(directory, 'state.json')
    const requests: Record<string, unknown> = {}
    for (let index = 0; index < 5_001; index += 1) {
      const id = `req-${index}`
      requests[id] = {
        id,
        fingerprint: id,
        status: index === 0 ? 'active' : 'completed',
        createdAt: index,
        updatedAt: index,
        expiresAt: 10_000_000,
        controls: {},
        ...index === 0 ? {} : { result: protocolResult(id, 'completed', {}) },
      }
    }
    await writeFile(file, JSON.stringify({ version: 1, requests, sessions: [] }))

    const store = new RequestStore(file, 60_000, () => 1_000)
    await store.open()
    await store.reserve('fresh', 'fingerprint')

    expect(await store.get('req-0')).toMatchObject({ status: 'active' })
    expect(await store.get('req-1')).toBeUndefined()
    expect(await store.get('req-2')).toBeDefined()
  })

  it('writes a controller\'s last use at most once a minute, and not at all when nothing changed', async () => {
    let clock = 1_000_000
    const { store, file } = await fixture(() => clock)
    const invite = await store.createController('MacBook', ['submit'], 600_000)
    await store.authorizeController(invite.id)
    await store.authenticateController(invite.id, invite.token, 'submit')
    const firstUse = clock
    const written = await stat(file)

    // A chatty controller must not turn every message into an fsync.
    clock += 30_000
    await store.authenticateController(invite.id, invite.token, 'submit')
    expect((await store.listControllers())[0]?.lastUsedAt).toBe(firstUse)
    expect((await stat(file)).mtimeMs).toBe(written.mtimeMs)

    clock += 31_000
    await store.authenticateController(invite.id, invite.token, 'submit')
    expect((await store.listControllers())[0]?.lastUsedAt).toBe(clock)
  })

  it('lists controllers newest first, and does not reshuffle them as they are used', async () => {
    let clock = 1_000
    const { store } = await fixture(() => clock)
    const first = await store.createController('First', ['submit'], 600_000)
    clock += 1_000
    const second = await store.createController('Second', ['submit'], 600_000)
    await store.authorizeController(first.id)
    clock += 120_000
    await store.authenticateController(first.id, first.token, 'submit')

    expect((await store.listControllers()).map(controller => controller.id)).toEqual([second.id, first.id])
  })

  it('refuses work once closed', async () => {
    const { store } = await fixture()
    await store.close()

    await expect(store.reserve('req-1', 'fingerprint')).rejects.toThrow(/not open/)
    await expect(store.listControllers()).rejects.toThrow(/not open/)
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
