// Proves a release build carries no test seams: none of their names may appear
// anywhere in the bundled main process, preload or renderer. The e2e build
// keeps them on purpose (`electron-vite build --mode e2e`); `npm run dist`
// runs this after `build` so an installer is never produced from a build that
// still has them.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_DIRS, seamsIn } from './releaseSeams.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* jsFiles(path)
    else if (name.endsWith('.js') || name.endsWith('.cjs')) yield path
  }
}

const files = []
for (const part of RELEASE_DIRS) {
  const dir = join(root, part)
  let found
  try {
    found = [...jsFiles(dir)]
  } catch {
    console.error(`нет сборки в ${relative(root, dir)} — сначала npm run build и npm run build:relay`)
    process.exit(1)
  }
  if (found.length === 0) {
    console.error(`в ${relative(root, dir)} нет ни одного .js — сначала npm run build и npm run build:relay`)
    process.exit(1)
  }
  files.push(...found)
}

let found = 0
for (const file of files) {
  const names = seamsIn(readFileSync(file, 'utf8'))
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
