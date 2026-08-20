// @vitest-environment jsdom

/**
 * The standalone page bootstrap.
 *
 * It only does what the DSH shell would otherwise do — mount a root, supply the
 * design tokens, pick a locale — so that is what these check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { en } from '../src/client/core/i18n.ts'

async function boot(): Promise<void> {
  vi.resetModules()
  await import('../src/client/standalone/main.tsx')
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="root"></div>'
  sessionStorage.clear()
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

  it('tells the browser which language the page is in', async () => {
    await boot()

    await waitFor(() => expect(document.documentElement.lang).toBe(navigator.language))
  })

  it('fails loudly when the host page has no mount point', async () => {
    document.body.innerHTML = ''

    await expect(boot()).rejects.toThrow(/missing #root/)
  })
})
