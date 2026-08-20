/**
 * Panel stylesheet.
 *
 * Every colour, radius and font comes from a `--dsw-*` token, so the panel
 * inherits the shell's theme — dark mode included — without a second source of
 * truth. Shipped as a string because the DSH bundle format forbids side effects
 * at script scope: the entry injects it from inside the module factory.
 */

export const PANEL_CSS = `
.dsh-mqtt-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.5;
}
.dsh-mqtt-panel h2 { margin: 0; font-size: 18px; font-weight: 600; }
.dsh-mqtt-panel h3 { margin: 0; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dsh-mqtt-panel p { margin: 0; }

.dsh-mqtt-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dsh-mqtt-live { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 13px; white-space: nowrap; }

.dsh-mqtt-muted { color: var(--dsw-alias-label-tertiary); }
.dsh-mqtt-grow { flex: 1; min-width: 0; }
.dsh-mqtt-mono { font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace); word-break: break-all; }
.dsh-mqtt-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.dsh-mqtt-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 500;
  text-align: center;
}

.dsh-mqtt-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-mqtt-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }

.dsh-mqtt-state { display: flex; align-items: center; gap: 8px; font-weight: 500; }

.dsh-mqtt-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 0; }
.dsh-mqtt-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-mqtt-field dt { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-mqtt-field dd { margin: 0; overflow-wrap: anywhere; }

.dsh-mqtt-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.dsh-mqtt-list li { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.dsh-mqtt-list li + li { border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-mqtt-row p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mqtt-row .dsh-mqtt-muted { font-size: 13px; }

.dsh-mqtt-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-mqtt-banner > span:first-child { flex: 1; min-width: 0; }
.dsh-mqtt-banner-error { border-color: var(--dsw-alias-state-error-primary); }

.dsh-mqtt-label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); }

.dsh-mqtt-code {
  max-height: 220px;
  margin: 8px 0;
  padding: 12px;
  overflow: auto;
  border-radius: 8px;
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2));
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.dsh-mqtt-standalone {
  box-sizing: border-box;
  max-width: 880px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}
`
