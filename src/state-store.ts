import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { GatewayResult } from './protocol.ts'

export type StoredStatus = 'accepted' | 'active' | 'completed' | 'failed' | 'cancelled'

export interface StoredControl {
  fingerprint: string
  processedAt: number
}

export interface StoredRequest {
  id: string
  fingerprint: string
  status: StoredStatus
  createdAt: number
  updatedAt: number
  expiresAt: number
  sessionId?: string
  result?: GatewayResult
  controls: Record<string, StoredControl>
}

interface StateFile {
  version: 1
  requests: Record<string, StoredRequest>
}

export type ReserveResult =
  | { kind: 'reserved'; record: StoredRequest }
  | { kind: 'duplicate'; record: StoredRequest }
  | { kind: 'conflict'; record: StoredRequest }

export type ControlClaimResult =
  | { kind: 'claimed'; record: StoredRequest }
  | { kind: 'duplicate'; record: StoredRequest }
  | { kind: 'conflict'; record: StoredRequest }
  | { kind: 'not-found' }
  | { kind: 'terminal'; record: StoredRequest }

function isTerminal(status: StoredStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function emptyState(): StateFile {
  return { version: 1, requests: {} }
}

function assertState(value: unknown): StateFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-mqtt state file must contain a JSON object')
  }
  const candidate = value as Partial<StateFile>
  if (candidate.version !== 1 || candidate.requests === null || typeof candidate.requests !== 'object' || Array.isArray(candidate.requests)) {
    throw new Error('dsh-mqtt state file has an unsupported or invalid format')
  }
  for (const [id, record] of Object.entries(candidate.requests)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`dsh-mqtt state record ${JSON.stringify(id)} is invalid`)
    }
    const row = record as Partial<StoredRequest>
    if (row.id !== id || typeof row.fingerprint !== 'string' || typeof row.status !== 'string'
      || typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number'
      || typeof row.expiresAt !== 'number' || row.controls === null || typeof row.controls !== 'object') {
      throw new Error(`dsh-mqtt state record ${JSON.stringify(id)} is invalid`)
    }
  }
  return candidate as StateFile
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class RequestStore {
  private state = emptyState()
  private opened = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async open(): Promise<void> {
    if (this.opened) return
    try {
      const raw = await readFile(this.file, 'utf8')
      this.state = assertState(JSON.parse(raw) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`dsh-mqtt: failed to load state file ${this.file}`, { cause: error })
      }
      this.state = emptyState()
    }
    this.opened = true
    await this.mutate(() => undefined)
  }

  async reserve(id: string, requestFingerprint: string): Promise<ReserveResult> {
    return this.mutate(() => {
      const existing = this.state.requests[id]
      if (existing !== undefined) {
        return {
          kind: existing.fingerprint === requestFingerprint ? 'duplicate' : 'conflict',
          record: clone(existing),
        }
      }
      const now = this.now()
      const record: StoredRequest = {
        id,
        fingerprint: requestFingerprint,
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.ttlMs,
        controls: {},
      }
      this.state.requests[id] = record
      return { kind: 'reserved', record: clone(record) }
    })
  }

  async activate(id: string, sessionId: string): Promise<StoredRequest> {
    return this.mutate(() => {
      const record = this.require(id)
      if (isTerminal(record.status)) throw new Error(`request ${id} is already terminal`)
      record.status = 'active'
      record.sessionId = sessionId
      this.touch(record)
      return clone(record)
    })
  }

  async finish(id: string, result: GatewayResult): Promise<StoredRequest> {
    return this.mutate(() => {
      const record = this.require(id)
      record.status = result.status
      record.result = clone(result)
      if (result.session_id !== undefined) record.sessionId = result.session_id
      this.touch(record)
      return clone(record)
    })
  }

  async claimControl(id: string, commandId: string, controlFingerprint: string): Promise<ControlClaimResult> {
    return this.mutate(() => {
      const record = this.state.requests[id]
      if (record === undefined) return { kind: 'not-found' }
      if (isTerminal(record.status)) return { kind: 'terminal', record: clone(record) }
      const existing = record.controls[commandId]
      if (existing !== undefined) {
        return {
          kind: existing.fingerprint === controlFingerprint ? 'duplicate' : 'conflict',
          record: clone(record),
        }
      }
      record.controls[commandId] = { fingerprint: controlFingerprint, processedAt: this.now() }
      this.touch(record)
      return { kind: 'claimed', record: clone(record) }
    })
  }

  async get(id: string): Promise<StoredRequest | undefined> {
    return this.read(() => {
      const record = this.state.requests[id]
      return record === undefined ? undefined : clone(record)
    })
  }

  async activeCount(): Promise<number> {
    return this.read(() => Object.values(this.state.requests).filter(record => !isTerminal(record.status)).length)
  }

  async recoverInterrupted(makeResult: (record: StoredRequest) => GatewayResult): Promise<StoredRequest[]> {
    return this.mutate(() => {
      const recovered: StoredRequest[] = []
      for (const record of Object.values(this.state.requests)) {
        if (isTerminal(record.status)) continue
        const result = makeResult(clone(record))
        record.status = result.status
        record.result = clone(result)
        this.touch(record)
        recovered.push(clone(record))
      }
      return recovered
    })
  }

  async close(): Promise<void> {
    await this.queue
  }

  private require(id: string): StoredRequest {
    const record = this.state.requests[id]
    if (record === undefined) throw new Error(`unknown request ${id}`)
    return record
  }

  private touch(record: StoredRequest): void {
    const now = this.now()
    record.updatedAt = now
    record.expiresAt = now + this.ttlMs
  }

  private cleanup(): void {
    const now = this.now()
    for (const [id, record] of Object.entries(this.state.requests)) {
      if (isTerminal(record.status) && record.expiresAt <= now) delete this.state.requests[id]
    }
  }

  private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertOpen()
    const task = this.queue.then(async () => {
      this.cleanup()
      const result = await operation()
      await this.persist()
      return result
    })
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private read<T>(operation: () => T): Promise<T> {
    this.assertOpen()
    return this.queue.then(operation)
  }

  private assertOpen(): void {
    if (!this.opened) throw new Error('dsh-mqtt request store is not open')
  }

  private async persist(): Promise<void> {
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(this.file)}.${process.pid}.${Date.now()}.tmp`)
    const bytes = `${JSON.stringify(this.state, null, 2)}\n`
    await writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, this.file)
    try {
      await access(this.file, constants.F_OK)
      await chmod(this.file, 0o600)
    } catch (error) {
      throw new Error(`dsh-mqtt: failed to secure state file ${this.file}`, { cause: error })
    }
  }
}
