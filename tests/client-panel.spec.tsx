// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ManagementClient, NodeStatus } from '../src/client/core/api.ts'
import { ManagementApiError } from '../src/client/core/api.ts'
import { createTranslate, en } from '../src/client/core/i18n.ts'
import { WorkerPanel } from '../src/client/ui/WorkerPanel.tsx'

const t = createTranslate('en')

const status: NodeStatus = {
  timestamp: '2026-03-05T14:30:00.000Z',
  heartbeat_at: '2026-03-05T14:30:00.000Z',
  node_id: 'worker',
  display_name: 'Build worker',
  state: 'ready',
  online: true,
  gateway_version: '0.1.2',
  capabilities: ['code'],
  workspaces: [{ alias: 'app', status: 'ready' }],
  active_requests: 1,
  request_capacity: 4,
  controller_auth_required: true,
  health: [
    { name: 'broker', status: 'ready' },
    { name: 'agent', status: 'degraded', message: 'reconnecting' },
  ],
}

const config = {
  url: 'mqtt://broker.test:1883',
  namespace: 'team',
  node_id: 'worker',
  display_name: 'Build worker',
  default_workspace: 'app',
  workspaces: ['app'],
  capabilities: ['code'],
  controller_auth_required: true,
}

function stubClient(overrides: Record<string, unknown> = {}): ManagementClient {
  return {
    baseUrl: 'http://gateway.test/api',
    token: undefined,
    status: vi.fn().mockResolvedValue(status),
    config: vi.fn().mockResolvedValue(config),
    controllers: vi.fn().mockResolvedValue([]),
    requests: vi.fn().mockResolvedValue([]),
    createInvite: vi.fn(),
    authorizeController: vi.fn().mockResolvedValue(undefined),
    revokeController: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ManagementClient
}

function panel(client: ManagementClient, onToken: (token: string) => void = () => undefined) {
  return render(<WorkerPanel client={client} t={t} locale="en-US" onToken={onToken} />)
}

beforeEach(() => {
  // The panel opens an SSE stream on mount; jsdom has no EventSource.
  vi.stubGlobal('EventSource', undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WorkerPanel', () => {
  it('shows node state, load, and health once the gateway answers', async () => {
    panel(stubClient())

    expect(await screen.findByText(en.stateReady)).toBeDefined()
    expect(screen.getByText('Build worker')).toBeDefined()
    expect(screen.getByText(/1 of 4 task slots in use/)).toBeDefined()
    expect(screen.getByText(/1 workspaces ready/)).toBeDefined()
    expect(screen.getByText('0.1.2')).toBeDefined()

    const health = screen.getByRole('list', { name: en.healthTitle })
    expect(within(health).getByText('broker')).toBeDefined()
    // A check with a message shows the message, not the bare status.
    expect(within(health).getByText('reconnecting')).toBeDefined()
  })

  it('omits the health list when the gateway reports no checks', async () => {
    const { health, ...withoutHealth } = status
    void health
    panel(stubClient({ status: vi.fn().mockResolvedValue(withoutHealth) }))

    await screen.findByText(en.stateReady)
    expect(screen.queryByRole('list', { name: en.healthTitle })).toBeNull()
  })

  it('says so when the broker connection is down', async () => {
    panel(stubClient({ status: vi.fn().mockResolvedValue({ ...status, online: false, state: 'degraded' }) }))

    expect(await screen.findByText(en.stateDegraded)).toBeDefined()
    expect(screen.getByText(new RegExp(en.brokerDisconnected))).toBeDefined()
  })

  it('reloads on demand', async () => {
    const client = stubClient()
    panel(client)
    await screen.findByText(en.stateReady)
    const before = vi.mocked(client.status).mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: en.refresh }))

    await waitFor(() => expect(vi.mocked(client.status).mock.calls.length).toBeGreaterThan(before))
  })

  it('keeps every pending controller reachable, not just the first', async () => {
    const authorizeController = vi.fn().mockResolvedValue(undefined)
    const controllers = vi.fn().mockResolvedValue([
      { id: 'c1', name: 'Laptop', scopes: ['submit'], status: 'pending', createdAt: 1, updatedAt: 1, expiresAt: 2 },
      { id: 'c2', name: 'Desktop', scopes: ['submit'], status: 'pending', createdAt: 1, updatedAt: 1, expiresAt: 2 },
      { id: 'c3', name: 'CI', scopes: ['submit', 'control'], status: 'authorized', createdAt: 1, updatedAt: 1, expiresAt: 2 },
    ])
    panel(stubClient({ controllers, authorizeController }))

    const pending = await screen.findByRole('list', { name: '2 waiting for approval' })
    const rows = within(pending).getAllByRole('listitem')
    expect(rows.map(row => within(row).getByText(/Laptop|Desktop|CI/).textContent)).toEqual(['Laptop', 'Desktop'])

    // The second one, specifically — the old prototype only wired up index 0.
    await userEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: en.approve }))

    expect(authorizeController).toHaveBeenCalledWith('c2')
    expect(await screen.findByText(en.approved)).toBeDefined()
  })

  it('rejects a pending controller without touching the authorized list', async () => {
    const revokeController = vi.fn().mockResolvedValue(undefined)
    panel(stubClient({
      revokeController,
      controllers: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'Laptop', scopes: ['submit'], status: 'pending', createdAt: 1, updatedAt: 1, expiresAt: 2 },
      ]),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.reject }))

    expect(revokeController).toHaveBeenCalledWith('c1')
    expect(await screen.findByText(en.rejected)).toBeDefined()
  })

  it('confirms before revoking an authorized controller', async () => {
    const revokeController = vi.fn().mockResolvedValue(undefined)
    panel(stubClient({
      revokeController,
      controllers: vi.fn().mockResolvedValue([
        { id: 'c9', name: 'CI runner', scopes: ['submit'], status: 'authorized', createdAt: 1, updatedAt: 1, expiresAt: 2, lastUsedAt: 3 },
      ]),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.revoke }))
    expect(revokeController).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('CI runner')).toBeDefined()
    await userEvent.click(within(dialog).getByRole('button', { name: en.revoke }))

    expect(revokeController).toHaveBeenCalledWith('c9')
    expect(await screen.findByText(en.revoked)).toBeDefined()
  })

  it('leaves the controller alone when the revoke is called off', async () => {
    const revokeController = vi.fn()
    panel(stubClient({
      revokeController,
      controllers: vi.fn().mockResolvedValue([
        { id: 'c9', name: 'CI runner', scopes: ['submit'], status: 'authorized', createdAt: 1, updatedAt: 1, expiresAt: 2 },
      ]),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.revoke }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: en.cancel }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(revokeController).not.toHaveBeenCalled()
  })

  it('lists task history with status and failure reason', async () => {
    panel(stubClient({
      requests: vi.fn().mockResolvedValue([
        { id: 'req-1', status: 'completed', createdAt: 1, updatedAt: 2 },
        {
          id: 'req-2',
          status: 'failed',
          createdAt: 1,
          updatedAt: 2,
          result: { error: { code: 'AGENT_ERROR', message: 'the build broke' } },
        },
      ]),
    }))

    expect(await screen.findByText('req-1')).toBeDefined()
    expect(screen.getByText(new RegExp(en.statusFailed))).toBeDefined()
    expect(screen.getByText(/the build broke/)).toBeDefined()
    expect(screen.queryByText(en.historyEmpty)).toBeNull()
  })

  it('shows the empty states when the worker has no controllers or tasks', async () => {
    panel(stubClient())

    expect(await screen.findByText(en.controllersEmpty)).toBeDefined()
    expect(screen.getByText(en.historyEmpty)).toBeDefined()
  })

  it('creates an invite, then copies a config that carries no broker password', async () => {
    const createInvite = vi.fn().mockResolvedValue({
      id: 'c1',
      name: 'Laptop',
      token: 'invite-secret',
      scopes: ['submit', 'control'],
      expiresAt: Date.parse('2026-03-05T14:40:00.000Z'),
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    panel(stubClient({ createInvite }))

    await userEvent.click(await screen.findByRole('button', { name: en.addController }))
    const dialog = await screen.findByRole('dialog')

    const create = within(dialog).getByRole('button', { name: en.inviteCreate })
    expect(create.hasAttribute('disabled')).toBe(true)

    await userEvent.type(within(dialog).getByRole('textbox'), 'Laptop')
    await userEvent.click(create)

    expect(createInvite).toHaveBeenCalledWith('Laptop')
    expect(await within(dialog).findByText(en.inviteReady)).toBeDefined()

    await userEvent.click(within(dialog).getByRole('button', { name: en.copy }))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const copied = JSON.parse(String(writeText.mock.calls[0]?.[0]))
    expect(copied).toMatchObject({ controller_id: 'c1', token: 'invite-secret', broker_url: config.url })
    expect(JSON.stringify(copied)).not.toContain('password')
    expect(await screen.findByText(en.copied)).toBeDefined()
  })

  it('reports a clipboard that refuses instead of silently doing nothing', async () => {
    const createInvite = vi.fn().mockResolvedValue({
      id: 'c1', name: 'Laptop', token: 'x', scopes: [], expiresAt: Date.now(),
    })
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    panel(stubClient({ createInvite }))

    await userEvent.click(await screen.findByRole('button', { name: en.addController }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox'), 'Laptop')
    await userEvent.click(within(dialog).getByRole('button', { name: en.inviteCreate }))
    await userEvent.click(await within(dialog).findByRole('button', { name: en.copy }))

    expect(await screen.findByText(en.copyFailed)).toBeDefined()
  })

  it('withholds the invite config while the broker details are unknown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    panel(stubClient({
      config: vi.fn().mockRejectedValue(new ManagementApiError('HTTP 500', 500)),
      createInvite: vi.fn().mockResolvedValue({
        id: 'c1', name: 'Laptop', token: 'x', scopes: [], expiresAt: Date.now(),
      }),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.addController }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox'), 'Laptop')
    await userEvent.click(within(dialog).getByRole('button', { name: en.inviteCreate }))
    await within(dialog).findByText(en.inviteReady)

    // A half-written config would look valid and fail on the controller.
    expect(dialog.querySelector('.dsh-mqtt-code')?.textContent).toBe('')
    await userEvent.click(within(dialog).getByRole('button', { name: en.copy }))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('lets the user back out of the invite dialog', async () => {
    const createInvite = vi.fn()
    panel(stubClient({ createInvite }))

    await userEvent.click(await screen.findByRole('button', { name: en.addController }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: en.cancel }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(createInvite).not.toHaveBeenCalled()
  })

  it('surfaces a failed action instead of leaving the panel stuck', async () => {
    panel(stubClient({
      createInvite: vi.fn().mockRejectedValue(new ManagementApiError('invite quota reached', 429)),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.addController }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox'), 'Laptop')
    await userEvent.click(within(dialog).getByRole('button', { name: en.inviteCreate }))

    expect(await screen.findByText('invite quota reached')).toBeDefined()
    // Still interactive: the button came back out of its busy state.
    await waitFor(() => {
      expect(within(dialog).getByRole('button', { name: en.inviteCreate }).hasAttribute('disabled')).toBe(false)
    })
  })

  it('shows only non-sensitive values in the advanced dialog', async () => {
    panel(stubClient())

    await userEvent.click(await screen.findByRole('button', { name: en.connectionTitle }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText(config.url)).toBeDefined()
    expect(within(dialog).getByText('team')).toBeDefined()
    expect(within(dialog).getByText(en.enabled)).toBeDefined()
    expect(within(dialog).getByText(en.privacyNote)).toBeDefined()

    await userEvent.click(within(dialog).getByRole('button', { name: en.done }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes a dialog on Escape', async () => {
    panel(stubClient({
      controllers: vi.fn().mockResolvedValue([
        { id: 'c9', name: 'CI runner', scopes: ['submit'], status: 'authorized', createdAt: 1, updatedAt: 1, expiresAt: 2 },
      ]),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.revoke }))
    await screen.findByRole('dialog')

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('dismisses a toast once it has been read', async () => {
    panel(stubClient({
      controllers: vi.fn().mockResolvedValue([
        { id: 'c1', name: 'Laptop', scopes: ['submit'], status: 'pending', createdAt: 1, updatedAt: 1, expiresAt: 2 },
      ]),
    }))

    await userEvent.click(await screen.findByRole('button', { name: en.approve }))
    expect(await screen.findByText(en.approved)).toBeDefined()

    // The primitive fades itself out and reports done; the panel must unmount it.
    await waitFor(() => expect(screen.queryByText(en.approved)).toBeNull(), { timeout: 5_000 })
  })

  it('prompts for a token and retries with it', async () => {
    const onToken = vi.fn()
    const unauthorized = (): Promise<never> =>
      Promise.reject(new ManagementApiError('management authorization required', 401))
    const statusFn = vi.fn().mockImplementationOnce(unauthorized).mockResolvedValue(status)
    panel(stubClient({
      status: statusFn,
      config: vi.fn().mockImplementation(unauthorized),
      controllers: vi.fn().mockImplementation(unauthorized),
      requests: vi.fn().mockImplementation(unauthorized),
    }), onToken)

    expect(await screen.findByText(en.tokenPrompt)).toBeDefined()
    // A token prompt is not a transport error; showing both would be noise.
    expect(screen.queryByText(en.unreachable)).toBeNull()

    const connect = screen.getByRole('button', { name: en.connect })
    expect(connect.hasAttribute('disabled')).toBe(true)

    await userEvent.type(screen.getByPlaceholderText(en.tokenPlaceholder), '  secret  ')
    await userEvent.click(connect)

    expect(onToken).toHaveBeenCalledWith('secret')
  })

  it('offers a retry when the gateway is unreachable', async () => {
    const status = vi.fn().mockRejectedValue(new ManagementApiError('Failed to fetch', 0))
    panel(stubClient({ status }))

    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText(/Failed to fetch/)).toBeDefined()
    const callsBeforeRetry = status.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: en.retry }))

    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(callsBeforeRetry))
  })

  it('reports the live channel when the stream is open', async () => {
    class OpenEventSource {
      onopen: (() => void) | undefined
      addEventListener(): void {}
      close(): void {}
      constructor() {
        queueMicrotask(() => this.onopen?.())
      }
    }
    vi.stubGlobal('EventSource', OpenEventSource)
    panel(stubClient())

    expect(await screen.findByTitle(en.live)).toBeDefined()
  })

  it('falls back to polling where the stream cannot be held open', async () => {
    panel(stubClient())

    expect(await screen.findByTitle(en.polling)).toBeDefined()
  })
})
