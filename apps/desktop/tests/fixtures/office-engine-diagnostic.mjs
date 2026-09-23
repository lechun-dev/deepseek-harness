/** Run real Office fixtures against a separately installed engine, without Electron or ASAR. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, fixtures] = process.argv.slice(2)
assert.ok(root && fixtures, 'Expected installed package root and fixture directory')
const entry = resolve(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')
const { createConverter } = await import(pathToFileURL(entry).href)
const converter = await createConverter()
console.log(JSON.stringify({ platform: process.platform, node: process.version, backend: converter.backend, entry, pathLength: entry.length }))
let failed = false
try {
  if (['junction-short', 'patched'].includes(process.env.DIAGNOSTIC_LAYOUT)) {
    const inputPath = resolve(fixtures, 'invalid.docx')
    const outputPath = resolve(fixtures, 'invalid.pdf')
    await writeFile(inputPath, 'not an Office document')
    await assert.rejects(converter.render({ inputPath, outputPath }))
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' })
    console.log('Invalid DOCX rejected; partial output removed')
  }
  for (const extension of ['docx', 'xlsx', 'pptx']) {
    const outputPath = resolve(fixtures, `output.${extension}.pdf`)
    try {
      await converter.render({ inputPath: resolve(fixtures, `input.${extension}`), outputPath })
      const pdf = await readFile(outputPath)
      assert.match(pdf.subarray(0, 8).toString(), /^%PDF-\d\.\d/u)
      assert.ok(pdf.subarray(-1024).toString().trimEnd().endsWith('%%EOF'))
      console.log(`${extension}: PDF conversion passed`)
    } catch (error) {
      failed = true
      console.error(`${extension}:`, error)
    }
  }
} finally {
  await converter.dispose()
}
if (failed) process.exitCode = 1
