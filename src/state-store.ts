import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isRfc3339DateTime, type GatewayResult } from './protocol.ts'
import { isRequestId } from './topics.ts'

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
  /** Workspace alias the controller asked for, as sent. */
  workspace?: string
  /** Controller that submitted it, for attribution in the management UI. */
  controllerId?: string
  result?: GatewayResult
  controls: Record<string, StoredControl>
}

/** What a request was submitted with; recorded once, at reservation. */
export interface RequestOrigin {
  workspace?: string
  controllerId?: string
}

export type StoredControllerStatus = 'pending' | 'authorized' | 'revoked'

export interface StoredController {
  id: string
  name: string
  scopes: string[]
  status: StoredControllerStatus
  tokenHash: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  lastUsedAt?: number
}

export interface ControllerSummary {
  id: string
  name: string
  scopes: string[]
  status: StoredControllerStatus
  createdAt: number
  updatedAt: number
  expiresAt: number
  lastUsedAt?: number
}

export interface ControllerInvite {
  id: string
  name: string
  scopes: string[]
  token: string
  createdAt: number
  expiresAt: number
}

/**
 * In-memory state. `sessions` is a `Set` here and an array on disk.
 *
 * Session ownership is its own ledger rather than something derived from
 * `requests`: a request record expires after `ttlMs`, but the agent session it
 * opened can outlive it, and forgetting the session would make us disown a
 * follow-up on a conversation we are in fact still hosting.
 */
interface StateFile {
  version: 1
  requests: Record<string, StoredRequest>
  controllers?: Record<string, StoredController>
  sessions: Set<string>
}

/**
 * Session ledger bound.
 *
 * Nothing prunes ownership by time, so cap it and evict least-recently-seen.
 * At roughly 46 bytes an id this is well under a megabyte, and far more sessions
 * than a single worker plausibly hosts inside one state file.
 */
const MAX_SESSIONS = 10_000

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
  return {
    version: 1,
    requests: Object.create(null) as Record<string, StoredRequest>,
    controllers: Object.create(null) as Record<string, StoredController>,
    sessions: new Set(),
  }
}

const STORED_STATUSES = new Set<StoredStatus>(['accepted', 'active', 'completed', 'failed', 'cancelled'])

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const CONTROLLER_STATUSES = new Set<StoredControllerStatus>(['pending', 'authorized', 'revoked'])

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * A named entity that does not exist.
 *
 * Carries the HTTP status so the management server can answer 404 without
 * pattern-matching on error text.
 */
export class NotFoundError extends Error {
  readonly status = 404
}

function controllerSummary(controller: StoredController): ControllerSummary {
  return {
    id: controller.id,
    name: controller.name,
    scopes: [...controller.scopes],
    status: controller.status,
    createdAt: controller.createdAt,
    updatedAt: controller.updatedAt,
    expiresAt: controller.expiresAt,
    ...controller.lastUsedAt === undefined ? {} : { lastUsedAt: controller.lastUsedAt },
  }
}

function assertResult(value: unknown, id: string, status: StoredStatus): GatewayResult {
  if (!plainObject(value) || value.version !== 1 || value.id !== id || value.type !== 'request.result'
    || typeof value.timestamp !== 'string' || !isRfc3339DateTime(value.timestamp)
    || value.status !== status || !isTerminal(status)) {
    throw new Error(`dsh-mqtt state result for ${JSON.stringify(id)} is invalid`)
  }
  if (value.session_id !== undefined && (typeof value.session_id !== 'string' || !isRequestId(value.session_id))) {
    throw new Error(`dsh-mqtt state result for ${JSON.stringify(id)} has an invalid session id`)
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw new Error(`dsh-mqtt state result for ${JSON.stringify(id)} has an invalid summary`)
  }
  if (value.error !== null && (!plainObject(value.error) || typeof value.error.code !== 'string'
    || typeof value.error.message !== 'string' || typeof value.error.retryable !== 'boolean')) {
    throw new Error(`dsh-mqtt state result for ${JSON.stringify(id)} has an invalid error`)
  }
  return value as unknown as GatewayResult
}

