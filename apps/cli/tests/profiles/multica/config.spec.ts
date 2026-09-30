/** Lechun endpoint defaults in the shipped MissionOS profile. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const basePatch = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const multicaPatch = fileURLToPath(new URL('../../../config/multica.yml', import.meta.url))

function endpoint(...laterLayers: ReturnType<typeof loadOverlayPatches>[]): string | undefined {
  const rows = composeEntries([
    loadOverlayPatches('multica-config-test', basePatch),
    loadOverlayPatches('multica-config-test', multicaPatch),
    ...laterLayers,
  ])
  const config = rows.find(row => row.id === 'llm-deepseek')?.config as { baseURL?: string } | undefined
  return config?.baseURL
}

describe('the shipped Multica model endpoint', () => {
  // 2026-09-30 coder(lq): Guard the package metadata that makes the bundled patch discoverable after upstream merges.
  it('declares the shipped config as its profile bundle patch', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./config/multica.yml')
  })

  it('defaults to the Lechun gateway', () => {
    expect(endpoint()).toBe('https://sub2api.lechun.cc/v1')
  })

  it('accepts a later user-layer override', () => {
    expect(endpoint([{ id: 'llm-deepseek', config: { baseURL: 'https://models.example/v1' } }]))
      .toBe('https://models.example/v1')
  })
})
