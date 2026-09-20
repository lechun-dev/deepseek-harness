/**
 * Locate an installed DeepSeek Harness so the real-process suites can drive it.
 *
 * `DSH_INSTALL_ROOT` wins when set; otherwise the usual global install
 * locations are probed. A missing harness is not a failure: the caller skips.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Candidate `@deepseek-ai` package roots of an installed harness.
 * @returns candidate directories, most specific first.
 */
export function candidateRoots() {
  const candidates = []
  if (process.env.DSH_INSTALL_ROOT) candidates.push(process.env.DSH_INSTALL_ROOT)
  candidates.push(join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  const nvmVersions = join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmVersions)) {
    for (const version of readdirSync(nvmVersions)) {
      candidates.push(join(nvmVersions, version, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    }
  }
  return candidates
}

/**
 * The first candidate that carries the packages the suites import.
 * @returns the `@deepseek-ai` package root, or `undefined` when none is installed.
 */
export function installedHarnessRoot() {
  return candidateRoots().find(candidate =>
    existsSync(join(candidate, 'cordis', 'lib', 'index.js'))
    && existsSync(join(candidate, 'dsh-subprocess-local', 'lib', 'index.js'))
    && existsSync(join(candidate, 'cordis-plugin-loader', 'lib', 'index.js')))
}

/** Skip message shared by the real-harness suites. */
export const NO_HARNESS_SKIP = 'no installed harness found; set DSH_INSTALL_ROOT to <…>/node_modules/@deepseek-ai'
