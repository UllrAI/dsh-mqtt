/**
 * Stylesheet installation.
 *
 * Matches the convention DSH's own client bundles use: a guarded, idempotent
 * `<style data-plugin-css>` append. Callers run this from module scope inside
 * the bundle factory — the factory is lazy, so nothing touches the document
 * until the shell actually loads the plugin.
 */

export const STYLE_TAG_ID = 'dsh-mqtt/panel.css'

export function injectStyles(css: string, id = STYLE_TAG_ID): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-mqtt'
  tag.dataset.pluginCss = id
  tag.textContent = css
  document.head.append(tag)
}
