import { describe, expect, it } from 'vitest'
import { shouldSignMacOSDesktopRuntime } from '../scripts/desktop-release-environment.mjs'

describe('unsigned desktop runtime signing', () => {
  it('signs macOS runtimes unless the unsigned packaging flag is set', () => {
    expect(shouldSignMacOSDesktopRuntime({}, 'darwin')).toBe(true)
    expect(shouldSignMacOSDesktopRuntime({ DSH_DESKTOP_UNSIGNED: '0' }, 'darwin')).toBe(true)
    expect(shouldSignMacOSDesktopRuntime({ DSH_DESKTOP_UNSIGNED: '1' }, 'darwin')).toBe(false)
    expect(shouldSignMacOSDesktopRuntime({ DSH_DESKTOP_UNSIGNED: '1' }, 'win32')).toBe(false)
    expect(shouldSignMacOSDesktopRuntime({}, 'win32')).toBe(false)
  })

  it('rejects an invalid unsigned flag before packaging continues', () => {
    expect(() => shouldSignMacOSDesktopRuntime({ DSH_DESKTOP_UNSIGNED: 'yes' }, 'darwin'))
      .toThrow(/DSH_DESKTOP_UNSIGNED must be 0 or 1/u)
  })
})
