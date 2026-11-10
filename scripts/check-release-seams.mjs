// Proves a release build carries no test seams: none of their names may appear
// anywhere in the bundled main process. The e2e build keeps them on purpose
// (`electron-vite build --mode e2e`); `npm run dist` runs this after `build`
// so an installer is never produced from a build that still has them.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const mainDir = join(root, 'out', 'main')
const SEAM = /QCLOD_(FAKE_SDK|FAKE_HISTORY|PICK_FOLDER|PICK_FILES|CONFIRM_BYPASS)/g

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* jsFiles(path)
    else if (name.endsWith('.js')) yield path
  }
}

let files
try {
  files = [...jsFiles(mainDir)]
} catch {
  console.error(`нет сборки в ${relative(root, mainDir)} — сначала npm run build`)
  process.exit(1)
}
if (files.length === 0) {
  console.error(`в ${relative(root, mainDir)} нет ни одного .js — сначала npm run build`)
  process.exit(1)
}

let found = 0
for (const file of files) {
  const names = new Set(readFileSync(file, 'utf8').match(SEAM) ?? [])
  for (const name of names) {
    console.error(`${relative(root, file)}: ${name}`)
    found++
  }
}

if (found > 0) {
  console.error('в релизной сборке остались тестовые лазейки')
  process.exit(1)
}
console.log('лазеек нет')
