/** Dependency policy for the Electron main-process bundle. */
import type { UserConfig } from 'tsdown'

/**
 * Select main-process dependency bundling rules.
 * @param homePathsEntry - TypeScript-emitted home-paths entry.
 * @returns Dependency options shared by packaging and its regression tests.
 */
export function desktopMainDependencies(homePathsEntry: string): UserConfig {
  return {
    // The TypeScript pass finishes before workspace bundles run concurrently.
    alias: { '@deepseek-ai/dsh-home-paths': homePathsEntry },
    deps: { neverBundle: ['electron'] },
    inputOptions: {
      onLog(level, log, defaultHandler) {
        if (log.code === 'UNRESOLVED_IMPORT') throw new Error(`Desktop main has an unresolved import: ${log.message}`)
        defaultHandler(level, log)
      },
    },
  }
}
