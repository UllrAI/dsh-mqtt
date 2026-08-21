// @vitest-environment jsdom

/**
 * Locale preference for the standalone page.
 *
 * This module stands in for the DSH locale plugin, so what matters is that it
 * makes the same three promises: an explicit choice wins over the browser, the
 * choice survives a reload, and `<html lang>` follows the copy.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyHtmlLang,
  initialLocale,
  localeTag,
  matchLocale,
  readStoredLocale,
  writeStoredLocale,
} from '../src/client/standalone/locale.ts'

beforeEach(() => {
  // Unstub first: a previous test may have left a throwing storage in place.
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('locale preference', () => {
  it('matches a browser tag to a shipped dictionary by primary subtag', () => {
    expect(matchLocale('zh-CN')).toBe('zh')
    expect(matchLocale('zh-Hant-TW')).toBe('zh')
    expect(matchLocale('ZH')).toBe('zh')
    expect(matchLocale('en-GB')).toBe('en')
    // A language this page does not ship reads English, not a blank panel.
    expect(matchLocale('fr')).toBe('en')
    expect(matchLocale(undefined)).toBe('en')
  })

  it('prefers an explicit choice over what the browser asked for', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(initialLocale()).toBe('zh')

    writeStoredLocale('en')
    expect(initialLocale()).toBe('en')
  })

  it('ignores a stored value that is not a shipped locale', () => {
    localStorage.setItem('dsh-mqtt:locale', 'klingon')
    expect(readStoredLocale()).toBeUndefined()
  })

  it('outlives the tab, unlike the management token', () => {
    writeStoredLocale('zh')
    expect(localStorage.getItem('dsh-mqtt:locale')).toBe('zh')
    expect(sessionStorage.getItem('dsh-mqtt:locale')).toBeNull()
  })

  it('survives a browser that denies storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    vi.stubGlobal('navigator', { language: 'zh' })

    expect(() => writeStoredLocale('en')).not.toThrow()
    expect(readStoredLocale()).toBeUndefined()
    expect(initialLocale()).toBe('zh')
  })

  it('gives the document a region-qualified tag, not the dictionary id', () => {
    expect(localeTag('zh')).toBe('zh-CN')
    expect(localeTag('en')).toBe('en')

    applyHtmlLang('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
