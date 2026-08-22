/**
 * The MQTT worker management panel.
 *
 * Rendered by both UI forms: as a `settings.section` inside DSH, and as the
 * whole page of the standalone server. Styling comes from `--dsw-*` tokens, so
 * the panel follows the shell's theme without a stylesheet of its own.
 */

import { useCallback, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { isRequestActive, type Controller, type ControllerInvite, type ManagementClient, type RequestRecord } from '../core/api.ts'
import type { Translate } from '../core/i18n.ts'
import {
  controllerName,
  formatClock,
  formatDuration,
  formatTime,
  healthDetail,
  healthLabel,
  healthTone,
  inviteConfigText,
  nodeStateLabel,
  nodeStateTone,
  requestStatusLabel,
  requestStatusTone,
  workspacesLabel,
} from '../core/format.ts'
import { useManagementStore } from './useManagementStore.ts'
import { Field, Fields, Row, Section } from './parts.tsx'

export interface WorkerPanelProps {
  client: ManagementClient
  t: Translate
  locale: string
  /** Called with a token the user supplied for a gateway that requires one. */
  onToken?: (token: string) => void
  /**
   * Extra header control.
   *
   * The standalone page puts its language switch here; inside DSH the shell
   * already owns that preference, so the panel leaves the slot empty.
   */
  headerAction?: ReactNode
}

type DialogKind = 'invite' | 'invite-discard' | 'connection' | { controller: Controller } | { request: RequestRecord }

export function WorkerPanel({ client, t, locale, onToken, headerAction }: WorkerPanelProps): JSX.Element {
  const { state, store } = useManagementStore(client)
  const [dialog, setDialog] = useState<DialogKind>()
  const [toast, setToast] = useState<{ text: string; seq: number }>()
  const [pendingAction, setPendingAction] = useState<string>()
  const [tokenInput, setTokenInput] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [invite, setInvite] = useState<ControllerInvite>()
  const [inviteApproved, setInviteApproved] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)

  const notify = useCallback((text: string) => {
    setToast(previous => ({ text, seq: (previous?.seq ?? 0) + 1 }))
  }, [])

  /**
   * One action at a time, but only the invoked control shows it. `key` identifies
   * the control so a row's own button reports progress instead of the whole panel
   * greying out.
   */
  const run = useCallback(async (key: string, action: () => Promise<void>, success?: string) => {
    setPendingAction(key)
    try {
      await action()
      if (success !== undefined) notify(success)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(undefined)
    }
  }, [notify])

  /**
   * Leave the invite dialog.
   *
   * The token is only ever in the browser's hands once, so closing on an
   * uncopied config asks first — a stray Escape would otherwise cost the
   * operator a controller they have to issue again.
   */
  const leaveInvite = useCallback(() => {
    setDialog(invite !== undefined && !inviteCopied ? 'invite-discard' : undefined)
  }, [invite, inviteCopied])

  const { status, config, controllers, requests } = state
  const authorized = controllers.filter(controller => controller.status === 'authorized')
  const pending = controllers.filter(controller => controller.status === 'pending')
  const revoking = typeof dialog === 'object' && 'controller' in dialog ? dialog.controller : undefined
  const detail = typeof dialog === 'object' && 'request' in dialog ? dialog.request : undefined

  return (
    <div className="dsh-mqtt-panel">
      <header className="dsh-mqtt-head">
        <div>
          <h2>{t('title')}</h2>
          <p className="dsh-mqtt-muted">{t('subtitle')}</p>
        </div>
        <div className="dsh-mqtt-head-aside">
          <span className="dsh-mqtt-live" title={state.live ? t('live') : t('polling')}>
            <StateDot state={state.live ? 'done' : 'warning'} size={8} />
            {state.live ? t('live') : t('polling')}
          </span>
          {headerAction}
        </div>
      </header>

      {state.loading && <p className="dsh-mqtt-muted">{t('loading')}</p>}

      {state.authRequired && (
        <TokenPrompt
          t={t}
          value={tokenInput}
          rejected={state.tokenRejected}
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
              <Button variant="primary" size="sm" onClick={() => {
                setInviteName('')
                setInvite(undefined)
                setInviteApproved(false)
                setInviteCopied(false)
                setDialog('invite')
              }}>{t('addController')}</Button>
              <Button variant="outline" size="sm" onClick={() => void store?.refresh()}>{t('refresh')}</Button>
            </>
          }
        >
          <p className="dsh-mqtt-state">
            <StateDot state={nodeStateTone(status.state)} size={10} />
            {nodeStateLabel(status.state, t)}
          </p>
          <p className="dsh-mqtt-muted">
            {status.online ? t('brokerConnected') : t('brokerDisconnected')}
            {' · '}{workspacesLabel(status, t)}
            {' · '}{t('taskLoad', { active: status.active_requests, capacity: status.request_capacity })}
          </p>

          <Fields>
            <Field label={t('lastHeartbeat')} value={formatTime(status.heartbeat_at, locale, t('noHeartbeat'))} />
            <Field label={t('capacity')} value={`${status.active_requests} / ${status.request_capacity}`} />
            <Field label={t('gatewayVersion')} value={status.gateway_version} />
          </Fields>

          {status.health !== undefined && status.health.length > 0 && (
            <ul className="dsh-mqtt-list" aria-label={t('healthTitle')}>
              {status.health.map(check => (
                <li key={check.name}>
                  <StateDot state={healthTone(check.status)} size={8} />
                  <span className="dsh-mqtt-grow">{healthLabel(check.name, t)}</span>
                  <span className="dsh-mqtt-muted">{healthDetail(check, t)}</span>
                </li>
              ))}
            </ul>
          )}

          <Button variant="ghost" size="sm" onClick={() => setDialog('connection')}>{t('connectionTitle')}</Button>
        </Section>
      )}

      <Section title={t('controllersTitle')} count={authorized.length}>
        {pending.length > 0 && (
          // The section count covers approved controllers only, so name the
          // pending rows rather than leaving them to contradict it.
          <>
            <p className="dsh-mqtt-subhead" id="dsh-mqtt-pending">{t('pendingCount', { count: pending.length })}</p>
            <ul className="dsh-mqtt-list" aria-labelledby="dsh-mqtt-pending">
            {pending.map(controller => (
              <Row
                key={controller.id}
                title={controller.name}
                subtitle={`${t('expires')} ${formatTime(controller.expiresAt, locale, t('noExpiry'))}`}
                tone="warning"
                actions={
                  <>
                    <Button variant="primary" size="sm" disabled={pendingAction === `approve:${controller.id}`} onClick={() => void run(`approve:${controller.id}`, async () => {
                      await client.authorizeController(controller.id)
                      await store?.refresh()
                    }, t('approved'))}>{t('approve')}</Button>
                    <Button variant="outline" size="sm" disabled={pendingAction === `reject:${controller.id}`} onClick={() => void run(`reject:${controller.id}`, async () => {
                      await client.revokeController(controller.id)
                      await store?.refresh()
                    }, t('rejected'))}>{t('reject')}</Button>
                  </>
                }
              />
            ))}
            </ul>
          </>
        )}

        {authorized.length === 0 && pending.length === 0
          ? <p className="dsh-mqtt-muted">{t('controllersEmpty')}</p>
          : (
            <ul className="dsh-mqtt-list">
              {authorized.map(controller => (
                <Row
                  key={controller.id}
                  title={controller.name}
                  subtitle={`${controller.scopes.join(' · ')} — ${t('lastUsed')} ${formatTime(controller.lastUsedAt, locale, t('neverUsed'))}`}
                  tone="done"
                  actions={
                    <Button variant="outline" size="sm" onClick={() => setDialog({ controller })}>
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
                  title={record.result?.summary ?? record.id}
                  // A failure reason is the one detail worth reading without a
                  // click; everything else waits in the detail dialog.
                  subtitle={[
                    requestStatusLabel(record.status, t),
                    formatTime(record.updatedAt, locale, t('unknownTime')),
                    record.result?.error?.message,
                  ].filter(Boolean).join(' · ')}
                  tone={requestStatusTone(record.status)}
                  mono={record.result?.summary === undefined}
                  actions={
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setDialog({ request: record })}>
                        {t('taskDetail')}
                      </Button>
                      {isRequestActive(record) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pendingAction === `cancel:${record.id}` || record.cancelRequested === true}
                          onClick={() => void run(`cancel:${record.id}`, async () => {
                            await client.cancelRequest(record.id)
                            await store?.refresh()
                          }, t('stopRequested'))}
                        >
                          {record.cancelRequested === true ? t('stopping') : t('stop')}
                        </Button>
                      )}
                    </>
                  }
                />
              ))}
            </ul>
          )}
      </Section>

      <Modal
        open={dialog === 'invite'}
        onClose={leaveInvite}
        title={t('inviteTitle')}
        closeLabel={t('close')}
        description={t('inviteIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={leaveInvite}>{invite === undefined ? t('cancel') : t('inviteSaved')}</Button>
            {invite === undefined
              ? (
                <Button variant="primary" disabled={pendingAction === 'invite:create' || inviteName.trim() === ''} onClick={() => void run('invite:create', async () => {
                  const created = await client.createInvite(inviteName.trim())
                  setInvite(created)
                  await store?.refresh()
                })}>{t('inviteCreate')}</Button>
              )
              : (
                <>
                  {/* Approving here is the same decision the list would ask for,
                      made by the same operator who just issued the invite. */}
                  <Button variant="outline" disabled={pendingAction === 'invite:approve' || inviteApproved} onClick={() => void run('invite:approve', async () => {
                    await client.authorizeController(invite.id)
                    setInviteApproved(true)
                    await store?.refresh()
                  }, t('approved'))}>{inviteApproved ? t('approved') : t('approve')}</Button>
                  <Button variant="primary" onClick={() => void run('invite:copy', async () => {
                    if (config === undefined) return
                    const copied = await writeClipboard(inviteConfigText(invite, config))
                    // A failed copy leaves the operator with nothing, so the
                    // close guard stays armed until one actually lands.
                    if (copied !== false) setInviteCopied(true)
                    notify(copied === false ? t('copyFailed') : t('copied'))
                  })}>{t('copy')}</Button>
                </>
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
              <p className="dsh-mqtt-warning">{t('inviteOnce')}</p>
              {!inviteApproved && <p className="dsh-mqtt-muted">{t('inviteApproveHint')}</p>}
            </div>
          )}
      </Modal>

      <Modal
        open={dialog === 'invite-discard'}
        onClose={() => setDialog('invite')}
        title={t('inviteDiscard')}
        closeLabel={t('close')}
        description={t('inviteDiscardIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog('invite')}>{t('cancel')}</Button>
            <Button variant="primary" className="dsh-mqtt-danger" onClick={() => setDialog(undefined)}>
              {t('inviteDiscardConfirm')}
            </Button>
          </>
        }
      />

      <Modal
        open={dialog === 'connection'}
        onClose={() => setDialog(undefined)}
        title={t('connectionTitle')}
        closeLabel={t('close')}
        footer={<Button variant="primary" onClick={() => setDialog(undefined)}>{t('done')}</Button>}
      >
        <Fields>
          <Field label={t('brokerUrl')} value={config?.url ?? '—'} />
          <Field label={t('namespace')} value={config?.namespace ?? '—'} />
          <Field label={t('nodeId')} value={config?.node_id ?? '—'} />
          <Field label={t('workspaces')} value={config?.workspaces.join(' · ') || t('none')} />
          <Field label={t('controllerAuth')} value={config?.controller_auth_required === true ? t('enabled') : t('disabled')} />
        </Fields>
        {config?.controller_auth_required === false && <p className="dsh-mqtt-warning">{t('controllerAuthOffNote')}</p>}
        <p className="dsh-mqtt-muted">{t('privacyNote')}</p>
      </Modal>

      <Modal
        open={detail !== undefined}
        onClose={() => setDialog(undefined)}
        title={t('taskDetail')}
        closeLabel={t('close')}
        footer={<Button variant="primary" onClick={() => setDialog(undefined)}>{t('done')}</Button>}
      >
        {detail !== undefined && (
          <>
            <Fields>
              <Field label={t('taskStarted')} value={formatTime(detail.createdAt, locale, t('unknownTime'))} />
              <Field label={t('taskDuration')} value={formatDuration(detail.updatedAt - detail.createdAt, t)} />
              <Field label={t('taskWorkspace')} value={detail.workspace ?? '—'} />
              <Field
                label={t('taskController')}
                value={controllerName(detail.controllerId, controllers) ?? t('taskUnknownController')}
              />
            </Fields>
            {detail.result?.summary !== undefined && (
              <p className="dsh-mqtt-label">
                {t('taskSummary')}
                <span>{detail.result.summary}</span>
              </p>
            )}
            {detail.result?.error !== undefined && (
              <p className="dsh-mqtt-label">
                {t('taskError')}
                <span>{detail.result.error.message}</span>
              </p>
            )}
            <pre className="dsh-mqtt-code">{detail.id}</pre>
          </>
        )}
      </Modal>

      <Modal
        open={revoking !== undefined}
        onClose={() => setDialog(undefined)}
        title={revoking === undefined ? t('revoke') : t('revokeTitle', { name: revoking.name })}
        closeLabel={t('close')}
        description={t('revokeIntro')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(undefined)}>{t('cancel')}</Button>
            <Button
              variant="primary"
              className="dsh-mqtt-danger"
              disabled={pendingAction !== undefined}
              onClick={() => {
                if (revoking === undefined) return
                const { id } = revoking
                setDialog(undefined)
                void run(`controller:revoke:${id}`, async () => {
                  await client.revokeController(id)
                  await store?.refresh()
                }, t('revoked'))
              }}
            >
              {t('revoke')}
            </Button>
          </>
        }
      />

      {toast !== undefined && (
        <Toast key={toast.seq} text={toast.text} onDone={() => setToast(undefined)} />
      )}
    </div>
  )
}

function TokenPrompt({ t, value, rejected, onChange, onSubmit }: {
  t: Translate
  value: string
  /** A token was sent and refused, as opposed to none having been supplied yet. */
  rejected: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}): JSX.Element {
  return (
    <form
      className={rejected ? 'dsh-mqtt-banner dsh-mqtt-banner-error' : 'dsh-mqtt-banner'}
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <span>
        <strong>{t('tokenPrompt')}</strong>
        <span className="dsh-mqtt-muted"> {rejected ? t('tokenRejected') : t('tokenHint')}</span>
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
