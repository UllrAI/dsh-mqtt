/**
 * DSH client entry: the MQTT Worker settings section.
 *
 * DSH gives third-party client code exactly one seam — `ctx.slots` — and no
 * data channel of its own (`ctx.remote` is a build-time whitelist we cannot
 * extend). So the panel talks to the plugin's management server over plain
 * HTTP, cross-origin; the gateway reflects loopback origins by default so this
 * works without hand-configured CORS.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only side-effect imports: these modules contribute the `settings.section`
// SlotMap entry and the `ctx.locale` service declaration. Erased at build time,
// so neither package is pulled into the bundle.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ManagementClient } from './core/api.ts'
import { en, zh, type Dictionary } from './core/i18n.ts'
import { WorkerPanel } from './ui/WorkerPanel.tsx'
import { injectStyles } from './ui/injectStyles.ts'
import { PANEL_CSS } from './ui/styles.ts'

injectStyles(PANEL_CSS)

/** Locale namespace owned by this plugin. */
export const LOCALE_NS = 'dshMqtt'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's panel copy. */
    dshMqtt: keyof Dictionary
  }
}

/**
 * Where the panel finds the management API.
 *
 * The gateway serves it on its own port, so a same-origin path will not do.
 * A deployment that moved the port sets `DSH_MQTT_MANAGEMENT_URL` on the shell
 * window; everything else gets the documented default.
 */
const DEFAULT_MANAGEMENT_BASE = 'http://127.0.0.1:3210/api'

function managementBase(): string {
  const configured = (globalThis as { DSH_MQTT_MANAGEMENT_URL?: unknown }).DSH_MQTT_MANAGEMENT_URL
  return typeof configured === 'string' && configured !== '' ? configured : DEFAULT_MANAGEMENT_BASE
}

/**
 * Token storage.
 *
 * `sessionStorage` rather than `localStorage`: a management token is a
 * credential and should not outlive the tab it was typed into.
 */
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
    // Storage-denying browsers still get a working panel for this render.
  }
}

/** Display locale for `Intl`; the shell owns the copy, the browser owns dates. */
function displayLocale(): string {
  return typeof navigator === 'undefined' ? 'en' : navigator.language
}

interface MqttSectionInjected {
  client: ManagementClient
  onToken: (token: string) => void
}

type MqttSectionProps = ComposedProps<
  'settings.section', string, never, undefined, MqttSectionInjected, never, typeof LOCALE_NS
>

function MqttSection({ client, onToken, t }: MqttSectionProps): JSX.Element {
  return <WorkerPanel client={client} t={t} locale={displayLocale()} onToken={onToken} />
}

/** Cordis services this entry needs before it may activate. */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-mqtt: locale')

  const client = new ManagementClient({ baseUrl: managementBase(), token: readToken })

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'dsh-mqtt',
      order: 120,
      label: () => ctx.locale.bind(LOCALE_NS)('nav'),
      locale: LOCALE_NS,
      registrant: 'dsh-mqtt',
      inject: () => ({ client, onToken: writeToken }),
    },
    MqttSection,
  ))
}
