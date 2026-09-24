/** Exercise the shipped package-script launcher under Electron's Node runtime. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Run a package script with only the shipped node launcher available on PATH.
 * @param scratch Private writable fixture directory owned by the caller.
 * @param resourcesRuntime Directory containing the shipped bin and pnpm directories.
 * @returns Resolves synchronously only after the script exits successfully with its marker.
 */
export function checkPnpm(scratch, resourcesRuntime) {
  const bin = join(resourcesRuntime, 'bin')
  const pnpm = join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.mjs')
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    name: 'desktop-node-script-smoke', private: true, scripts: { check: 'node check.cjs' },
  }))
  writeFileSync(join(scratch, 'check.cjs'), `
const assert = require('node:assert/strict')
assert.equal(process.execPath, ${JSON.stringify(process.execPath)})
assert.ok(process.versions.electron)
assert.ok(process.execArgv.includes('--expose-internals'))
assert.equal(typeof require('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
console.log('desktop-node-script-ok')
`)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir|comspec)$/iu.test(name)))
  const systemBin = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'
  // This dependency-free fixture checks script launch, without pnpm's implicit install and update-network check.
  const output = execFileSync(process.execPath, ['--expose-internals', pnpm, 'run', 'check'], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000,
    env: { ...environment, pnpm_config_verify_deps_before_run: 'false',
      ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${bin}${delimiter}${systemBin}`, HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch },
  })
  assert.match(output, /desktop-node-script-ok/u)
}
