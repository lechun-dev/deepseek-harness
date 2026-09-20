/**
 * Multica task-credential passthrough for the subprocess seam: every child the
 * harness starts through `ctx.subprocess` also carries the Multica task token,
 * so the `multica` CLI a model shell starts keeps its task identity instead of
 * failing closed with `agent execution context requires MULTICA_TOKEN …`.
 *
 * The seam scrubs credential-shaped names out of the ambient environment before
 * a child starts (`scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess` matches
 * `MULTICA_TOKEN`), while a spawn spec's explicit `env` layer merges *after*
 * that scrub. This plugin decorates the mounted runtime and adds that explicit
 * entry, so the scrub keeps its full strength and no harness file changes.
 *
 * Load it after any provider of `ctx.subprocess`; disposal restores the
 * decorated methods, so an unload or an HMR reload of either side leaves the
 * runtime exactly as it was found.
 *
 * @module dsh-multica-subprocess-env
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'

/**
 * Credential names the Multica runner puts into the harness process and the
 * model's children must see. One declared list keeps the decision auditable:
 * every name here is forwarded verbatim to every spawned child.
 */
export const FORWARDED_ENV_NAMES: readonly string[] = ['MULTICA_TOKEN']

/** One environment map as a spawn spec declares it. */
export type ExplicitEnvironment = Record<string, string | undefined>

/** Minimal shape of an environment source; `process.env` satisfies it. */
export type ForwardedEnvSource = Readonly<Record<string, string | undefined>>

/**
 * Collect the declared names that this source actually supplies.
 * @param source - environment to read; defaults to `process.env`.
 * @returns The explicit entries to merge, or `undefined` when the source
 * supplies none (an empty string is not a credential).
 */
export function forwardedEnv(source: ForwardedEnvSource = process.env): Record<string, string> | undefined {
  const forwarded: Record<string, string> = {}
  for (const name of FORWARDED_ENV_NAMES) {
    const value = source[name]
    if (value !== undefined && value !== '') forwarded[name] = value
  }
  return Object.keys(forwarded).length === 0 ? undefined : forwarded
}

/**
 * Return a spawn spec that also carries the declared credentials.
 * A caller's own explicit entry wins, so a consumer that deliberately passes a
 * different value is never overridden.
 * @param spec - the spawn spec about to reach the subprocess provider.
 * @param source - environment to read; defaults to `process.env`.
 * @returns The same spec when nothing is forwarded, otherwise a copy whose
 * `env` layer carries the credentials beneath the caller's entries.
 */
export function withForwardedEnv<T extends { env?: ExplicitEnvironment | undefined }>(
  spec: T,
  source: ForwardedEnvSource = process.env,
): T {
  const forwarded = forwardedEnv(source)
  if (forwarded === undefined) return spec
  return { ...spec, env: { ...forwarded, ...spec.env } }
}

/** Cordis plugin name. */
export const name = 'multica-subprocess-env'

/** The seam must be mounted before its spawn entry points can be decorated. */
export const inject: string[] = ['subprocess']

/**
 * Decorate the mounted subprocess runtime so every spawn carries the declared
 * credentials in its explicit environment layer. Both entry points are
 * restored on unload, and only while they are still this plugin's wrappers, so
 * a replacement installed in the meantime is never clobbered.
 * @param ctx - context holding the injected `subprocess` service.
 */
export function apply(ctx: Context): void {
  const runtime = ctx.subprocess
  const spawn = runtime.spawn
  const spawnTerminal = runtime.spawnTerminal
  const decoratedSpawn = (spec: Parameters<typeof spawn>[0]): ReturnType<typeof spawn> =>
    spawn.call(runtime, withForwardedEnv(spec))
  const decoratedSpawnTerminal = (spec: Parameters<typeof spawnTerminal>[0]): ReturnType<typeof spawnTerminal> =>
    spawnTerminal.call(runtime, withForwardedEnv(spec))
  ctx.effect(() => {
    runtime.spawn = decoratedSpawn
    runtime.spawnTerminal = decoratedSpawnTerminal
    return () => {
      if (runtime.spawn === decoratedSpawn) runtime.spawn = spawn
      if (runtime.spawnTerminal === decoratedSpawnTerminal) runtime.spawnTerminal = spawnTerminal
    }
  }, 'multica-subprocess-env.spawn')
}
