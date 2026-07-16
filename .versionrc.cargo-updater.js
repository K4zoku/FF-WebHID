module.exports.readVersion = function (contents) {
  const match = contents.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('version field not found in Cargo.toml');
  return match[1];
};

module.exports.writeVersion = function (contents, version) {
  return contents.replace(/^(version\s*=\s*)"[^"]+"/m, '$1"' + version + '"');
};
