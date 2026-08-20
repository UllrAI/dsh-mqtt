// @vitest-environment jsdom

/**
 * The DSH client entry.
 *
 * What matters here is the contract with the shell: the right cordis services,
 * one `settings.section` registration that appends rather than replaces, a label
 * thunk that re-reads on every projection, and a token that never outlives the
 * tab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { en, zh } from '../src/client/core/i18n.ts'

const TOKEN_KEY = 'dsh-mqtt:management-token'

interface Registration {
  name: string
  id: string
  order: number
  label: () => string
  locale: string
  registrant: string
  inject: () => { client: { baseUrl: string; token: string | undefined }; onToken: (token: string) => void }
}

function fakeContext() {
  const registrations: Array<{ options: Registration; component: (props: never) => JSX.Element }> = []
  const locales: Array<[string, unknown]> = []
  const bind = vi.fn((namespace: string) => (key: string) => `${namespace}.${key}`)
  const ctx = {
    effect: vi.fn((setup: () => unknown) => setup()),
    locale: { register: vi.fn((ns: string, table: unknown) => { locales.push([ns, table]) }), bind },
    slots: {
      // The real service defers registration until the slot exists; running it
      // straight through is enough to observe what gets registered.
      inject: vi.fn((_name: string, run: () => void) => run()),
      register: vi.fn((options: Registration, component: (props: never) => JSX.Element) => {
        registrations.push({ options, component })
      }),
    },
  }
  return { ctx, registrations, locales, bind }
}

/** The module injects styles and reads globals on import, so reload it per test. */
async function loadEntry() {
  vi.resetModules()
  return import('../src/client/index.tsx')
}

beforeEach(() => {
  sessionStorage.clear()
  document.head.innerHTML = ''
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (globalThis as { DSH_MQTT_MANAGEMENT_URL?: unknown }).DSH_MQTT_MANAGEMENT_URL
})

describe('client entry', () => {
  it('waits for the services it calls into', async () => {
    const { inject } = await loadEntry()
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('injects the panel stylesheet exactly once per document', async () => {
    await loadEntry()
    await loadEntry()

    const styles = document.head.querySelectorAll('style[data-plugin-css]')
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toContain('--dsw-')
  })

  it('appends a settings section beside the shipped ones', async () => {
    const { apply, LOCALE_NS } = await loadEntry()
    const { ctx, registrations, bind } = fakeContext()

    apply(ctx as never)

    expect(registrations).toHaveLength(1)
    const { options } = registrations[0] as (typeof registrations)[number]
    // A fresh id is what makes this an append; reusing a shipped id would
    // replace `general` or `models`.
    expect(options).toMatchObject({ name: 'settings.section', id: 'dsh-mqtt', locale: LOCALE_NS })
    expect(['general', 'models', 'plugins', 'agent-presets']).not.toContain(options.id)

    // A thunk, not a string: the shell re-reads it when the language changes.
    expect(options.label()).toBe(`${LOCALE_NS}.nav`)
    expect(bind).toHaveBeenCalledWith(LOCALE_NS)
  })

  it('registers both languages under its own namespace', async () => {
    const { apply, LOCALE_NS } = await loadEntry()
    const { ctx, locales } = fakeContext()

    apply(ctx as never)

    expect(locales).toEqual([[LOCALE_NS, { zh, en }]])
    // Registered through `effect`, so a reload tears the table back down.
    expect(ctx.effect).toHaveBeenCalledWith(expect.any(Function), 'dsh-mqtt: locale')
  })

  it('points at the gateway port, or wherever the deployment moved it', async () => {
    const { apply } = await loadEntry()
    const { ctx, registrations } = fakeContext()
    apply(ctx as never)
    expect((registrations[0] as (typeof registrations)[number]).options.inject().client.baseUrl)
      .toBe('http://127.0.0.1:3210/api')

    Object.assign(globalThis, { DSH_MQTT_MANAGEMENT_URL: 'https://worker.internal/api' })
    const moved = fakeContext()
    ;(await loadEntry()).apply(moved.ctx as never)
    expect((moved.registrations[0] as (typeof registrations)[number]).options.inject().client.baseUrl)
      .toBe('https://worker.internal/api')
  })

  it('keeps the management token in the tab, not on the disk', async () => {
    const { apply } = await loadEntry()
    const { ctx, registrations } = fakeContext()
    apply(ctx as never)
    const { client, onToken } = (registrations[0] as (typeof registrations)[number]).options.inject()

    expect(client.token).toBeUndefined()
    onToken('management-secret')

    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('management-secret')
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    // Read per request, so the panel picks it up without a re-render.
    expect(client.token).toBe('management-secret')
  })

  it('still renders where storage is denied', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    const { apply } = await loadEntry()
    const { ctx, registrations } = fakeContext()
    apply(ctx as never)
    const { client, onToken } = (registrations[0] as (typeof registrations)[number]).options.inject()

    expect(() => onToken('management-secret')).not.toThrow()
    expect(client.token).toBeUndefined()
  })

  it('renders the panel with the props the slot owner supplies', async () => {
    // No gateway is listening in the test process; the panel handles that.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))
    const { apply } = await loadEntry()
    const { ctx, registrations } = fakeContext()
    apply(ctx as never)
    const { component, options } = registrations[0] as (typeof registrations)[number]
    const { client, onToken } = options.inject()

    const t = (key: keyof typeof en): string => en[key]
    render(component({ client, onToken, t, close: () => undefined } as never))

    expect(await screen.findByText(en.title)).toBeDefined()
    expect(await screen.findByRole('alert')).toBeDefined()
  })
})
