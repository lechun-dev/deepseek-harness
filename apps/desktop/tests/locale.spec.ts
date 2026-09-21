import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLanguage, resolveDesktopLocale, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('prefers the renderer language, then the system preference list, then the application locale', () => {
    expect(resolveDesktopLanguage('zh-CN', ['en-US'], 'en-US')).toBe('zh-CN')
    expect(resolveDesktopLanguage(undefined, ['zh-Hans-CN', 'en-CN'], 'en-US')).toBe('zh-Hans-CN')
    expect(resolveDesktopLanguage(undefined, ['', 'zh-Hans-CN'], 'en-US')).toBe('zh-Hans-CN')
    expect(resolveDesktopLanguage(undefined, [], 'zh-CN')).toBe('zh-CN')
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

})
