import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

describe('DSH plugin export shape', () => {
  it('preserves named Cordis fields through Loader unwrapping', () => {
    expect('default' in plugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.name).toBe('dsh-mqtt')
    expect(unwrapped.inject).toEqual(['agents'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
