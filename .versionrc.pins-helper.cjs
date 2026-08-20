const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const REPO = 'K4zoku/FF-WebHID'
const AMO_ADDON_ID = 'webhid%40k4zoku.dev'

const tarballCache = new Map()
const amoCache = new Map()
const tagCache = new Map()

function die(msg) {
  console.error(`ERROR: ${msg}`)
  console.error('Release aborted: packaging pins could not be computed.')
  console.error('Fix the issue and re-run the release with --release-as <version> to retry the same bump.')
  process.exit(1)
}

function fetchUrl(url) {
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return execFileSync('curl', ['-fsSL', '--max-time', '60', url], {
        maxBuffer: 64 * 1024 * 1024
      })
    } catch (e) {
      lastErr = e
      if (attempt < 2) execFileSync('sleep', ['2'])
    }
  }
  die(`'curl -fsSL ${url}' failed after 3 attempts: ${lastErr.message}`)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function tarballSha256(version) {
  if (!tarballCache.has(version)) {
    const url = `https://github.com/${REPO}/archive/refs/tags/v${version}.tar.gz`
    tarballCache.set(version, sha256(fetchUrl(url)))
  }
  return tarballCache.get(version)
}

function toSRI(hex) {
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`
}

function amoInfo(version) {
  if (!amoCache.has(version)) {
    const url = `https://addons.mozilla.org/api/v5/addons/addon/${AMO_ADDON_ID}/versions/${version}/`
    let data
    try {
      data = JSON.parse(fetchUrl(url).toString('utf-8'))
    } catch (e) {
      die(`AMO API response for ${version} is not valid JSON: ${e.message}`)
    }
    const file = data && data.file
    if (!file || !file.url || !file.hash) die(`AMO has no file entry for version ${version}`)
    amoCache.set(version, { url: file.url, sha256: file.hash.replace(/^sha256:/, '') })
  }
  return amoCache.get(version)
}

function tagCommit(tag) {
  if (!tagCache.has(tag)) {
    const out = execFileSync(
      'git',
      ['ls-remote', `https://github.com/${REPO}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      { encoding: 'utf-8' }
    )
    const lines = out
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter(([sha, ref]) => sha && ref)
    const peeled = lines.find(([, ref]) => ref.endsWith('^{}'))
    const direct = lines.find(([, ref]) => !ref.endsWith('^{}'))
    if (!peeled && !direct) die(`could not resolve tag ${tag} on GitHub`)
    tagCache.set(tag, peeled ? peeled[0] : direct[0])
  }
  return tagCache.get(tag)
}

function fileSha256(rel) {
  return sha256(readFileSync(path.join(__dirname, rel)))
}

module.exports = { tarballSha256, toSRI, amoInfo, tagCommit, fileSha256 }
