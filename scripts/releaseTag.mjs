// A release is cut from a tag; the tag must be exactly "v" plus the version
// in package.json, otherwise the installer would carry one number and the
// release another.
export function tagMatchesVersion(tag, version) {
  return tag === `v${version}`
}
