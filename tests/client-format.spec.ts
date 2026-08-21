import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatDuration,
  formatTime,
  healthDetail,
  healthLabel,
  healthTone,
  inviteConfigText,
  nodeStateLabel,
  nodeStateTone,
  requestStatusLabel,
  requestStatusTone,
  workspaceReadiness,
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
    expect(formatTime(iso, 'en-US', en.unknownTime)).toBe(formatTime(Date.parse(iso), 'en-US', en.unknownTime))
    expect(formatClock(iso, 'en-US')).toMatch(/\d/)
  })

  it('lets the caller name the empty case', () => {
    expect(formatTime(undefined, 'en-US', en.neverUsed)).toBe(en.neverUsed)
    expect(formatTime('not a date', 'en-US', en.noHeartbeat)).toBe(en.noHeartbeat)
  })

  it('reports ready workspaces over the total', () => {
    expect(workspaceReadiness(undefined)).toEqual({ ready: 0, total: 0 })
    expect(workspaceReadiness({ workspaces: [] } as never)).toEqual({ ready: 0, total: 0 })
    expect(workspaceReadiness({
      workspaces: [{ alias: 'a', status: 'ready' }, { alias: 'b', status: 'missing' }],
    } as never)).toEqual({ ready: 1, total: 2 })
  })

  it('picks the coarsest duration unit that still reads precisely', () => {
    expect(formatDuration(0, t)).toBe(interpolate(en.durationMs, { count: 0 }))
    expect(formatDuration(-5, t)).toBe(interpolate(en.durationMs, { count: 0 }))
    expect(formatDuration(4_200, t)).toBe(interpolate(en.durationSeconds, { count: 4 }))
    expect(formatDuration(90_000, t)).toBe(interpolate(en.durationMinutes, { count: 1, seconds: 30 }))
    expect(formatDuration(7_500_000, t)).toBe(interpolate(en.durationHours, { count: 2, minutes: 5 }))
  })
})

describe('health rows', () => {
  it('translates protocol check names but keeps operator-chosen aliases', () => {
    expect(healthLabel('broker', t)).toBe(en.healthBroker)
    expect(healthLabel('workspace:repo', t)).toBe(interpolate(en.healthWorkspace, { alias: 'repo' }))
    expect(healthLabel('something-new', t)).toBe('something-new')
  })

  it('translates status identifiers and passes real messages through', () => {
    expect(healthDetail({ status: 'ready' }, t)).toBe(en.healthReady)
    expect(healthDetail({ status: 'degraded', message: 'missing' }, t)).toBe(en.healthMissing)
    expect(healthDetail({ status: 'degraded', message: 'broker refused the connection' }, t))
      .toBe('broker refused the connection')
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
