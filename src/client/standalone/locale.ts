/**
 * Locale preference for the standalone page.
 *
 * Inside DSH the locale plugin owns this: it persists the choice to
 * `settings.yaml` and drives `<html lang>`. A standalone page has no such
 * plugin, so the same three jobs are done here — resolve, persist, publish —
 * against `localStorage` rather than the DSH home. Unlike the management token
 * a language choice is not a credential, so it may outlive the tab.
 */

import type { LocaleId } from '../core/i18n.ts'

export const LOCALE_IDS: readonly LocaleId[] = ['en', 'zh']

/** Self-described names, so a reader can find their language without reading the other. */
export const LOCALE_LABELS: Record<LocaleId, string> = {
  en: 'English',
  zh: '中文',
}

/** `<html lang>` values; the dictionary ids are too coarse for a lang attribute. */
const HTML_LANG: Record<LocaleId, string> = {
  en: 'en',
  zh: 'zh-CN',
}

/** BCP 47 tag for `<html lang>` and `Intl`, which both want a region. */
export function localeTag(locale: LocaleId): string {
  return HTML_LANG[locale]
}

const STORAGE_KEY = 'dsh-mqtt:locale'

function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === 'string' && (LOCALE_IDS as readonly string[]).includes(value)
}

/** The stored choice, or undefined when the reader has never made one. */
export function readStoredLocale(): LocaleId | undefined {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isLocaleId(stored) ? stored : undefined
  } catch {
    return undefined
  }
}

export function writeStoredLocale(locale: LocaleId): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Storage-denying browsers still get the switch, just not the memory of it.
  }
}

/**
 * Match a browser language tag to a shipped dictionary.
 *
 * Primary-subtag matching, the same rule the DSH locale plugin uses: `zh-Hant`
 * and `zh-CN` both mean Chinese. Anything else reads English, which is the
 * safer default for a browser asking for a language this page does not ship.
 */
export function matchLocale(tag: string | undefined): LocaleId {
  const primary = tag?.toLowerCase().split('-')[0]
  return isLocaleId(primary) ? primary : 'en'
}

/** An explicit choice wins; otherwise take the browser's word for it. */
export function initialLocale(): LocaleId {
  return readStoredLocale() ?? matchLocale(navigator.language)
}

/** Keep assistive tech and the browser's own typography in step with the copy. */
export function applyHtmlLang(locale: LocaleId): void {
  document.documentElement.lang = HTML_LANG[locale]
}