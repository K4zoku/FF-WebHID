const VERSION_REGEX = /^(version\s*=\s*)"([^"]+)"/m;

function readVersion(contents) {
  const match = contents.match(VERSION_REGEX);
  if (!match) throw new Error('version field not found in Cargo.toml');
  return match[2];
}

function writeVersion(contents, version) {
  return contents.replace(VERSION_REGEX, `$1"${version}"`);
}

module.exports = { readVersion, writeVersion };
