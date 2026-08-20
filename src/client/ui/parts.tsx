/**
 * Small layout atoms the panel repeats.
 *
 * Kept here rather than inline so the panel body reads as structure. Anything
 * with real behaviour comes from the DSH primitives instead.
 */

import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Tone } from '../core/format.ts'

export function Section({ title, count, action, children }: {
  title: string
  count?: number
  action?: ReactNode
  children?: ReactNode
}): JSX.Element {
  return (
    <section className="dsh-mqtt-section">
      <div className="dsh-mqtt-section-head">
        <h3>
          {title}
          {count !== undefined && <span className="dsh-mqtt-count">{count}</span>}
        </h3>
        {action !== undefined && <div className="dsh-mqtt-actions">{action}</div>}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="dsh-mqtt-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

export function Row({ title, subtitle, tone, actions, mono }: {
  title: string
  subtitle: string
  tone: Tone
  actions?: ReactNode
  mono?: boolean
}): JSX.Element {
  return (
    <li className="dsh-mqtt-row">
      <StateDot state={tone} size={8} />
      <div className="dsh-mqtt-grow">
        <p className={mono === true ? 'dsh-mqtt-mono' : undefined}>{title}</p>
        <p className="dsh-mqtt-muted">{subtitle}</p>
      </div>
      {actions !== undefined && <div className="dsh-mqtt-actions">{actions}</div>}
    </li>
  )
}
