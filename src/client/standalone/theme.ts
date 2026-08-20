/**
 * Design tokens for the standalone page.
 *
 * Inside DSH the theme plugin defines these on `body`; a standalone page has no
 * such plugin, so the values every primitive we render resolves through are
 * mirrored here. Light and dark both ship, keyed off `prefers-color-scheme` and
 * overridable with `data-ds-dark-theme` for an explicit choice. Extracted from
 * `@deepseek-ai/dsh-client-ui-theme@0.1.0-rc.8` — refresh alongside dsh upgrades.
 */

export const THEME_CSS = `
:root {
  --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-mask-1: #0000003d;
  --dsw-alias-border-inverted: #0000;
  --dsw-alias-border-l1: #0000000a;
  --dsw-alias-border-l2: #0000001a;
  --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-button-contrast-fill: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-tool-bar-fill: #54555780;
  --dsw-alias-button-tool-bar-hover: #54555799;
  --dsw-alias-interactive-bg-active: #2631481a;
  --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-200);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-markdown-code-block: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-state-error-primary: var(--dsw-static-red-600);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-warn-label: var(--dsw-static-amber-600);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-font-markdown-code-block: 13px/22px var(--ds-font-family-code);
  --dsw-mask-blur: blur(2px);
  --dsw-shadow-lv3: 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014;
  --dsw-static-amber-500: #f59e0b;
  --dsw-static-amber-600: #dd8629;
  --dsw-static-deepseek-450: #5686fe;
  --dsw-static-green-500: #22c55e;
  --dsw-static-neutral-bluish-00: #fff;
  --dsw-static-neutral-bluish-100: #ebeef2;
  --dsw-static-neutral-bluish-1000: #0f1115;
  --dsw-static-neutral-bluish-200: #e1e5ee;
  --dsw-static-neutral-bluish-300: #cfd3d6;
  --dsw-static-neutral-bluish-400: #adb2b8;
  --dsw-static-neutral-bluish-50: #f9fafb;
  --dsw-static-neutral-bluish-600: #81858c;
  --dsw-static-neutral-bluish-700: #61666b;
  --dsw-static-neutral-bluish-750: #43454a;
  --dsw-static-neutral-bluish-800: #353638;
  --dsw-static-neutral-bluish-850: #2c2c2e;
  --dsw-static-neutral-bluish-875: #232324;
  --dsw-static-neutral-bluish-900: #1b1b1c;
  --dsw-static-red-400: #f25a5a;
  --dsw-static-red-600: #ec1313;
  --dsw-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --ds-font-family-code: "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
    "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
  --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-ds-light-theme]) {
    --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875);
    --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
    --dsw-alias-bg-mask-1: #00000080;
    --dsw-alias-border-inverted: #ffffff0f;
    --dsw-alias-border-l1: #ffffff0f;
    --dsw-alias-border-l2: #ffffff1f;
    --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50);
    --dsw-alias-button-contrast-fill: var(--dsw-static-neutral-bluish-50);
    --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-100);
    --dsw-alias-interactive-bg-active: #ffffff24;
    --dsw-alias-interactive-bg-hover: #ffffff14;
    --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-750);
    --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
    --dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-1000);
    --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-800);
    --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
    --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
    --dsw-alias-markdown-code-block: var(--dsw-static-neutral-bluish-900);
    --dsw-alias-state-error-primary: var(--dsw-static-red-400);
  }
}

[data-ds-dark-theme] {
  --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875);
  --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-bg-mask-1: #00000080;
  --dsw-alias-border-inverted: #ffffff0f;
  --dsw-alias-border-l1: #ffffff0f;
  --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-button-contrast-fill: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-interactive-bg-active: #ffffff24;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-markdown-code-block: var(--dsw-static-neutral-bluish-900);
  --dsw-alias-state-error-primary: var(--dsw-static-red-400);
}

html, body {
  margin: 0;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
}
`
