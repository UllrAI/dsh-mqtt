/**
 * Presentation helpers shared by both UI forms.
 */

import type { Dictionary, Translate } from './i18n.ts'
import type { NodeStatus, RequestRecord } from './api.ts'

const NODE_STATE_KEYS: Record<string, keyof Dictionary> = {
  starting: 'stateStarting',
  connecting: 'stateConnecting',
  ready: 'stateReady',
  busy: 'stateBusy',
  degraded: 'stateDegraded',
  offline: 'stateOffline',
  stopped: 'stateStopped',
}

const REQUEST_STATUS_KEYS: Record<RequestRecord['status'], keyof Dictionary> = {
  accepted: 'statusAccepted',
  active: 'statusActive',
  completed: 'statusCompleted',
  failed: 'statusFailed',
  cancelled: 'statusCancelled',
}

export function nodeStateLabel(state: string | undefined, t: Translate): string {
  const key = state === undefined ? undefined : NODE_STATE_KEYS[state]
  return key === undefined ? t('stateUnknown') : t(key)
}

export function requestStatusLabel(status: RequestRecord['status'], t: Translate): string {
  return t(REQUEST_STATUS_KEYS[status])
}

/** Dot tone, using the `StateDot` primitive's vocabulary. */
export type Tone = 'done' | 'warning' | 'ongoing' | 'error'

export function nodeStateTone(state: string | undefined): Tone {
  if (state === 'ready') return 'done'
  if (state === 'busy') return 'ongoing'
  if (state === 'offline' || state === 'stopped') return 'error'
  return 'warning'
}

export function requestStatusTone(status: RequestRecord['status']): Tone {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'error'
  if (status === 'active' || status === 'accepted') return 'ongoing'
  return 'warning'
}

export function healthTone(status: 'ready' | 'degraded' | 'offline'): Tone {
  return status === 'ready' ? 'done' : status === 'offline' ? 'error' : 'warning'
}

const HEALTH_NAME_KEYS: Record<string, keyof Dictionary> = {
  broker: 'healthBroker',
  agent: 'healthAgent',
  model: 'healthModel',
}

const HEALTH_STATUS_KEYS: Record<string, keyof Dictionary> = {
  ready: 'healthReady',
  degraded: 'healthDegraded',
  offline: 'healthOffline',
  missing: 'healthMissing',
  'not-directory': 'healthNotDirectory',
  unreadable: 'healthUnreadable',
  unavailable: 'healthUnavailable',
}

/**
 * A readable name for a health row.
 *
 * The gateway names checks with protocol identifiers so a machine consumer can
 * match on them; the workspace ones carry an alias the operator chose, which is
 * already readable and must not be translated.
 */
export function healthLabel(name: string, t: Translate): string {
  const workspace = name.startsWith('workspace:') ? name.slice('workspace:'.length) : undefined
  if (workspace !== undefined) return t('healthWorkspace', { alias: workspace })
  const key = HEALTH_NAME_KEYS[name]
  return key === undefined ? name : t(key)
}

/**
 * The right-hand detail for a health row.
 *
 * A check's `message` is either an operator-facing string the gateway built or
 * one of the host's status identifiers; translate the identifiers and pass
 * anything else through, since inventing a fallback would hide a real error.
 */
export function healthDetail(check: { status: string; message?: string }, t: Translate): string {
  const raw = check.message ?? check.status
  const key = HEALTH_STATUS_KEYS[raw]
  return key === undefined ? raw : t(key)
}

/**
 * An absolute date and time, or a caller-chosen word when there is none.
 *
 * The empty case is the caller's to name: "never used" reads right for a
 * controller's last activity and wrong for an expiry date.
 */
export function formatTime(
  value: number | string | undefined,
  locale: string,
  fallback: string,
): string {
  if (value === undefined) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function formatClock(value: number | string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(value))
}

/** Ready count over total, so "2" cannot be mistaken for "all of them". */
export function workspaceReadiness(status: NodeStatus | undefined): { ready: number; total: number } {
  const workspaces = status?.workspaces ?? []
  return { ready: workspaces.filter(workspace => workspace.status === 'ready').length, total: workspaces.length }
}

/** Elapsed time in the coarsest unit that still reads precisely. */
export function formatDuration(ms: number, t: Translate): string {
  if (ms < 1_000) return t('durationMs', { count: Math.max(0, Math.round(ms)) })
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) return t('durationSeconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('durationMinutes', { count: minutes, seconds: seconds % 60 })
  return t('durationHours', { count: Math.floor(minutes / 60), minutes: minutes % 60 })
}

/**
 * Attribute a task to a controller by name.
 *
 * Returns undefined when the id is absent or no longer listed — a revoked
 * controller is pruned from the list while its tasks stay in history.
 */
export function controllerName(id: string | undefined, controllers: Array<{ id: string; name: string }>): string | undefined {
  if (id === undefined) return undefined
  return controllers.find(controller => controller.id === id)?.name
}

/** The controller config a worker hands out; deliberately free of broker secrets. */
export function inviteConfigText(
  invite: { id: string; token: string; expiresAt: number },
  config: { url: string; namespace: string; node_id: string },
): string {
  return JSON.stringify({
    version: 1,
    broker_url: config.url,
    namespace: config.namespace,
    node_id: config.node_id,
    controller_id: invite.id,
    token: invite.token,
    expires_at: new Date(invite.expiresAt).toISOString(),
  }, null, 2)
}