function assertState(value: unknown): StateFile {
  if (!plainObject(value)) {
    throw new Error('dsh-mqtt state file must contain a JSON object')
  }
  const candidate = value as Partial<StateFile> & { sessions?: unknown }
  if (candidate.version !== 1 || !plainObject(candidate.requests)) {
    throw new Error('dsh-mqtt state file has an unsupported or invalid format')
  }
  const requests = Object.create(null) as Record<string, StoredRequest>
  const controllers = Object.create(null) as Record<string, StoredController>
  // Absent in files written before the ledger existed; an upgrade must not throw.
  if (candidate.sessions !== undefined && !Array.isArray(candidate.sessions)) {
    throw new Error('dsh-mqtt state file has an unsupported or invalid format')
  }
  const sessions = new Set<string>()
  for (const sessionId of candidate.sessions ?? []) {
    if (typeof sessionId !== 'string' || !isRequestId(sessionId)) {
      throw new Error(`dsh-mqtt state session ${JSON.stringify(sessionId)} is invalid`)
    }
    sessions.add(sessionId)
  }
  for (const [id, record] of Object.entries(candidate.requests)) {
    if (!isRequestId(id) || !plainObject(record)) {
      throw new Error(`dsh-mqtt state record ${JSON.stringify(id)} is invalid`)
    }
    const row = record as Partial<StoredRequest>
    if (row.id !== id || typeof row.fingerprint !== 'string' || row.fingerprint.length === 0
      || typeof row.status !== 'string' || !STORED_STATUSES.has(row.status as StoredStatus)
      || !safeTimestamp(row.createdAt) || !safeTimestamp(row.updatedAt) || !safeTimestamp(row.expiresAt)
      || !plainObject(row.controls)
      || (row.sessionId !== undefined && (typeof row.sessionId !== 'string' || !isRequestId(row.sessionId)))
      || (row.workspace !== undefined && typeof row.workspace !== 'string')
      || (row.controllerId !== undefined && (typeof row.controllerId !== 'string' || !isRequestId(row.controllerId)))) {
      throw new Error(`dsh-mqtt state record ${JSON.stringify(id)} is invalid`)
    }
    const status = row.status as StoredStatus
    if (isTerminal(status) !== (row.result !== undefined)) {
      throw new Error(`dsh-mqtt state record ${JSON.stringify(id)} has inconsistent terminal state`)
    }
    const controls = Object.create(null) as Record<string, StoredControl>
    for (const [commandId, control] of Object.entries(row.controls)) {
      if (!isRequestId(commandId) || !plainObject(control) || typeof control.fingerprint !== 'string'
        || control.fingerprint.length === 0 || !safeTimestamp(control.processedAt)) {
        throw new Error(`dsh-mqtt state control ${JSON.stringify(commandId)} is invalid`)
      }
      controls[commandId] = { fingerprint: control.fingerprint, processedAt: control.processedAt }
    }
    const normalized: StoredRequest = {
      id,
      fingerprint: row.fingerprint,
      status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      ...row.sessionId === undefined ? {} : { sessionId: row.sessionId },
      ...row.workspace === undefined ? {} : { workspace: row.workspace },
      ...row.controllerId === undefined ? {} : { controllerId: row.controllerId },
      ...row.result === undefined ? {} : { result: assertResult(row.result, id, status) },
      controls,
    }
    requests[id] = normalized
  }
  for (const [id, controller] of Object.entries(candidate.controllers ?? {})) {
    if (!isRequestId(id) || !plainObject(controller)) {
      throw new Error(`dsh-mqtt controller ${JSON.stringify(id)} is invalid`)
    }
    const row = controller as Partial<StoredController>
    if (row.id !== id || typeof row.name !== 'string' || row.name.length === 0 || row.name.length > 128
      || !Array.isArray(row.scopes) || row.scopes.some(scope => typeof scope !== 'string' || scope.length === 0 || scope.length > 64)
      || typeof row.status !== 'string' || !CONTROLLER_STATUSES.has(row.status as StoredControllerStatus)
      || typeof row.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.tokenHash)
      || !safeTimestamp(row.createdAt) || !safeTimestamp(row.updatedAt) || !safeTimestamp(row.expiresAt)
      || (row.lastUsedAt !== undefined && !safeTimestamp(row.lastUsedAt))) {
      throw new Error(`dsh-mqtt controller ${JSON.stringify(id)} is invalid`)
    }
    controllers[id] = {
      id,
      name: row.name,
      scopes: [...row.scopes],
      status: row.status as StoredControllerStatus,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      ...row.lastUsedAt === undefined ? {} : { lastUsedAt: row.lastUsedAt },
    }
  }
  return { version: 1, requests, controllers, sessions }
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

  async reserve(id: string, requestFingerprint: string, origin: RequestOrigin = {}): Promise<ReserveResult> {
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
        ...origin.workspace === undefined ? {} : { workspace: origin.workspace },
        ...origin.controllerId === undefined ? {} : { controllerId: origin.controllerId },
        controls: Object.create(null) as Record<string, StoredControl>,
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
      this.rememberSession(record, sessionId)
      this.touch(record)
      return clone(record)
    })
  }

  /**
   * Record a session as ours, most-recently-seen last.
   *
   * Re-adding after a delete moves the id to the end of the `Set`, so the
   * insertion order is a recency order and the oldest entry is the first one to
   * evict once the ledger is full.
   */
  private rememberSession(record: StoredRequest, sessionId: string): void {
    record.sessionId = sessionId
    this.state.sessions.delete(sessionId)
    this.state.sessions.add(sessionId)
    for (const oldest of this.state.sessions) {
      if (this.state.sessions.size <= MAX_SESSIONS) break
      this.state.sessions.delete(oldest)
    }
  }

  async finish(id: string, result: GatewayResult): Promise<StoredRequest> {
    return this.mutate(() => {
      const record = this.require(id)
      record.status = result.status
      record.result = clone(result)
      // The agent may answer on a session we have not seen: a resumed
      // conversation comes back with an id we never recorded at activation.
      if (result.session_id !== undefined) this.rememberSession(record, result.session_id)
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

  /**
   * Give a claimed command id back.
   *
   * Dedup must not turn a retryable failure into a permanent one: when the
   * command was accepted for dedup purposes but never delivered, the controller
   * has to be able to send the same command id again.
   */
  async releaseControl(id: string, commandId: string): Promise<void> {
    await this.mutate(() => {
      const record = this.state.requests[id]
      if (record === undefined) return
      delete record.controls[commandId]
      this.touch(record)
    })
  }

  async get(id: string): Promise<StoredRequest | undefined> {
    return this.read(() => {
      const record = this.state.requests[id]
      return record === undefined ? undefined : clone(record)
    })
  }

  async list(options: { limit?: number } = {}): Promise<StoredRequest[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
    return this.read(() => Object.values(this.state.requests)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(clone))
  }

  async activeCount(): Promise<number> {
    return this.read(() => Object.values(this.state.requests).filter(record => !isTerminal(record.status)).length)
  }

  /**
   * Whether this gateway created the session.
   *
   * Reads the ledger, which is why a session id that only ever arrived on a
   * result is still recognised: `finish` records it as readily as activation.
   */
  async hasSession(sessionId: string): Promise<boolean> {
    return this.read(() => this.state.sessions.has(sessionId))
  }

  async createController(name: string, scopes: string[], ttlMs: number): Promise<ControllerInvite> {
    if (name.length === 0 || name.length > 128) throw new Error('controller name must contain 1 to 128 characters')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('controller invite ttl must be a positive integer')
    if (scopes.length === 0 || scopes.length > 32 || scopes.some(scope => scope.length === 0 || scope.length > 64)) {
      throw new Error('controller scopes must contain 1 to 32 values of 1 to 64 characters')
    }
    return this.mutate(() => {
      const now = this.now()
      const id = `controller-${randomBytes(12).toString('hex')}`
      const token = randomBytes(32).toString('base64url')
      const expiresAt = now + ttlMs
      const controller: StoredController = {
        id,
        name,
        scopes: [...new Set(scopes)],
        status: 'pending',
        tokenHash: tokenHash(token),
        createdAt: now,
        updatedAt: now,
        expiresAt,
      }
      this.state.controllers ??= Object.create(null) as Record<string, StoredController>
      this.state.controllers[id] = controller
      return { id, name, scopes: [...controller.scopes], token, createdAt: now, expiresAt }
    })
  }

  async listControllers(): Promise<ControllerSummary[]> {
    return this.read(() => Object.values(this.state.controllers ?? {})
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(controllerSummary))
  }

  async authorizeController(id: string): Promise<ControllerSummary> {
    return this.mutate(() => {
      const controller = this.requireController(id)
      if (controller.expiresAt <= this.now()) throw new Error('controller invite has expired')
      controller.status = 'authorized'
      controller.updatedAt = this.now()
      return controllerSummary(controller)
    })
  }

  async revokeController(id: string): Promise<ControllerSummary> {
    return this.mutate(() => {
      const controller = this.requireController(id)
      controller.status = 'revoked'
      controller.updatedAt = this.now()
      return controllerSummary(controller)
    })
  }

  async authenticateController(id: string, token: string, scope: string): Promise<
    { ok: true; controller: ControllerSummary } | { ok: false; reason: 'not-found' | 'pending' | 'revoked' | 'expired' | 'invalid-token' | 'scope-denied' }
  > {
    return this.mutate(() => {
      const controller = this.state.controllers?.[id]
      if (controller === undefined) return { ok: false, reason: 'not-found' as const }
      if (controller.status === 'pending') return { ok: false, reason: 'pending' as const }
      if (controller.status === 'revoked') return { ok: false, reason: 'revoked' as const }
      if (controller.expiresAt <= this.now()) return { ok: false, reason: 'expired' as const }
      const expected = Buffer.from(controller.tokenHash, 'utf8')
      const actual = Buffer.from(tokenHash(token), 'utf8')
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return { ok: false, reason: 'invalid-token' as const }
      }
      if (!controller.scopes.includes(scope) && !controller.scopes.includes('*')) {
        return { ok: false, reason: 'scope-denied' as const }
      }
      controller.lastUsedAt = this.now()
      controller.updatedAt = controller.lastUsedAt
      return { ok: true as const, controller: controllerSummary(controller) }
    })
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

  private requireController(id: string): StoredController {
    const controller = this.state.controllers?.[id]
    if (controller === undefined) throw new NotFoundError(`unknown controller ${id}`)
    return controller
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
    // A revoked controller past its expiry can never authenticate again, so the
    // row is dead weight. Pending and authorized ones stay, expired or not: the
    // operator still needs to see and revoke them.
    const controllers = this.state.controllers
    if (controllers === undefined) return
    for (const [id, controller] of Object.entries(controllers)) {
      if (controller.status === 'revoked' && controller.expiresAt <= now) delete controllers[id]
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
    // Compact, not pretty-printed: nothing reads this by hand, and every mutation
    // rewrites the whole file. The session ledger is a `Set` in memory, so it is
    // widened to an array here — `JSON.stringify` would otherwise emit `{}`.
    const bytes = `${JSON.stringify({ ...this.state, sessions: [...this.state.sessions] })}\n`
    try {
      // Flush before the rename. The rename is atomic, but without the sync a
      // power loss can leave the replacement empty — and this file is the only
      // thing standing between a crash and a replayed request.
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw new Error(`dsh-mqtt: failed to persist state file ${this.file}`, { cause: error })
    }
  }
}
