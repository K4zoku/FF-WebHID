const pins = require('./pins-helper.cjs')

const VERSION_REGEX = /^(\s*version\s*=\s*)([^\s]*)/m
const DISTFILES_REGEX = /^(\s*distfiles\s*=\s*)(?:"[^"]*"|[^\s]*)/m
const CHECKSUM_REGEX = /^(\s*checksum\s*=\s*)([^\s]*)/m

function readVersion(contents) {
  const match = contents.match(VERSION_REGEX)
  if (!match) throw new Error('version field not found in Void addon template')
  return match[2]
}

function writeVersion(contents, version) {
  const { url, sha256 } = pins.amoInfo(version)
  if (!DISTFILES_REGEX.test(contents)) throw new Error('distfiles field not found in Void addon template')
  if (!CHECKSUM_REGEX.test(contents)) throw new Error('checksum field not found in Void addon template')
  return contents
    .replace(VERSION_REGEX, `$1${version}`)
    .replace(DISTFILES_REGEX, `$1"${url}"`)
    .replace(CHECKSUM_REGEX, `$1${sha256}`)
}

module.exports = { readVersion, writeVersion }
