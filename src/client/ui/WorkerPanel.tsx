/**
 * The MQTT worker management panel.
 *
 * Rendered by both UI forms: as a `settings.section` inside DSH, and as the
 * whole page of the standalone server. Styling comes from `--dsw-*` tokens, so
 * the panel follows the shell's theme without a stylesheet of its own.
 */

import { useCallback, useState } from 'react'
import { Button, Input, Modal, StateDot, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Controller, ControllerInvite, ManagementClient } from '../core/api.ts'
import type { Translate } from '../core/i18n.ts'
import {
  formatClock,
  formatTime,
  healthTone,
  inviteConfigText,
  nodeStateLabel,
  nodeStateTone,
  readyWorkspaceCount,
  requestStatusLabel,
  requestStatusTone,
} from '../core/format.ts'
import { useManagementStore } from './useManagementStore.ts'
import { Field, Row, Section } from './parts.tsx'

export interface WorkerPanelProps {
  client: ManagementClient
  t: Translate
  locale: string
  /** Called with a token the user supplied for a gateway that requires one. */
  onToken?: (token: string) => void
}

type DialogKind = 'invite' | 'connection' | { controller: Controller }

export function WorkerPanel({ client, t, locale, onToken }: WorkerPanelProps): JSX.Element {
  const { state, store } = useManagementStore(client)
  const [dialog, setDialog] = useState<DialogKind>()
  const [toast, setToast] = useState<{ text: string; seq: number }>()
  const [busy, setBusy] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [invite, setInvite] = useState<ControllerInvite>()

  const notify = useCallback((text: string) => {
    setToast(previous => ({ text, seq: (previous?.seq ?? 0) + 1 }))
  }, [])

  const run = useCallback(async (action: () => Promise<void>, success?: string) => {
    setBusy(true)
    try {
      await action()
      if (success !== undefined) notify(success)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [notify])

  const { status, config, controllers, requests } = state
  const authorized = controllers.filter(controller => controller.status === 'authorized')
  const pending = controllers.filter(controller => controller.status === 'pending')

  return (
    <div className="dsh-mqtt-panel">
      <header className="dsh-mqtt-head">
        <div>
          <h2>{t('title')}</h2>
          <p className="dsh-mqtt-muted">{t('subtitle')}</p>
        </div>
        <span className="dsh-mqtt-live" title={state.live ? t('live') : t('polling')}>
          <StateDot state={state.live ? 'done' : 'warning'} size={8} />
          {state.live ? t('live') : t('polling')}
        </span>
      </header>

      {state.loading && <p className="dsh-mqtt-muted">{t('loading')}</p>}

      {state.authRequired && (
        <TokenPrompt
          t={t}
          value={tokenInput}
          onChange={setTokenInput}
          onSubmit={() => {
            const token = tokenInput.trim()
            if (token === '') return
            onToken?.(token)
            setTokenInput('')
            store?.retry()
          }}
        />
      )}

      {state.error !== undefined && !state.authRequired && (
        <div className="dsh-mqtt-banner dsh-mqtt-banner-error" role="alert">
          <span><strong>{t('unreachable')}</strong> {state.error}</span>
          <Button variant="outline" size="sm" onClick={() => store?.retry()}>{t('retry')}</Button>
        </div>
      )}

      {status !== undefined && (
        <Section
          title={status.display_name}
          action={
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => {
                setInviteName('')
                setInvite(undefined)
                setDialog('invite')
              }}>{t('addController')}</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void store?.refresh()}>{t('refresh')}</Button>
            </>
          }
        >
          <p className="dsh-mqtt-state">
            <StateDot state={nodeStateTone(status.state)} size={10} />
            {nodeStateLabel(status.state, t)}
          </p>
          <p className="dsh-mqtt-muted">
            {status.online ? t('brokerConnected') : t('brokerDisconnected')}
            {' · '}{t('workspacesReady', { count: readyWorkspaceCount(status) })}
            {' · '}{t('taskLoad', { active: status.active_requests, capacity: status.request_capacity })}
          </p>

          <div className="dsh-mqtt-fields">
            <Field label={t('lastHeartbeat')} value={formatTime(status.heartbeat_at, locale, t)} />
            <Field label={t('capacity')} value={`${status.active_requests} / ${status.request_capacity}`} />
            <Field label={t('gatewayVersion')} value={status.gateway_version} />
          </div>

          {status.health !== undefined && status.health.length > 0 && (
            <ul className="dsh-mqtt-list" aria-label={t('healthTitle')}>
              {status.health.map(check => (
                <li key={check.name}>
                  <StateDot state={healthTone(check.status)} size={8} />
                  <span className="dsh-mqtt-grow">{check.name}</span>
                  <span className="dsh-mqtt-muted">{check.message ?? check.status}</span>
                </li>
              ))}
            </ul>
          )}

          <Button variant="ghost" size="sm" onClick={() => setDialog('connection')}>{t('connectionTitle')}</Button>
        </Section>
      )}

      <Section title={t('controllersTitle')} count={authorized.length}>
        {pending.length > 0 && (
          <ul className="dsh-mqtt-list" aria-label={t('pendingCount', { count: pending.length })}>
            {pending.map(controller => (
              <Row
                key={controller.id}
                title={controller.name}
                subtitle={`${t('expires')} ${formatTime(controller.expiresAt, locale, t)}`}
                tone="warning"
                actions={
                  <>
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(async () => {
                      await client.authorizeController(controller.id)
                      await store?.refresh()
                    }, t('approved'))}>{t('approve')}</Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => {
                      await client.revokeController(controller.id)
                      await store?.refresh()
                    }, t('rejected'))}>{t('reject')}</Button>
                  </>
                }
              />
            ))}
          </ul>
        )}

        {authorized.length === 0 && pending.length === 0
          ? <p className="dsh-mqtt-muted">{t('controllersEmpty')}</p>
          : (
            <ul className="dsh-mqtt-list">
              {authorized.map(controller => (
                <Row
                  key={controller.id}
                  title={controller.name}
                  subtitle={`${controller.scopes.join(' · ')} — ${t('lastUsed')} ${formatTime(controller.lastUsedAt, locale, t)}`}
                  tone="done"
                  actions={
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({ controller })}>
                      {t('revoke')}
                    </Button>
                  }
                />
              ))}
            </ul>
          )}
      </Section>

      <Section title={t('historyTitle')}>
        {requests.length === 0
          ? <p className="dsh-mqtt-muted">{t('historyEmpty')}</p>
          : (
            <ul className="dsh-mqtt-list">
              {requests.map(record => (
                <Row
                  key={record.id}
                  title={record.id}
                  subtitle={[
                    requestStatusLabel(record.status, t),
                    formatTime(record.updatedAt, locale, t),
                    record.result?.error?.message,
                  ].filter(Boolean).join(' · ')}
                  tone={requestStatusTone(record.status)}
                  mono
                />
              ))}
            </ul>
          )}
      </Section>

      <Modal
        open={dialog === 'invite'}
        onClose={() => setDialog(undefined)}
        title={t('inviteTitle')}
        closeLabel={t('close')}
        description={t('inviteIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(undefined)}>{t('cancel')}</Button>
            {invite === undefined
              ? (
                <Button variant="primary" disabled={busy || inviteName.trim() === ''} onClick={() => void run(async () => {
                  const created = await client.createInvite(inviteName.trim())
                  setInvite(created)
                  await store?.refresh()
                })}>{t('inviteCreate')}</Button>
              )
              : (
                <Button variant="primary" onClick={() => void run(async () => {
                  if (config === undefined) return
                  const copied = await writeClipboard(inviteConfigText(invite, config))
                  notify(copied === false ? t('copyFailed') : t('copied'))
                })}>{t('copy')}</Button>
              )}
          </>
        }
      >
        {invite === undefined
          ? (
            <label className="dsh-mqtt-label">
              {t('inviteName')}
              <Input
                value={inviteName}
                autoFocus
                placeholder={t('invitePlaceholder')}
                onChange={event => setInviteName(event.target.value)}
              />
            </label>
          )
          : (
            <div>
              <p><strong>{t('inviteReady')}</strong> — {invite.name}</p>
              <pre className="dsh-mqtt-code">{config === undefined ? '' : inviteConfigText(invite, config)}</pre>
              <p className="dsh-mqtt-muted">{t('inviteExpiry', { time: formatClock(invite.expiresAt, locale) })}</p>
            </div>
          )}
      </Modal>

      <Modal
        open={dialog === 'connection'}
        onClose={() => setDialog(undefined)}
        title={t('connectionTitle')}
        closeLabel={t('close')}
        footer={<Button variant="primary" onClick={() => setDialog(undefined)}>{t('done')}</Button>}
      >
        <div className="dsh-mqtt-fields">
          <Field label={t('brokerUrl')} value={config?.url ?? '—'} />
          <Field label={t('namespace')} value={config?.namespace ?? '—'} />
          <Field label={t('nodeId')} value={config?.node_id ?? '—'} />
          <Field label={t('workspaces')} value={config?.workspaces.join(' · ') || t('none')} />
          <Field label={t('controllerAuth')} value={config?.controller_auth_required === true ? t('enabled') : t('disabled')} />
        </div>
        <p className="dsh-mqtt-muted">{t('privacyNote')}</p>
      </Modal>

      <Modal
        open={typeof dialog === 'object'}
        onClose={() => setDialog(undefined)}
        title={t('revoke')}
        closeLabel={t('close')}
        description={typeof dialog === 'object' ? dialog.controller.name : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(undefined)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => {
              if (typeof dialog !== 'object') return
              const { id } = dialog.controller
              setDialog(undefined)
              void run(async () => {
                await client.revokeController(id)
                await store?.refresh()
              }, t('revoked'))
            }}>{t('revoke')}</Button>
          </>
        }
      />

      {toast !== undefined && (
        <Toast key={toast.seq} text={toast.text} onDone={() => setToast(undefined)} />
      )}
    </div>
  )
}

function TokenPrompt({ t, value, onChange, onSubmit }: {
  t: Translate
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
}): JSX.Element {
  return (
    <form
      className="dsh-mqtt-banner"
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <span>
        <strong>{t('tokenPrompt')}</strong>
        <span className="dsh-mqtt-muted"> {t('tokenHint')}</span>
      </span>
      <Input
        type="password"
        value={value}
        autoFocus
        placeholder={t('tokenPlaceholder')}
        autoComplete="current-password"
        onChange={event => onChange(event.target.value)}
      />
      <Button variant="primary" size="sm" type="submit" disabled={value.trim() === ''}>{t('connect')}</Button>
    </form>
  )
}
