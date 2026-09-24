/** Desktop bundles must not depend on unpublished development-only packages. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'tsdown'
import ts from 'typescript'
import { expect, it, onTestFinished } from 'vitest'
import { desktopMainDependencies } from '../scripts/desktop-bundle.ts'

it('loads desktop paths without a generated home-paths package bundle or installed dev dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-bundle-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const dependency = join(root, 'node_modules/@deepseek-ai/dsh-home-paths')
  await mkdir(join(dependency, 'lib/types'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { '@deepseek-ai/dsh-home-paths': '*' } }))
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './lib/index.js' }))
  const emit = async (source: URL, target: string) => {
    const text = await readFile(source, 'utf8')
    const emitted = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } })
    await writeFile(target, emitted.outputText)
  }
  const entry = join(dependency, 'lib/types/index.js')
  await emit(new URL('../../../packages/util/home-paths/src/index.ts', import.meta.url), entry)
  await emit(new URL('../src/paths.ts', import.meta.url), join(root, 'main.js'))
  const bundles = await build({
    cwd: root, config: false, entry: ['main.js'], outDir: 'out', format: 'esm', platform: 'node',
    ...desktopMainDependencies(entry),
  })
  for (const bundle of bundles) await bundle[Symbol.asyncDispose]()
  await rm(join(root, 'node_modules'), { recursive: true })
  expect(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {resolveDesktopPaths} from './out/main.mjs'; console.log(resolveDesktopPaths('/isolated').profile)"], { cwd: root, encoding: 'utf8' })).toContain('desktop')
})

it('rejects unresolved main-process imports during the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-bundle-missing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'main.js'), "import 'missing-desktop-dependency'")
  await expect(build({ cwd: root, config: false, entry: ['main.js'],
    ...desktopMainDependencies(join(root, 'unused.js')),
  })).rejects.toThrow(/unresolved import/i)
})
