/**
 * End-to-end proof against an installed harness: a real `dsh-subprocess-local`
 * provider starts a real child process, and the child reports what it saw in
 * `MULTICA_TOKEN`.
 *
 * Three cases pin the whole contract:
 *   control    — no plugin: the seam's credential scrub removes the token;
 *   decorated  — plugin mounted: the same spawn carries it in the explicit layer;
 *   absent     — plugin mounted without an ambient token: the spec stays untouched.
 *
 * Set `DSH_INSTALL_ROOT` to `<…>/node_modules/@deepseek-ai` to point the suite at
 * a specific install; otherwise the usual global locations are probed and the
 * suite skips with a message when none is present.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import * as plugin from '../lib/index.js'
import { installedHarnessRoot, NO_HARNESS_SKIP } from './installed-harness.mjs'

const harnessRoot = installedHarnessRoot()

describe('real child process environment', { skip: harnessRoot === undefined ? NO_HARNESS_SKIP : false }, () => {
  /**
   * Spawn one child that writes the token it inherited into a file.
   * @param context - context holding the mounted subprocess service.
   * @param directory - scratch directory owning the report file.
   * @returns the file's contents, or `<no-file>` when the child never wrote it.
   */
  async function reportFromChild(context, directory) {
    const report = join(directory, 'token.txt')
    const handle = context.subprocess.spawn({
      argv: [
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], process.env.MULTICA_TOKEN ?? "<unset>")',
        report,
      ],
      cwd: directory,
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 5_000,
    })
    const outcome = await handle.done
    assert.equal(outcome.exitCode, 0)
    return existsSync(report) ? readFileSync(report, 'utf8') : '<no-file>'
  }

  /** Mount the harness's own local provider, optionally with the plugin. */
  async function mount(harness, withPlugin) {
    const { Context } = await import(`${harness}/cordis/lib/index.js`)
    const { default: LocalSubprocessRuntime } = await import(`${harness}/dsh-subprocess-local/lib/index.js`)
    const context = new Context()
    await context.plugin(LocalSubprocessRuntime)
    if (withPlugin) await context.plugin(plugin)
    return context
  }

  it('delivers the token only when the plugin is mounted', async () => {
    const harness = harnessRoot
    const directory = mkdtempSync(join(tmpdir(), 'multica-env-e2e-'))
    const ambient = process.env.MULTICA_TOKEN
    process.env.MULTICA_TOKEN = 'mat_e2e_probe'
    try {
      const control = await mount(harness, false)
      assert.equal(await reportFromChild(control, directory), '<unset>')
      await control.fiber.dispose()

      const decorated = await mount(harness, true)
      assert.equal(await reportFromChild(decorated, directory), 'mat_e2e_probe')
      await decorated.fiber.dispose()
    } finally {
      if (ambient === undefined) delete process.env.MULTICA_TOKEN
      else process.env.MULTICA_TOKEN = ambient
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('leaves the child environment alone without an ambient token', async () => {
    const harness = harnessRoot
    const directory = mkdtempSync(join(tmpdir(), 'multica-env-e2e-'))
    const ambient = process.env.MULTICA_TOKEN
    delete process.env.MULTICA_TOKEN
    try {
      const decorated = await mount(harness, true)
      assert.equal(await reportFromChild(decorated, directory), '<unset>')
      await decorated.fiber.dispose()
    } finally {
      if (ambient !== undefined) process.env.MULTICA_TOKEN = ambient
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
