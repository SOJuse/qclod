// Writes the generated wizard images next to the other build resources.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drawHeader, drawSidebar, readAccent } from './installerArt.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const accent = readAccent(readFileSync(join(root, 'src/renderer/styles/tokens.css'), 'utf8'))

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build/installerSidebar.bmp'), drawSidebar(accent))
writeFileSync(join(root, 'build/installerHeader.bmp'), drawHeader(accent))
console.log('installer art written to build/')
