/**
 * Unit coverage for the plugin's own decisions: which names it forwards, how it
 * layers them under a caller's explicit entries, and that unloading restores the
 * decorated runtime.
 *
 * The suite drives a real Cordis `Context` with a stub subprocess service, so it
 * runs without a harness build and without spawning anything. The real-child
 * proof lives in `child-env.test.mjs`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '../../../vendor/cordis/lib/index.js'
import * as plugin from '../lib/index.js'

/** Minimal subprocess service stand-in that records the specs it receives. */
class StubRuntime {
  /** Every `spawn` / `spawnTerminal` call in order. */
  calls = []
  /** Instance state the decorated method must still reach through `this`. */
  tag = 'stub'

  spawn(spec) {
    this.calls.push({ method: 'spawn', spec, tag: this.tag })
    return { handle: 'spawn' }
  }

  spawnTerminal(spec) {
    this.calls.push({ method: 'spawnTerminal', spec, tag: this.tag })
    return { handle: 'terminal' }
  }
}

/**
 * Mount the stub service and the plugin.
 * @returns the context, the stub runtime, and the loaded plugin fiber.
 */
async function mount() {
  const ctx = new Context()
  const runtime = new StubRuntime()
  ctx.provide('subprocess', runtime)
  const fiber = await ctx.plugin(plugin)
  return { ctx, runtime, fiber }
}

describe('declared credential names', () => {
  it('forwards exactly the Multica task token', () => {
    assert.deepEqual(plugin.FORWARDED_ENV_NAMES, ['MULTICA_TOKEN'])
    assert.equal(plugin.name, 'multica-subprocess-env')
    assert.deepEqual(plugin.inject, ['subprocess'])
  })

  it('collects only names the source supplies', () => {
    assert.deepEqual(plugin.forwardedEnv({ MULTICA_TOKEN: 'mat_demo' }), { MULTICA_TOKEN: 'mat_demo' })
    assert.equal(plugin.forwardedEnv({}), undefined)
    assert.equal(plugin.forwardedEnv({ MULTICA_TOKEN: '' }), undefined)
    assert.equal(plugin.forwardedEnv({ MULTICA_TOKEN: undefined }), undefined)
  })

  it('leaves a spec untouched when nothing is forwarded', () => {
    const spec = { argv: ['true'] }
    assert.equal(plugin.withForwardedEnv(spec, {}), spec)
  })

  it('keeps a caller entry ahead of the forwarded value', () => {
    const decorated = plugin.withForwardedEnv(
      { argv: ['true'], env: { MULTICA_TOKEN: 'mat_caller', KEEP: 'yes' } },
      { MULTICA_TOKEN: 'mat_ambient' },
    )
    assert.deepEqual(decorated.env, { MULTICA_TOKEN: 'mat_caller', KEEP: 'yes' })
  })
})

describe('mounted runtime decoration', () => {
  it('adds the credential to every spawn and terminal spec', async () => {
    const { ctx, runtime } = await mount()
    const token = process.env.MULTICA_TOKEN
    process.env.MULTICA_TOKEN = 'mat_unit'
    try {
      ctx.subprocess.spawn({ argv: ['true'] })
      ctx.subprocess.spawnTerminal({ argv: ['bash'] })
    } finally {
      if (token === undefined) delete process.env.MULTICA_TOKEN
      else process.env.MULTICA_TOKEN = token
    }

    assert.deepEqual(runtime.calls.map(call => call.method), ['spawn', 'spawnTerminal'])
    for (const call of runtime.calls) {
      assert.equal(call.spec.env.MULTICA_TOKEN, 'mat_unit')
      assert.equal(call.tag, 'stub')
    }
    await ctx.fiber.dispose()
  })

  it('does not touch a spec when the harness has no credential', async () => {
    const { ctx, runtime } = await mount()
    const token = process.env.MULTICA_TOKEN
    delete process.env.MULTICA_TOKEN
    try {
      ctx.subprocess.spawn({ argv: ['true'] })
    } finally {
      if (token !== undefined) process.env.MULTICA_TOKEN = token
    }
    assert.equal(Object.hasOwn(runtime.calls[0].spec, 'env'), false)
    await ctx.fiber.dispose()
  })

  it('restores both entry points when the plugin unloads', async () => {
    const { ctx, runtime, fiber } = await mount()
    const decorated = { spawn: runtime.spawn, spawnTerminal: runtime.spawnTerminal }
    assert.notEqual(decorated.spawn, StubRuntime.prototype.spawn)
    assert.notEqual(decorated.spawnTerminal, StubRuntime.prototype.spawnTerminal)

    await fiber.dispose()
    assert.equal(runtime.spawn, StubRuntime.prototype.spawn)
    assert.equal(runtime.spawnTerminal, StubRuntime.prototype.spawnTerminal)
    await ctx.fiber.dispose()
  })

  it('never clobbers an entry point replaced while it was decorated', async () => {
    const { ctx, runtime, fiber } = await mount()
    const replacement = () => ({ handle: 'replacement' })
    runtime.spawn = replacement

    await fiber.dispose()
    assert.equal(runtime.spawn, replacement)
    assert.equal(runtime.spawnTerminal, StubRuntime.prototype.spawnTerminal)
    await ctx.fiber.dispose()
  })
})
