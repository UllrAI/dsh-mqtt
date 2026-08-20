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

export function formatTime(value: number | string | undefined, locale: string, t: Translate): string {
  if (value === undefined) return t('neverUsed')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('neverUsed')
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function formatClock(value: number | string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(value))
}

export function readyWorkspaceCount(status: NodeStatus | undefined): number {
  return status?.workspaces?.filter(workspace => workspace.status === 'ready').length ?? 0
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
