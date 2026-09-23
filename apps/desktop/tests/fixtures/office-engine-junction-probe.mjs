/** Diagnostic-only native path alias; modifies a disposable npm installation, never the shipped patch. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const [root] = process.argv.slice(2)
assert.ok(root, 'Expected disposable installed package root')
const entry = resolve(root, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js')
const source = await readFile(entry, 'utf8')
const original = 'await runNative(native, resolvedOptions, inputPath, path, profile, result.fonts, result.substitutions, stopped);'
assert.equal(source.split(original).length, 2, 'Expected exactly one native conversion call')
const replacement = `await diagnosticRunNative(native, resolvedOptions, inputPath, path, profile, result.fonts, result.substitutions, stopped);`
const helper = `
async function diagnosticRunNative(engine, ...args) {
  const { symlink, unlink, lstat, stat } = await import('node:fs/promises');
  const assert = (await import('node:assert/strict')).default;
  const link = join(dirname(args[3]), 'e');
  await symlink(engine.root, link, 'junction');
  try {
    assert.ok((await lstat(link)).isSymbolicLink());
    const aliased = {
      ...engine,
      programDirectory: join(link, relative(engine.root, engine.programDirectory)),
      executable: join(link, relative(engine.root, engine.executable))
    };
    console.log('[DEBUG-office-junction]', JSON.stringify({ programDirectory: aliased.programDirectory, executable: aliased.executable, originalProgramDirectory: engine.programDirectory }));
    await runNative(aliased, ...args);
  } finally {
    // Unlink the junction before the owning scratch directory is recursively removed.
    await unlink(link);
    await assert.rejects(lstat(link), { code: 'ENOENT' });
    assert.ok((await stat(engine.executable)).isFile());
    assert.ok((await stat(engine.programDirectory)).isDirectory());
    console.log('[DEBUG-office-junction] alias removed; installed engine preserved');
  }
}
`
await writeFile(entry, source.replace(original, replacement) + helper)
console.log('Installed diagnostic native junction probe')
