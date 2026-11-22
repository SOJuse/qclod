// Writes the generated wizard images next to the other build resources.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { deflateSync } from 'node:zlib'
import { drawDmgBackground, drawHeader, drawSidebar, readAccent } from './installerArt.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const accent = readAccent(readFileSync(join(root, 'src/renderer/styles/tokens.css'), 'utf8'))

const masterSvg = readFileSync(join(root, 'build/brand/qclod.svg'), 'utf8')
function rasterMark(size) {
  const image = new Resvg(masterSvg, { fitTo: { mode: 'width', value: size } }).render()
  return { rgba: new Uint8Array(image.pixels), size }
}

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build/installerSidebar.bmp'), drawSidebar(accent, rasterMark(72)))
writeFileSync(join(root, 'build/installerHeader.bmp'), drawHeader(accent, rasterMark(36)))
// The Mac's DMG window (committed, unlike the BMPs: it is the one picture of the Mac build).
writeFileSync(join(root, 'build/dmgBackground.png'), drawDmgBackground(accent, rasterMark(48), deflateSync))
console.log('installer art written to build/')
