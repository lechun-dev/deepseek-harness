import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

const { withNativeEngineAlias } = await import(pathToFileURL(join(process.env.DSH_OFFICE_KIT_DIRECTORY, 'lib/native-paths.js')).href)

for (const outcome of ['success', 'failure', 'abort']) {
  test(`native engine alias lifecycle: ${outcome}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'office-path-test-'))
    const root = join(fixture, 'app.asar.unpacked', 'engine')
    await mkdir(join(root, 'program'), { recursive: true })
    await writeFile(join(root, 'helper'), 'original')
    const engine = { root, programDirectory: join(root, 'program'), executable: join(root, 'helper') }
    let alias
    const reason = new Error(outcome)
    const controller = new AbortController()
    try {
      const result = withNativeEngineAlias(engine, async mapped => {
        alias = dirname(mapped.executable)
        assert.ok((await lstat(alias)).isSymbolicLink())
        assert.equal(await readFile(mapped.executable, 'utf8'), 'original')
        assert.ok((await stat(mapped.programDirectory)).isDirectory())
        if (outcome === 'abort') {
          controller.abort(reason)
          controller.signal.throwIfAborted()
        }
        if (outcome === 'failure') throw reason
        return 'converted'
      })
      if (outcome === 'success') assert.equal(await result, 'converted')
      else await assert.rejects(result, error => error === reason)
      assert.ok(alias)
      await assert.rejects(lstat(alias), { code: 'ENOENT' })
      await assert.rejects(lstat(dirname(alias)), { code: 'ENOENT' })
      assert.equal(await readFile(engine.executable, 'utf8'), 'original')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

// Export the installed native call unchanged from a disposable sibling module.
for (const outcome of ['spawn failure', 'pre-aborted']) {
  test(`native call cleans alias after ${outcome}`, async () => {
    const kit = process.env.DSH_OFFICE_KIT_DIRECTORY
    const modulePath = join(kit, 'lib', `native-test-${randomUUID()}.mjs`)
    const fixture = await mkdtemp(join(tmpdir(), 'office-native-test-'))
    let alias
    try {
      await writeFile(modulePath, `${await readFile(join(kit, 'lib/index.js'), 'utf8')}\nexport { runNative };\n`)
      const { runNative } = await import(pathToFileURL(modulePath).href)
      const profile = join(fixture, 'profile')
      await mkdir(profile)
      const controller = new AbortController()
      const reason = new Error('cancelled before native spawn')
      if (outcome === 'pre-aborted') controller.abort(reason)
      const engine = { root: fixture, programDirectory: fixture, executable: join(fixture, 'missing-helper') }
      await assert.rejects(withNativeEngineAlias(engine, async mapped => {
        alias = mapped.root
        return runNative(mapped, { maxOutputBytes: 100000, maxImageResolution: 100 }, join(fixture, 'input.docx'), join(fixture, 'output.pdf'), profile, [], [], controller.signal)
      }), error => outcome === 'pre-aborted' ? error === reason : error.code === 'ENOENT')
      await assert.rejects(lstat(alias), { code: 'ENOENT' })
      assert.ok((await stat(profile)).isDirectory())
    } finally {
      await rm(modulePath, { force: true })
      await rm(fixture, { recursive: true, force: true })
    }
  })
}
