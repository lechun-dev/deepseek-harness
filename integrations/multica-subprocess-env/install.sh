#!/usr/bin/env bash
# Build the module and optionally wire it into a dsh profile.
#
#   bash install.sh                 # build + run the test suite
#   bash install.sh --no-test       # build only
#   bash install.sh --wire          # build, then print the profile patch it would write
#   bash install.sh --wire --yes    # build, then write the patch (backs the file up)
#   bash install.sh --unwire --yes  # remove the row again
#
# DSH_HOME and DSH_PROFILE select the patch file (default: ~/.dsh/profiles/multica).
# It never restarts anything: each dsh task starts a new harness process, so a
# wiring change is picked up by the next task.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
entry="$here/lib/index.js"
profile="${DSH_PROFILE:-multica}"
patch_file="${DSH_HOME:-$HOME/.dsh}/profiles/$profile/cordis.patch.yml"

die() { printf 'install.sh: %s\n' "$1" >&2; exit 1; }

build=true test=true wire=false unwire=false yes=false
for arg in "$@"; do
  case "$arg" in
    --no-build) build=false ;;
    --no-test) test=false ;;
    --wire) wire=true ;;
    --unwire) unwire=true ;;
    --yes|-y) yes=true ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[ -d "$repo/vendor/cordis" ] || die "not inside a DeepSeek Harness checkout (looked for $repo/vendor/cordis)"
[ -f "$repo/node_modules/typescript/bin/tsc" ] || die "the checkout has no TypeScript; run 'pnpm install' in $repo first"

if [ "$build" = true ]; then
  printf '==> building %s\n' "$here"
  node "$repo/node_modules/typescript/bin/tsc" -p "$here/tsconfig.json"
fi
[ -f "$entry" ] || die "build produced no $entry"

if [ "$test" = true ]; then
  printf '==> tests\n'
  ( cd "$here" && node --test 'tests/*.test.mjs' )
fi

node - "$patch_file" "$entry" "$wire" "$unwire" "$yes" <<'NODE'
const [patchFile, entry, wireArg, unwireArg, yesArg] = process.argv.slice(2)
const wire = wireArg === 'true'
const unwire = unwireArg === 'true'
const yes = yesArg === 'true'
const fs = require('node:fs')
const path = require('node:path')

const ROW_ID = 'multica-subprocess-env'
const row = ['- insert:', `    - id: ${ROW_ID}`, `      name: '${entry}'`].join('\n')

/** Split a patch file into its leading comment block and its top-level YAML entries. */
function splitEntries(source) {
  const lines = source.split('\n')
  const head = []
  let index = 0
  while (index < lines.length && (lines[index].trim() === '' || lines[index].trim().startsWith('#'))) {
    head.push(lines[index])
    index += 1
  }
  const entries = []
  let current
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^-\s/.test(line) || /^\[/.test(line.trim())) {
      current = [line]
      entries.push(current)
    } else if (current === undefined) {
      if (line.trim() !== '') entries.push([line])
    } else {
      current.push(line)
    }
  }
  return { head, entries: entries.map(entry => entry.join('\n').replace(/\s+$/, '')) }
}

const existing = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
const { head, entries } = splitEntries(existing)
const body = entries.filter(entry => entry.trim() !== '' && entry.trim() !== '[]')
const carriesRow = existing.includes(ROW_ID)

if (!wire && !unwire) {
  console.log(`\nProfile patch row (append to ${patchFile}):\n`)
  console.log(row)
  console.log('\nRun this script with --wire --yes to append it, or --unwire --yes to remove it.')
  process.exit(0)
}

const composed = `${body.length === 0 ? row : `${body.join('\n')}\n${row}`}\n`
const written = head.length === 0 ? composed : `${head.join('\n')}\n${composed}`

if (unwire) {
  if (!carriesRow) {
    console.log(`\n${patchFile} carries no ${ROW_ID} row; nothing to remove.`)
    process.exit(0)
  }
  const kept = entries.filter(entry => !entry.includes(ROW_ID))
  const removed = `${head.length === 0 ? '' : `${head.join('\n')}\n`}${kept.length === 0 ? '[]\n' : `${kept.join('\n')}\n`}`
  if (!yes) {
    console.log(`\nWould write to ${patchFile}:\n\n${removed}\nRe-run with --yes to write it.`)
    process.exit(0)
  }
  fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
  fs.writeFileSync(patchFile, removed)
  console.log(`\nRemoved the ${ROW_ID} row from ${patchFile} (backup written beside it).`)
  process.exit(0)
}

if (carriesRow) {
  console.log(`\n${patchFile} already carries a ${ROW_ID} row; leaving it alone.`)
  process.exit(0)
}
if (!yes) {
  console.log(`\nWould write to ${patchFile}:\n\n${written}\nRe-run with --yes to write it.`)
  process.exit(0)
}

fs.mkdirSync(path.dirname(patchFile), { recursive: true })
if (existing !== '') fs.copyFileSync(patchFile, `${patchFile}.bak-${Date.now()}`)
fs.writeFileSync(patchFile, written)
console.log(`\nWrote the ${ROW_ID} row to ${patchFile}${existing === '' ? '' : ' (backup written beside it)'}.`)
NODE
