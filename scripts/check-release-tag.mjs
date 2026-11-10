// Reads RELEASE_TAG and package.json; exits 1 when they disagree.
import { readFileSync } from 'node:fs'
import { tagMatchesVersion } from './releaseTag.mjs'

const tag = process.env.RELEASE_TAG ?? ''
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)

if (!tagMatchesVersion(tag, version)) {
  console.error(`тег ${tag} не совпадает с версией ${version} в package.json`)
  process.exit(1)
}
console.log(`тег ${tag} совпадает с версией ${version}`)
