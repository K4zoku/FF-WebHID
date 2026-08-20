const pins = require('./.versionrc.pins-helper.cjs')

const VERSION_REGEX = /^(\s*version\s*=\s*)([^\s]*)/m
const CHECKSUM_REGEX = /^(\s*checksum\s*=\s*)([^\s]*)/m

function readVersion(contents) {
  const match = contents.match(VERSION_REGEX)
  if (!match) throw new Error('version field not found in Void template')
  return match[2]
}

function writeVersion(contents, version) {
  if (!CHECKSUM_REGEX.test(contents)) throw new Error('checksum field not found in Void template')
  return contents
    .replace(VERSION_REGEX, `$1${version}`)
    .replace(CHECKSUM_REGEX, `$1${pins.tarballSha256(version)}`)
}

module.exports = { readVersion, writeVersion }
