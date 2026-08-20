const VERSION_REGEX = /^(\s*version\s*=\s*")([^"]+)(")/m

function readVersion(contents) {
  const match = contents.match(VERSION_REGEX)
  if (!match) throw new Error('version field not found in nix/package.nix')
  return match[2]
}

function writeVersion(contents, version) {
  return contents.replace(VERSION_REGEX, `$1${version}$3`)
}

module.exports = { readVersion, writeVersion }
