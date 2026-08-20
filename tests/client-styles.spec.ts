import { afterEach, describe, expect, it, vi } from 'vitest'
import { STYLE_TAG_ID, injectStyles } from '../src/client/ui/injectStyles.ts'
import { PANEL_CSS } from '../src/client/ui/styles.ts'
import { THEME_CSS } from '../src/client/standalone/theme.ts'

interface FakeStyle {
  dataset: { plugin?: string; pluginCss?: string }
  textContent: string
}

/**
 * Enough of `document` for the guarded append.
 *
 * The tests run in Node, where `document` is absent — which is itself one of
 * the branches, so the global is stubbed per test rather than globally.
 */
function fakeDocument() {
  const head: FakeStyle[] = []
  return {
    head,
    document: {
      createElement: (): FakeStyle => ({ dataset: {}, textContent: '' }),
      querySelector: (selector: string): FakeStyle | null => {
        const id = /style\[data-plugin-css="(.*)"\]/.exec(selector)?.[1]
        return head.find(tag => tag.dataset.pluginCss === id) ?? null
      },
      head: { append: (tag: FakeStyle) => head.push(tag) },
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('injectStyles', () => {
  it('appends a tagged style element', () => {
    const { head, document } = fakeDocument()
    vi.stubGlobal('document', document)

    injectStyles('.a { color: red }')

    expect(head).toEqual([{
      dataset: { plugin: 'dsh-mqtt', pluginCss: STYLE_TAG_ID },
      textContent: '.a { color: red }',
    }])
  })

  it('is idempotent for the same id but keeps distinct sheets apart', () => {
    const { head, document } = fakeDocument()
    vi.stubGlobal('document', document)

    injectStyles('.a {}')
    injectStyles('.a {}')
    injectStyles('.b {}', 'dsh-mqtt/theme.css')

    expect(head.map(tag => tag.dataset.pluginCss)).toEqual([STYLE_TAG_ID, 'dsh-mqtt/theme.css'])
  })

  it('does nothing where there is no document', () => {
    vi.stubGlobal('document', undefined)

    expect(() => injectStyles('.a {}')).not.toThrow()
  })
})

describe('stylesheets', () => {
  it('drives every colour through design tokens so themes carry over', () => {
    // A literal colour here would survive a DSH theme switch and look wrong.
    expect(PANEL_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(PANEL_CSS).toContain('var(--dsw-')
  })

  it('mirrors the tokens the standalone page has no theme plugin to supply', () => {
    for (const token of new Set(PANEL_CSS.match(/--dsw-[\w-]+/g))) {
      expect(THEME_CSS, `standalone theme is missing ${token}`).toContain(`${token}:`)
    }
  })
})
