#!/usr/bin/env node
// Refreshes the network-derived packaging pins (release tarball sha256, AMO
// addon URL + sha256, Homebrew revision) for a version that already exists.
// Run AFTER the release tag is pushed and the addon is on AMO:
//
//   npm run refresh:pins [<version>]
//
// The version defaults to .version.json. The changed files are staged for
// the follow-up commit.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import pins from '../.versionrc/pins-helper.cjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const files = {
  nix: join(ROOT, 'nix/package.nix'),
  formula: join(ROOT, 'Formula/webhid.rb'),
  voidCore: join(ROOT, 'packaging/linux/void/webhid/template'),
  voidAddon: join(ROOT, 'packaging/linux/void/webhid-addon/template'),
  alpineCore: join(ROOT, 'packaging/linux/alpine/webhid/APKBUILD'),
  alpineAddon: join(ROOT, 'packaging/linux/alpine/webhid-addon/APKBUILD'),
  archAddon: join(ROOT, 'packaging/linux/archlinux/webhid-addon/PKGBUILD'),
  alpinePreInstall: join(ROOT, 'packaging/linux/alpine/webhid/webhid.pre-install')
}

function die(msg) {
  console.error(`ERROR: ${msg}`)
  process.exit(1)
}

function log(msg) {
  console.log(`==> ${msg}`)
}

function replaceQuoted(contents, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*")[^"]*(")`, 'm')
  if (!re.test(contents)) die(`pattern not found: ${key} = "..."`)
  return contents.replace(re, `$1${value}$2`)
}

function replaceBare(contents, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:"([^"]*)"|([^\\s]*))`, 'm')
  if (!re.test(contents)) die(`pattern not found: ${key}=...`)
  return contents.replace(re, (m, pre, quoted) =>
    quoted !== undefined ? `${pre}"${value}"` : `${pre}${value}`
  )
}

function replaceSha256sums(contents, hashes) {
  const re = /^sha256sums="[^"]*"/m
  if (!re.test(contents)) die('sha256sums block not found')
  return contents.replace(re, `sha256sums="\n${hashes.join('\n')}\n"`)
}

const version =
  process.argv[2] ?? JSON.parse(readFileSync(join(ROOT, '.version.json'), 'utf-8')).version
const tag = `v${version}`
if (!/^\d+\.\d+\.\d+/.test(version)) die(`invalid version: ${version}`)

log(`Refreshing packaging pins for ${tag}`)
const tarballSha = pins.tarballSha256(version)
const { url, sha256 } = pins.amoInfo(version)
const revision = pins.tagCommit(tag)
const preInstallSha = createHash('sha256')
  .update(readFileSync(files.alpinePreInstall))
  .digest('hex')
log(`  tarball sha256: ${tarballSha}`)
log(`  addon: ${url}`)
log(`  addon sha256: ${sha256}`)
log(`  homebrew revision: ${revision}`)

const changed = []

{
  let c = readFileSync(files.nix, 'utf-8')
  c = c.replace(/hash = "sha256-[^"]*"/, `hash = "${pins.toSRI(tarballSha)}"`)
  writeFileSync(files.nix, c)
  changed.push('nix/package.nix')
}

{
  let c = readFileSync(files.formula, 'utf-8')
  c = c.replace(/^(\s*revision:\s*")[^"]*(")/m, `$1${revision}$2`)
  writeFileSync(files.formula, c)
  changed.push('Formula/webhid.rb')
}

{
  let c = readFileSync(files.voidCore, 'utf-8')
  c = replaceBare(c, 'checksum', tarballSha)
  writeFileSync(files.voidCore, c)
  changed.push('packaging/linux/void/webhid/template')
}

{
  let c = readFileSync(files.voidAddon, 'utf-8')
  c = replaceBare(c, 'distfiles', url)
  c = replaceBare(c, 'checksum', sha256)
  writeFileSync(files.voidAddon, c)
  changed.push('packaging/linux/void/webhid-addon/template')
}

{
  let c = readFileSync(files.alpineCore, 'utf-8')
  c = replaceSha256sums(c, [tarballSha, preInstallSha])
  writeFileSync(files.alpineCore, c)
  changed.push('packaging/linux/alpine/webhid/APKBUILD')
}

{
  let c = readFileSync(files.alpineAddon, 'utf-8')
  c = replaceQuoted(c, '_amo_url', url)
  c = replaceSha256sums(c, [sha256])
  writeFileSync(files.alpineAddon, c)
  changed.push('packaging/linux/alpine/webhid-addon/APKBUILD')
}

{
  let c = readFileSync(files.archAddon, 'utf-8')
  c = replaceQuoted(c, '_amo_url', url)
  c = c.replace(/^sha256sums=\([^)]*\)/m, `sha256sums=('${sha256}')`)
  writeFileSync(files.archAddon, c)
  changed.push('packaging/linux/archlinux/webhid-addon/PKGBUILD')
}

execFileSync('git', ['add', ...changed])
console.log('')
log('Refreshed and staged:')
for (const f of changed) console.log(`  - ${f}`)
console.log('')
console.log(`Commit with: git commit -m "build(release): refresh packaging pins for ${tag}"`)
