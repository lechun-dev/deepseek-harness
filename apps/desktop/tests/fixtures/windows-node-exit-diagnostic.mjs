/** Repeat the shipped pnpm smoke in isolated Electron processes, retaining every failed exit. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPnpm } from './runtime-pnpm-smoke.mjs'

const [mode, executable, resourcesRuntime, countText = '100'] = process.argv.slice(2)
assert.ok(executable && resourcesRuntime, 'Pass mode, Electron executable and runtime directory')
if (mode === 'child') {
  assert.equal(process.execPath, executable)
  assert.ok(process.versions.electron)
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-node-exit-'))
  try {
    console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node }))
    checkPnpm(scratch, resourcesRuntime)
    console.log('desktop-pnpm-exit-ok')
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
} else {
  assert.equal(mode, 'repeat')
  const count = Number(countText)
  assert.ok(Number.isInteger(count) && count > 0 && count <= 1000)
  let failures = 0
  for (let iteration = 1; iteration <= count; iteration++) {
    const result = spawnSync(executable, ['--expose-internals', fileURLToPath(import.meta.url),
      'child', executable, resourcesRuntime], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    })
    const passed = result.status === 0 && !result.error && result.stdout.includes('desktop-pnpm-exit-ok')
    if (!passed) failures++
    console.log(JSON.stringify({ iteration, passed, status: result.status, signal: result.signal,
      error: result.error?.message }))
    if (!passed || iteration === 1) {
      process.stdout.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
    }
    // A timeout may leave descendants; stop rather than accumulate live process trees.
    if (result.error) break
  }
  console.log(JSON.stringify({ requested: count, failures }))
  if (failures) process.exitCode = 1
}
