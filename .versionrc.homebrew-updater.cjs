const VERSION_REGEX = /^(\s*version\s+")([^"]+)(")/m
const TAG_REGEX = /^(\s*tag:\s*")v([^"]+)(")/m

function readVersion(contents) {
  const match = contents.match(VERSION_REGEX)
  if (!match) throw new Error('version field not found in Homebrew formula')
  return match[2]
}

function writeVersion(contents, version) {
  if (!TAG_REGEX.test(contents)) throw new Error('tag field not found in Homebrew formula')
  return contents
    .replace(TAG_REGEX, `$1v${version}$3`)
    .replace(VERSION_REGEX, `$1${version}$3`)
}

module.exports = { readVersion, writeVersion }
