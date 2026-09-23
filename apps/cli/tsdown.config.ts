import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/**
 * The dsh CLI ships its command and the profile lifecycle shared with Desktop.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  // Bundle the patched bridge so npm consumers and Desktop do not reinstall unpatched code.
  entry: {
    bin: 'lib/types/bin.js',
    'profile-boot': 'lib/types/profile-boot.js',
    multica: require.resolve('dsh-profile-multica'),
    'multica-startup': require.resolve('dsh-profile-multica/startup'),
  },
  external: [/^@deepseek-ai\//u],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
})
