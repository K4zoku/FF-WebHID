const pins = require('./pins-helper.cjs')

const PKGVER_REGEX = /^(\s*pkgver\s*=\s*)([^\s]*)/m
const AMO_URL_REGEX = /^(\s*_amo_url\s*=\s*")([^"]*)(")/m
const SHA256SUMS_REGEX = /^sha256sums="[^"]*"/m

function readVersion(contents) {
  const match = contents.match(PKGVER_REGEX)
  if (!match) throw new Error('pkgver field not found in Alpine addon APKBUILD')
  return match[2]
}

function writeVersion(contents, version) {
  const { url, sha256 } = pins.amoInfo(version)
  if (!AMO_URL_REGEX.test(contents)) throw new Error('_amo_url field not found in Alpine addon APKBUILD')
  if (!SHA256SUMS_REGEX.test(contents)) throw new Error('sha256sums block not found in Alpine addon APKBUILD')
  return contents
    .replace(PKGVER_REGEX, `$1${version}`)
    .replace(AMO_URL_REGEX, `$1${url}$3`)
    .replace(SHA256SUMS_REGEX, `sha256sums="\n${sha256}\n"`)
}

module.exports = { readVersion, writeVersion }
