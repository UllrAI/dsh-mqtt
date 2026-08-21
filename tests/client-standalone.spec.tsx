// @vitest-environment jsdom

/**
 * The standalone page bootstrap.
 *
 * It only does what the DSH shell would otherwise do — mount a root, supply the
 * design tokens, pick a locale — so that is what these check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en, zh } from '../src/client/core/i18n.ts'

async function boot(): Promise<void> {
  vi.resetModules()
  await import('../src/client/standalone/main.tsx')
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="root"></div>'
  sessionStorage.clear()
  localStorage.clear()
  // No gateway in the test process; the panel renders its error path.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('standalone page', () => {
  it('mounts the panel and supplies the tokens no theme plugin is here to give', async () => {
    await boot()

    expect(await screen.findByText(en.title)).toBeDefined()

    const sheets = [...document.head.querySelectorAll('style[data-plugin-css]')]
    expect(sheets.map(sheet => sheet.getAttribute('data-plugin-css')))
      .toEqual(['dsh-mqtt/theme.css', 'dsh-mqtt/panel.css'])
    // Every token the panel stylesheet reads has to come from somewhere.
    expect(sheets[0]?.textContent).toContain('--dsw-')
  })

  it('opens in the language the browser asked for', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    await boot()

    expect(await screen.findByText(zh.subtitle)).toBeDefined()
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
  })

  it('switches language on demand and remembers the choice', async () => {
    vi.stubGlobal('navigator', { language: 'en-US' })
    await boot()
    expect(await screen.findByText(en.subtitle)).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: en.language }))
    await userEvent.click(await screen.findByText('中文'))

    expect(await screen.findByText(zh.subtitle)).toBeDefined()
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'))
    // A language choice is a preference, not a credential, so it may persist.
    expect(localStorage.getItem('dsh-mqtt:locale')).toBe('zh')

    // The browser still says English; the stored choice has to outrank it.
    await boot()
    expect(await screen.findByText(zh.subtitle)).toBeDefined()
  })

  it('fails loudly when the host page has no mount point', async () => {
    document.body.innerHTML = ''

    await expect(boot()).rejects.toThrow(/missing #root/)
  })
})
