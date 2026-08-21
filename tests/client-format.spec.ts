import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatTime,
  healthTone,
  inviteConfigText,
  nodeStateLabel,
  nodeStateTone,
  readyWorkspaceCount,
  requestStatusLabel,
  requestStatusTone,
} from '../src/client/core/format.ts'
import { createTranslate, en, interpolate, zh } from '../src/client/core/i18n.ts'

const t = createTranslate('en')

describe('i18n', () => {
  it('translates through the dictionary matching the locale', () => {
    expect(createTranslate('en')('stateReady')).toBe(en.stateReady)
    expect(createTranslate('zh')('stateReady')).toBe(zh.stateReady)
  })

  it('covers every English key in Chinese', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('substitutes named placeholders', () => {
    expect(interpolate('{active} of {capacity} slots', { active: 1, capacity: 4 })).toBe('1 of 4 slots')
  })

  it('leaves the template alone when there is nothing to substitute', () => {
    expect(interpolate('{count} ready')).toBe('{count} ready')
    expect(interpolate('{count} ready', {})).toBe('{count} ready')
  })
})

describe('state presentation', () => {
  it('labels known worker states and falls back for the rest', () => {
    expect(nodeStateLabel('ready', t)).toBe(en.stateReady)
    expect(nodeStateLabel('busy', t)).toBe(en.stateBusy)
    expect(nodeStateLabel('warp-drive', t)).toBe(en.stateUnknown)
    expect(nodeStateLabel(undefined, t)).toBe(en.stateUnknown)
  })

  it('maps worker states onto dot tones', () => {
    expect(nodeStateTone('ready')).toBe('done')
    expect(nodeStateTone('busy')).toBe('ongoing')
    expect(nodeStateTone('offline')).toBe('error')
    expect(nodeStateTone('stopped')).toBe('error')
    expect(nodeStateTone('connecting')).toBe('warning')
    expect(nodeStateTone(undefined)).toBe('warning')
  })

  it('labels and tones every request status', () => {
    expect(requestStatusLabel('completed', t)).toBe(en.statusCompleted)
    expect(requestStatusTone('completed')).toBe('done')
    expect(requestStatusTone('failed')).toBe('error')
    expect(requestStatusTone('active')).toBe('ongoing')
    expect(requestStatusTone('accepted')).toBe('ongoing')
    expect(requestStatusTone('cancelled')).toBe('warning')
  })

  it('tones health checks', () => {
    expect(healthTone('ready')).toBe('done')
    expect(healthTone('degraded')).toBe('warning')
    expect(healthTone('offline')).toBe('error')
  })
})

describe('formatting', () => {
  it('formats timestamps from both epoch millis and ISO strings', () => {
    const iso = '2026-03-05T14:30:00.000Z'
    expect(formatTime(iso, 'en-US', t)).toBe(formatTime(Date.parse(iso), 'en-US', t))
    expect(formatClock(iso, 'en-US')).toMatch(/\d/)
  })

  it('reports an absent or unparseable timestamp as never used', () => {
    expect(formatTime(undefined, 'en-US', t)).toBe(en.neverUsed)
    expect(formatTime('not a date', 'en-US', t)).toBe(en.neverUsed)
  })

  it('counts only ready workspaces', () => {
    expect(readyWorkspaceCount(undefined)).toBe(0)
    expect(readyWorkspaceCount({ workspaces: [] } as never)).toBe(0)
    expect(readyWorkspaceCount({
      workspaces: [{ alias: 'a', status: 'ready' }, { alias: 'b', status: 'missing' }],
    } as never)).toBe(1)
  })
})

describe('inviteConfigText', () => {
  it('emits a controller config carrying no broker secrets', () => {
    const text = inviteConfigText(
      { id: 'controller-1', token: 'secret', expiresAt: Date.parse('2026-03-05T14:30:00.000Z') },
      { url: 'mqtt://broker.test:1883', namespace: 'team', node_id: 'worker' },
    )

    expect(JSON.parse(text)).toEqual({
      version: 1,
      broker_url: 'mqtt://broker.test:1883',
      namespace: 'team',
      node_id: 'worker',
      controller_id: 'controller-1',
      token: 'secret',
      expires_at: '2026-03-05T14:30:00.000Z',
    })
    expect(text).toContain('\n  ')
  })
})
