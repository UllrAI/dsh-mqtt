/**
 * Standalone management page.
 *
 * The fallback form for headless or remote deployments where the DSH web shell
 * is not in front of the operator. Same core, same panel, same copy — this
 * module only supplies what the shell would otherwise provide: a React root,
 * the design tokens, and a locale.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ManagementClient } from '../core/api.ts'
import { createTranslate } from '../core/i18n.ts'
import { WorkerPanel } from '../ui/WorkerPanel.tsx'
import { injectStyles } from '../ui/injectStyles.ts'
import { PANEL_CSS } from '../ui/styles.ts'
import { THEME_CSS } from './theme.ts'

const TOKEN_KEY = 'dsh-mqtt:management-token'

function readToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Storage-denying browsers still get a working page for this render.
  }
}

injectStyles(THEME_CSS, 'dsh-mqtt/theme.css')
injectStyles(PANEL_CSS)

const locale = navigator.language
const client = new ManagementClient({ baseUrl: '/api', token: readToken })

const container = document.querySelector('#root')
if (container === null) throw new Error('dsh-mqtt: missing #root container')

document.documentElement.lang = locale
createRoot(container).render(
  <StrictMode>
    <div className="dsh-mqtt-standalone">
      <WorkerPanel
        client={client}
        t={createTranslate(locale)}
        locale={locale}
        onToken={writeToken}
      />
    </div>
  </StrictMode>,
)
