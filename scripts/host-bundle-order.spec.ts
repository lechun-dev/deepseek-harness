/** Clean desktop builds must consume completed workspace bundles. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { pnpmInvocation } from './pnpm-invocation.ts'

it('builds a clean desktop consumer after its development-only workspace dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-bundle-order-'))
  const links: string[] = []
  onTestFinished(async () => {
    for (const link of links) await unlink(link)
    await rm(root, { recursive: true, force: true })
  })
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const write = async (name: string, content: string) => {
    const target = join(root, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  const manifest: { scripts: Record<string, string> } = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  await write('package.json', JSON.stringify({
    private: true, type: 'module', scripts: { 'build:lib:host': manifest.scripts['build:lib:host'] },
  }))
  await write('pnpm-workspace.yaml', "packages:\n  - 'packages/*/*'\n  - 'apps/*'\n")
  await write('tsconfig.host.json', JSON.stringify({ files: ['noop.ts'], compilerOptions: { noEmit: true } }))
  await write('noop.ts', 'export {}')
  await write('lib/types/index.js', 'export {}')
  await write('packages/typert/generator/lib/types/index.js', 'export {}')
  await write('tsdown.config.ts', await readFile(join(repository, 'tsdown.config.ts'), 'utf8'))
  // Typert generation is unrelated to the dependency scheduling exercised here.
  await write('packages/typert/generator/lib/types/tsdown-plugin.js',
    "export function typertPlugin() { return { name: 'fixture-typert' } }")
  await write('packages/credentials/account/package.json', JSON.stringify({
    name: '@fixture/account', type: 'module', exports: './lib/index.js',
  }))
  await write('packages/credentials/account/lib/types/index.js', "export const account = 'bundled-account'")
  await write('apps/desktop/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh-desktop', type: 'module', devDependencies: { '@fixture/account': 'workspace:*' },
  }))
  await write('apps/desktop/lib/types/main.js', "export { account } from '@fixture/account'")
  await write('apps/desktop/tsdown.config.ts', [
    'export default {',
    "entry: ['lib/types/main.js'], outDir: 'lib', clean: false, format: 'esm', fixedExtension: false, dts: false,",
    "inputOptions: { onLog(level, log, handler) { if(log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message); handler(level,log) } }",
    '}',
  ].join('\n'))
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true })
  for (const name of ['typescript', 'tsdown']) {
    const link = join(root, 'node_modules', name)
    await symlink(join(repository, 'node_modules', name), link, 'junction')
    links.push(link)
  }
  // pnpm prepends the fixture .bin; retain its inherited tsdown command from this test's launcher.
  await mkdir(join(root, 'apps/desktop/node_modules/@fixture'), { recursive: true })
  const dependencyLink = join(root, 'apps/desktop/node_modules/@fixture/account')
  await symlink(join(root, 'packages/credentials/account'), dependencyLink, 'junction')
  links.push(dependencyLink)
  const invocation = pnpmInvocation(['run', 'build:lib:host'], process.env)
  execFileSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8', timeout: 60_000, stdio: 'pipe' })
  await unlink(dependencyLink)
  links.pop()
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { account } from './apps/desktop/lib/main.js'; console.log(account)"], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  expect(output.trim()).toBe('bundled-account')
})
