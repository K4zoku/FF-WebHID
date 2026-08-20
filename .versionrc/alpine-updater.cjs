const PKGVER_REGEX = /^(\s*pkgver\s*=\s*)([^\s]*)/m

function readVersion(contents) {
  const match = contents.match(PKGVER_REGEX)
  if (!match) throw new Error('pkgver field not found in Alpine APKBUILD')
  return match[2]
}

function writeVersion(contents, version) {
  return contents.replace(PKGVER_REGEX, `$1${version}`)
}

module.exports = { readVersion, writeVersion }
