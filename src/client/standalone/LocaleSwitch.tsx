/**
 * Language switch for the standalone page.
 *
 * Inside DSH this control does not exist — the shell's own Language row owns the
 * preference and the panel simply follows it. Here nothing else is on the page,
 * so the panel carries the switch itself.
 */

import { useState } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleId, Translate } from '../core/i18n.ts'
import { LOCALE_IDS, LOCALE_LABELS } from './locale.ts'

const ITEMS = LOCALE_IDS.map(id => ({ id, label: LOCALE_LABELS[id] }))

export function LocaleSwitch({ locale, t, onChange }: {
  locale: LocaleId
  t: Translate
  onChange: (locale: LocaleId) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <Menu
      open={open}
      align="end"
      items={ITEMS}
      selectedId={locale}
      onSelect={id => {
        setOpen(false)
        onChange(id as LocaleId)
      }}
      onClose={() => setOpen(false)}
      anchor={
        <Button
          variant="outline"
          size="sm"
          aria-label={t('language')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
        >
          {LOCALE_LABELS[locale]}
        </Button>
      }
    />
  )
}
