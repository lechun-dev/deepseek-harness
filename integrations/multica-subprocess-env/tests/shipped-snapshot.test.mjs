/**
 * 2026-09-20 coder(lq): this fork ships a snapshot of the built module inside
 * @deepseek-ai/dsh-base. Fail when the built file and that snapshot drift.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const built = resolve(here, '../lib/index.js')
const shipped = resolve(here, '../../../packages/bundle/base/plugins/multica-subprocess-env.js')

/**
 * Drop the TypeScript sourceMappingURL trailer so the snapshot can live in git
 * without a sibling .map file.
 * @param source - emitted lib/index.js text.
 * @returns the same module with the mapping comment removed.
 */
function stripSourceMapping(source) {
  return source.replace(/\n\/\/# sourceMappingURL=.*\n?$/u, '\n')
}

describe('shipped base snapshot', () => {
  it('matches the built module with the sourceMappingURL stripped', () => {
    assert.equal(existsSync(built), true, 'missing ' + built + '; run npm run build')
    assert.equal(existsSync(shipped), true, 'missing ' + shipped)
    const expected = stripSourceMapping(readFileSync(built, 'utf8'))
    const actual = readFileSync(shipped, 'utf8')
    assert.equal(actual, expected)
  })
})
