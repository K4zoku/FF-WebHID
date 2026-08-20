const pins = require('./.versionrc.pins-helper.cjs')

const PKGVER_REGEX = /^(\s*pkgver\s*=\s*)([^\s]*)/m
const SHA256SUMS_REGEX = /^sha256sums="[^"]*"/m
const PRE_INSTALL = 'packaging/linux/alpine/webhid/webhid.pre-install'

function readVersion(contents) {
  const match = contents.match(PKGVER_REGEX)
  if (!match) throw new Error('pkgver field not found in Alpine APKBUILD')
  return match[2]
}

function writeVersion(contents, version) {
  if (!SHA256SUMS_REGEX.test(contents)) throw new Error('sha256sums block not found in Alpine APKBUILD')
  const sums = `${pins.tarballSha256(version)}\n${pins.fileSha256(PRE_INSTALL)}`
  return contents
    .replace(PKGVER_REGEX, `$1${version}`)
    .replace(SHA256SUMS_REGEX, `sha256sums="\n${sums}\n"`)
}

module.exports = { readVersion, writeVersion }
