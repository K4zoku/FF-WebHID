const pins = require('./pins-helper.cjs')

const VERSION_REGEX = /^(\s*version\s*=\s*")([^"]+)(")/m
const HASH_REGEX = /hash = "sha256-[^"]*"/

function readVersion(contents) {
  const match = contents.match(VERSION_REGEX)
  if (!match) throw new Error('version field not found in nix/package.nix')
  return match[2]
}

function writeVersion(contents, version) {
  if (!HASH_REGEX.test(contents)) throw new Error('source hash not found in nix/package.nix')
  return contents
    .replace(VERSION_REGEX, `$1${version}$3`)
    .replace(HASH_REGEX, `hash = "${pins.toSRI(pins.tarballSha256(version))}"`)
}

module.exports = { readVersion, writeVersion }
