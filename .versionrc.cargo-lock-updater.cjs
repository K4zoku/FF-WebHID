const fs = require('fs')
const path = require('path')

const CRATES_DIR = path.join(__dirname, 'crates')

function workspaceMemberVersions() {
  const ws = fs.readFileSync(path.join(CRATES_DIR, 'Cargo.toml'), 'utf8')
  const members = [...ws.matchAll(/^\s*"([^"]+)",\s*$/gm)].map((m) => m[1])
  const versions = {}
  for (const member of members) {
    const toml = fs.readFileSync(path.join(CRATES_DIR, member, 'Cargo.toml'), 'utf8')
    const v = toml.match(/^version\s*=\s*"([^"]+)"/m)
    if (v) versions[member] = v[1]
  }
  return versions
}

function readVersion(contents) {
  const versions = workspaceMemberVersions()
  for (const name of Object.keys(versions)) {
    const match = contents.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))
    if (match) return match[1]
  }
  throw new Error('no workspace member found in Cargo.lock')
}

function writeVersion(contents) {
  const versions = workspaceMemberVersions()
  const lines = contents.split('\n')
  let inBlock = false
  let blockName = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '[[package]]') {
      inBlock = true
      blockName = null
      continue
    }
    if (!inBlock) continue
    if (line === '') {
      inBlock = false
      continue
    }
    const nameMatch = line.match(/^name = "([^"]+)"$/)
    if (nameMatch) {
      blockName = nameMatch[1]
      continue
    }
    if (blockName && line.startsWith('version = "') && versions[blockName] != null) {
      lines[i] = `version = "${versions[blockName]}"`
      blockName = null
    }
  }
  return lines.join('\n')
}

module.exports = { readVersion, writeVersion }
