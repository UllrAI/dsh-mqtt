/**
 * Standalone management page.
 *
 * The fallback form for headless or remote deployments where the DSH web shell
 * is not in front of the operator. Same core, same panel, same copy — this
 * module only supplies what the shell would otherwise provide: a React root,
 * the design tokens, and a language.
 */

import { StrictMode, useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ManagementClient } from '../core/api.ts'
import { createTranslate, type LocaleId } from '../core/i18n.ts'
import { WorkerPanel } from '../ui/WorkerPanel.tsx'
import { injectStyles } from '../ui/injectStyles.ts'
import { PANEL_CSS } from '../ui/styles.ts'
import { LocaleSwitch } from './LocaleSwitch.tsx'
import { applyHtmlLang, initialLocale, localeTag, writeStoredLocale } from './locale.ts'
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

const client = new ManagementClient({ baseUrl: '/api', token: readToken })

/**
 * The page shell.
 *
 * Owns the one piece of state the DSH shell would otherwise own for us. The
 * client lives at module scope so switching languages re-renders the panel
 * without tearing down its stream and starting a fresh one.
 */
function Page(): JSX.Element {
  const [locale, setLocale] = useState<LocaleId>(initialLocale)
  const t = useMemo(() => createTranslate(locale), [locale])

  const change = useCallback((next: LocaleId) => {
    setLocale(next)
    writeStoredLocale(next)
    applyHtmlLang(next)
  }, [])

  return (
    <div className="dsh-mqtt-standalone">
      <WorkerPanel
        client={client}
        t={t}
        locale={localeTag(locale)}
        onToken={writeToken}
        headerAction={<LocaleSwitch locale={locale} t={t} onChange={change} />}
      />
    </div>
  )
}

const container = document.querySelector('#root')
if (container === null) throw new Error('dsh-mqtt: missing #root container')

applyHtmlLang(initialLocale())
createRoot(container).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
