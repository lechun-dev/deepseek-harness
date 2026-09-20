# @lechun-dev/dsh-multica-subprocess-env

English | [中文](README.zh.md)

## Summary

Fork-local DeepSeek Harness plugin that puts the Multica task credential (`MULTICA_TOKEN`) into every child process the harness starts through `ctx.subprocess`. Without it, the seam's credential scrub removes the token and every `multica` command inside a task fails closed. This fork ships a snapshot of it in `@deepseek-ai/dsh-base`, so CLI, web, and desktop built from this checkout load it with no extra profile row. The source still sits outside the pnpm workspace so upstream merges never treat it as a release member, and unloading restores exactly what it decorated.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Install](#install)
- [Wire it into a profile](#wire-it-into-a-profile)
- [Verify](#verify)
- [How it works](#how-it-works)
- [Develop](#develop)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="why-it-exists"></a>
## Why it exists

The Multica runner injects the task credential into the harness process, and the agent's shell must see it again: `multica auth status`, `multica issue get`, and `multica issue comment add` all refuse to run with `agent execution context requires MULTICA_TOKEN to be a task-scoped mat_ token` when it is missing.

The token is lost at the child-process boundary. `packages/subprocess/subprocess/src/index.ts` builds every child environment from `scrubbedParentEnv()`, which drops names matching `/KEY|PASSWORD|SECRET|TOKEN/i`; `MULTICA_TOKEN` matches, so the model's `bash` children never receive it. The same file documents the supported escape hatch: a spawn spec's explicit `env` layer is merged *after* the scrub, so a deliberately forwarded entry survives.

This plugin supplies that explicit entry for every spawn the mounted provider serves: bash and PowerShell commands, terminal sessions, language servers, hook commands, and subagent backends. It leaves the scrub itself untouched, which keeps the harness rule that no credential leaks into a child implicitly.

<a id="install"></a>
## Install

Copy the module into the fork checkout, then build it once:

```sh
cp -R multica-subprocess-env /Users/lq/work/lechun/code/DSH/integrations/
cd /Users/lq/work/lechun/code/DSH/integrations/multica-subprocess-env
node ../../node_modules/typescript/bin/tsc -p tsconfig.json
```

`install.sh` beside this file does the build for you, refreshes the `dsh-base` snapshot, and runs the suite (`bash install.sh`). `bash install.sh --wire --yes` also appends the profile row shown below, and is only for official npm `dsh`; skip `--wire` on this checkout so the profile does not get a second copy. The build needs the repository built once (`pnpm run build:lib:host`), because the module's two type dependencies resolve to `vendor/cordis/lib/types` and `packages/subprocess/subprocess/lib/types` through its own `tsconfig.json` paths map. Nothing else is installed: the emitted `lib/index.js` has no imports, and the repository's `.gitignore` already excludes `lib/`.

<a id="wire-it-into-a-profile"></a>
## Wire it into a profile

This fork already inserts the plugin in `packages/bundle/base/cordis.patch.yml`. Do not append a second row to `~/.dsh/profiles/multica/cordis.patch.yml` when running this checkout. The example below is only for official npm `dsh` (or any machine that is not running this fork); write it to `~/.dsh/profiles/multica/cordis.patch.yml` (or to `~/.dsh/cordis.patch.yml` to cover every profile on the machine):

```yaml
- insert:
    - id: multica-subprocess-env
      name: '/Users/lq/work/lechun/code/DSH/integrations/multica-subprocess-env/lib/index.js'
```

The row is applied after every bundle layer, so it decorates whichever `ctx.subprocess` provider the profile mounted. Nothing restarts: each task starts a new harness process.

Once a task proves the token arrives, the two earlier workarounds are no longer needed: the patched `dsh-subprocess` in the global `node_modules` (restore it with `npm i -g @deepseek-ai/dsh` or by reinstalling) and the agent's `DSH_ENV_PASSTHROUGH` environment variable.

<a id="verify"></a>
## Verify

Inside a task started after the wiring, the agent runs:

```sh
env | grep -c '^MULTICA_TOKEN='   # 1
multica auth status               # task identity
```

Locally, the module's own suite opens a real child process through the installed provider and asserts all three cases — the control case proves the bug the plugin fixes:

```sh
cd /Users/lq/work/lechun/code/DSH/integrations/multica-subprocess-env
npm test
```

`tests/child-env.test.mjs` mounts the installed provider directly and skips with a message when no harness is found (set `DSH_INSTALL_ROOT` to `<…>/node_modules/@deepseek-ai` to point at one). `tests/loader-composition.test.mjs` repeats the proof through a real Cordis Loader reading a `cordis.yml`, which also covers the absolute-path row form used above.

<a id="how-it-works"></a>
## How it works

`apply()` captures `spawn` and `spawnTerminal` from the injected `ctx.subprocess`, replaces them with wrappers that merge `forwardedEnv()` beneath the caller's own `env` entries, and registers the restore through `ctx.effect()`. Forwarding is computed at spawn time, so a token that appears or disappears between tasks is honored without reloading anything, and a spec is returned untouched when no credential is present.

Two details keep the decoration honest. The original methods are called with their own receiver, because a provider may read instance state. The restore is identity-guarded: if something replaced an entry point while the plugin was loaded, unloading leaves that replacement alone.

A provider subclass mounted in place of `dsh-subprocess-local` is the other conventional shape, and it is the right one if the fork ever needs to change provider behavior rather than decorate it. This module decorates instead because the seam contract it depends on is two documented methods, while a subclass inherits one implementation's internals — and because a bug here simply leaves the token scrubbed instead of taking the subprocess capability down with it.

<a id="develop"></a>
## Develop

```sh
npm run build       # tsc -p tsconfig.json -> lib/
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # build, then node --test tests/
```

Source and tests are plain ESM. `src/index.ts` imports only types, so the emitted module has no runtime dependency and can be loaded from any path. The suite needs no package install; it reads the repository's vendored Cordis build and, for the real-child cases, an installed harness.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- **The forwarded set is fixed in source.** `FORWARDED_ENV_NAMES` declares `MULTICA_TOKEN` only, matching what the runner injects today; a second credential-shaped name is a one-line change plus a test, and no configuration surface exists until a second consumer needs one.
- **Children the harness does not spawn are out of reach.** An MCP stdio server is started by the MCP SDK rather than through the seam, so it needs the `env` field of its own `mcp-client` configuration; the same holds for any plugin calling `child_process` directly.
- **An in-place decorator follows the seam, not the implementation.** If upstream renames `spawn` or `spawnTerminal`, the wrappers stop matching and the credential silently disappears; `tests/child-env.test.mjs` fails on that change instead of letting it ship, and the fix is to re-point the two captured methods.
- **`lib/` is build output.** It is ignored by the repository's `.gitignore`, so `install.sh --wire` against official npm `dsh` still needs a local build; this fork's committed snapshot in `packages/bundle/base/plugins/` does not.
- **Verification needs a harness.** Both real-process suites skip when no installed harness is found, which keeps the pure units runnable anywhere but leaves the end-to-end assertion to a machine that has one.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Written for the lechun fork on 2026-09-20, replacing a temporary patch to the installed `dsh-subprocess` package plus an agent environment variable. This fork now ships a snapshot of the built module in `@deepseek-ai/dsh-base`, so CLI, web, and desktop from this checkout load it without a profile row; `install.sh --wire` remains only for official npm `dsh`. Verified on this machine against the installed harness (`dsh 0.1.5-rc.2`, Node 22) with the fork checkout at `0.1.6-alpha.2`: the control spawn reported `<unset>` while the decorated spawn reported the token, and the Loader mounted both rows from a generated `cordis.yml` with no unloaded entries. `dsh --profile multica --patch <patch> --dump-config` composes a profile insert last, after the bundle layers. The module is intentionally not a workspace package: `packages/*/*` members are publishable release members, and adding one would also churn `docs/config-catalog.md`, `docs/module-graph.md`, `tsconfig.base.json`, and `pnpm-lock.yaml` on every upstream merge.

</details>
