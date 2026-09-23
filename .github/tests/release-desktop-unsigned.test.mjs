import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import yaml from 'js-yaml'

// Exercise the exact inline validator without GitHub credentials or network I/O.
const workflow = yaml.load(readFileSync(new URL('../workflows/release-desktop-unsigned.yml', import.meta.url), 'utf8'))
const script = workflow.jobs.release.steps[0].with.script
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const validate = new AsyncFunction('github', 'context', 'core', 'process', script)
const tag = 'dsh-v0.1.7-alpha.2-lechun.1'

async function run(overrides = {}) {
  const outputs = {}
  const source = {
    workflow_id: 42,
    head_repository: { full_name: 'owner/repo' },
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: 'abc',
    ...overrides.run,
  }
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: source }),
        getWorkflow: async () => ({ data: { id: 42 } }),
      },
      repos: { listTags() {} },
      git: {
        getRef: async () => ({ data: { object: { type: 'tag', sha: 'annotated' } } }),
        getTag: async () => ({ data: { object: { type: 'commit', sha: overrides.sha ?? 'abc' } } }),
      },
    },
    paginate: async () => overrides.tags ?? [{ name: tag, commit: { sha: 'abc' } }],
  }
  await validate(github, { repo: { owner: 'owner', repo: 'repo' } }, {
    setOutput: (key, value) => { outputs[key] = value }, notice() {},
  }, { env: { SOURCE_RUN_ID: overrides.id ?? '123', RELEASE_TAG: overrides.tag ?? '' } })
  return outputs
}

test('automatic release resolves annotated fork tag', async () => {
  assert.deepEqual(await run(), { tag, run_id: '123', sha: 'abc' })
})
test('manual release supports existing successful build', async () => {
  assert.equal((await run({ tag })).tag, tag)
})
test('untagged branch build skips publication', async () => {
  assert.deepEqual(await run({ tags: [] }), {})
})
test('ambiguous automatic tags require manual selection', async () => {
  await assert.rejects(run({ tags: [1, 2].map(n => ({ name: `dsh-v1-lechun.${n}`, commit: { sha: 'abc' } })) }), /Multiple/)
})
test('rejects tag SHA mismatch', async () => {
  await assert.rejects(run({ tag, sha: 'different' }), /SHA mismatch/)
})
test('rejects upstream tag and malformed run ID', async () => {
  await assert.rejects(run({ tag: 'dsh-v0.1.7-alpha.2' }), /Expected/)
  await assert.rejects(run({ id: '123; echo unsafe' }), /Invalid/)
})
for (const [name, source] of Object.entries({
  failed: { conclusion: 'failure' }, pending: { status: 'in_progress' },
  foreign: { head_repository: { full_name: 'other/repo' } },
  pr: { event: 'pull_request' }, wrongWorkflow: { workflow_id: 999 },
})) {
  test(`rejects ${name} source build`, async () => {
    await assert.rejects(run({ run: source }), /trusted/)
  })
}
