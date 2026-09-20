/**
 * Real Loader composition: a `cordis.yml` row names this module by absolute
 * path — the exact form the profile patch uses — and a real child process
 * started through the mounted provider reports the token it inherited.
 *
 * The suite skips itself when no installed harness is present; set
 * `DSH_INSTALL_ROOT` to `<…>/node_modules/@deepseek-ai` to point at one.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { installedHarnessRoot, NO_HARNESS_SKIP } from './installed-harness.mjs'

const harnessRoot = installedHarnessRoot()
const moduleUrl = new URL('../lib/index.js', import.meta.url)

describe('real Loader composition', { skip: harnessRoot === undefined ? NO_HARNESS_SKIP : false }, () => {
  it('mounts the provider and this module from cordis.yml rows, then spawns a child', { timeout: 30_000 }, async () => {
    const harness = harnessRoot
    const { Context } = await import(`${harness}/cordis/lib/index.js`)
    const { default: Loader } = await import(`${harness}/cordis-plugin-loader/lib/index.js`)
    const { default: Include } = await import(`${harness}/cordis-plugin-include/lib/index.js`)

    const root = mkdtempSync(join(tmpdir(), 'multica-env-loader-'))
    const configPath = join(root, 'cordis.yml')
    const reportPath = join(root, 'token.txt')
    writeFileSync(configPath, [
      `- name: '${harness}/dsh-subprocess-local/lib/index.js'`,
      `- name: '${moduleUrl.pathname}'`,
      '',
    ].join('\n'))

    const ambient = process.env.MULTICA_TOKEN
    process.env.MULTICA_TOKEN = 'mat_loader_probe'
    const context = new Context()
    try {
      context.baseUrl = `${pathToFileURL(root).href}/`
      await context.plugin(Loader)
      context.loader.builtins.include = Include
      await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await context.loader.await()

      const unloaded = [...context.loader.entries()]
        .filter(entry => entry.fiber === undefined && !entry.disabled)
        .map(entry => entry.options.name)
      assert.deepEqual(unloaded, [], `Loader rows that failed to mount: ${unloaded.join(', ')}`)

      const handle = context.subprocess.spawn({
        argv: [
          process.execPath,
          '-e',
          'require("node:fs").writeFileSync(process.argv[1], process.env.MULTICA_TOKEN ?? "<unset>")',
          reportPath,
        ],
        cwd: root,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 5_000,
      })
      assert.equal((await handle.done).exitCode, 0)
      assert.equal(existsSync(reportPath), true)
      assert.equal(readFileSync(reportPath, 'utf8'), 'mat_loader_probe')
    } finally {
      if (ambient === undefined) delete process.env.MULTICA_TOKEN
      else process.env.MULTICA_TOKEN = ambient
      await context.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
