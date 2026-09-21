/** Compile the Windows `dsh` launcher this application installs on PATH. */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

/**
 * Compile the C# launcher for the Windows target.
 *
 * The source is C# 5 against the .NET Framework, so the framework's own
 * compiler is enough: no Visual Studio workload and no SDK download.
 * @param root - application directory holding `cli-shim/dsh-shim.cs`.
 * @returns absolute path of the compiled launcher.
 */
export function prepareCliShim(root: string): string {
  const target = resolveDesktopBuildTarget()
  if (!target.startsWith('win-')) throw new Error(`prepare-cli-shim: target ${target} is not a Windows target`)
  const source = join(root, 'cli-shim', 'dsh-shim.cs')
  if (!existsSync(source)) throw new Error(`prepare-cli-shim: ${source} is missing`)
  const compiler = process.env.DSH_DESKTOP_CSC
    ?? join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(compiler)) {
    throw new Error(`prepare-cli-shim: no C# compiler at ${compiler}; set DSH_DESKTOP_CSC to one that compiles C# 5`)
  }
  const output = join(resolveDesktopTargetBuildPaths().root, 'cli-shim', 'dsh.exe')
  mkdirSync(dirname(output), { recursive: true })
  rmSync(output, { force: true })
  const warnings = execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', `/out:${output}`, source], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (warnings.trim() !== '') process.stdout.write(`${warnings}\n`)
  if (!existsSync(output)) throw new Error(`prepare-cli-shim: ${compiler} produced no launcher at ${output}`)
  return output
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.filename === resolve(invoked)) {
  console.log(`prepare-cli-shim: ${prepareCliShim(resolve(import.meta.dirname, '..'))}`)
}
