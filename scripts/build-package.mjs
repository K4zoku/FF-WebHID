import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, chmodSync } from 'fs'
import { resolve, join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CRATES = join(ROOT, 'crates')
const MANIFESTS = join(ROOT, 'manifests')
const DIST = join(ROOT, 'dist')
const PACKAGING = join(ROOT, 'packaging')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

function die(msg) {
  console.error(`ERROR: ${msg}`)
  process.exit(1)
}

function log(msg) {
  console.log(`==> ${msg}`)
}

function template(src, dest, subs) {
  let s = readFileSync(src, 'utf-8')
  for (const [k, v] of Object.entries(subs)) s = s.replaceAll(k, v)
  writeFileSync(dest, s)
}

function checkBins(dir, ...names) {
  for (const n of names) {
    if (!existsSync(join(dir, n))) die(`${n} not found in ${dir}; build first`)
  }
}

function wipe(dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

function copyBins(srcDir, destDir, ...names) {
  for (const n of names) cpSync(join(srcDir, n), join(destDir, n))
}

const NM_BROWSERS = ['mozilla', 'librewolf', 'waterfox']

function installNmManifests(base, nmBin, daemonBin) {
  for (const b of NM_BROWSERS) {
    const d = join(base, `usr/lib/${b}/native-messaging-hosts`)
    mkdirSync(d, { recursive: true })
    template(
      join(MANIFESTS, 'webhid.forwarder_nm_host.json'),
      join(d, 'webhid.forwarder_nm_host.json'),
      { '{{NM_BIN}}': nmBin }
    )
    template(join(MANIFESTS, 'webhid.daemon_nm_host.json'), join(d, 'webhid.daemon_nm_host.json'), {
      '{{DAEMON_BIN}}': daemonBin
    })
  }
}

function installSystemd(base, daemonBin) {
  const d = join(base, 'usr/lib/systemd/system')
  mkdirSync(d, { recursive: true })
  template(join(MANIFESTS, 'webhid-daemon.service'), join(d, 'webhid-daemon.service'), {
    '{{DAEMON_BIN}}': daemonBin
  })
}

function installLicense(base) {
  const d = join(base, 'usr/share/licenses/webhid')
  mkdirSync(d, { recursive: true })
  cpSync(join(ROOT, 'LICENSE'), join(d, 'LICENSE'))
}

function buildDeb(ver, arch) {
  log(`Packaging deb ${ver} [${arch}]`)
  const binDir = join(CRATES, 'target/release')
  checkBins(binDir, 'webhid-daemon', 'webhid-native-messaging')

  const stage = join(DIST, 'stage-deb')
  wipe(stage)

  const DEBIAN = join(stage, 'DEBIAN')
  mkdirSync(DEBIAN, { recursive: true })
  writeFileSync(
    join(DEBIAN, 'control'),
    [
      `Package: webhid`,
      `Version: ${ver}`,
      `Architecture: ${arch}`,
      `Maintainer: K4zoku <k4zoku@pm.me>`,
      `Description: WebHID implementation for Firefox via native-messaging bridge and hidraw daemon`,
      ` Depends: libudev1`,
      `Section: utils`,
      `Priority: optional`,
      `Homepage: https://github.com/K4zoku/FF-WebHID`,
      ''
    ].join('\n')
  )
  writeFileSync(
    join(DEBIAN, 'postinst'),
    [
      '#!/bin/sh',
      'getent group webhid >/dev/null || groupadd --system webhid',
      'systemctl daemon-reload 2>/dev/null || true',
      'systemctl enable --now webhid-daemon.service 2>/dev/null || true',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(DEBIAN, 'prerm'),
    [
      '#!/bin/sh',
      'systemctl stop webhid-daemon.service 2>/dev/null || true',
      'systemctl disable webhid-daemon.service 2>/dev/null || true',
      ''
    ].join('\n')
  )
  chmodSync(join(DEBIAN, 'postinst'), 0o755)
  chmodSync(join(DEBIAN, 'prerm'), 0o755)

  const usr = join(stage, 'usr')
  mkdirSync(join(usr, 'bin'), { recursive: true })
  copyBins(binDir, join(usr, 'bin'), 'webhid-daemon', 'webhid-native-messaging')

  installSystemd(stage, '/usr/bin/webhid-daemon')
  installNmManifests(stage, '/usr/bin/webhid-native-messaging', '/usr/bin/webhid-daemon')
  installLicense(stage)

  const out = join(DIST, `webhid-${ver}-${arch}.deb`)
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', stage, out], { stdio: 'inherit' })
  log(`Done: ${out}`)
}

function prepareRpmTree(rpmRoot) {
  for (const d of ['BUILD', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS']) {
    mkdirSync(join(rpmRoot, d), { recursive: true })
  }
}

function writeRpmSpec(rpmRoot, ver, binDir) {
  const nmFileList = NM_BROWSERS.flatMap((b) => [
      `/usr/lib/${b}/native-messaging-hosts/webhid.forwarder_nm_host.json`,
      `/usr/lib/${b}/native-messaging-hosts/webhid.daemon_nm_host.json`
    ])
    .join('\n')

  writeFileSync(
    join(rpmRoot, 'SPECS/webhid.spec'),
    [
      `Name:           webhid`,
      `Version:        ${ver}`,
      `Release:        1`,
      `Summary:        WebHID implementation for Firefox via native-messaging bridge and hidraw daemon`,
      `License:        MIT`,
      `URL:            https://github.com/K4zoku/FF-WebHID`,
      `Requires:       systemd-libs`,
      `Requires(pre):  shadow-utils`,
      `Requires(post): systemd`,
      `Requires(preun): systemd`,
      ``,
      `%description`,
      `WebHID implements the navigator.hid WebHID API in Firefox, enabling websites`,
      `to interact with HID hardware via a native-messaging bridge and hidraw daemon.`,
      ``,
      `%install`,
      `install -Dm755 ${binDir}/webhid-daemon %{buildroot}/usr/bin/webhid-daemon`,
      `install -Dm755 ${binDir}/webhid-native-messaging %{buildroot}/usr/bin/webhid-native-messaging`,
      `install -d %{buildroot}/usr/lib/systemd/system`,
      `sed 's|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g' ${MANIFESTS}/webhid-daemon.service > %{buildroot}/usr/lib/systemd/system/webhid-daemon.service`,
      `for d in mozilla librewolf waterfox; do`,
      `  install -Dm644 ${MANIFESTS}/webhid.forwarder_nm_host.json %{buildroot}/usr/lib/$d/native-messaging-hosts/webhid.forwarder_nm_host.json`,
      `  sed -i 's|{{NM_BIN}}|/usr/bin/webhid-native-messaging|g' %{buildroot}/usr/lib/$d/native-messaging-hosts/webhid.forwarder_nm_host.json`,
      `  install -Dm644 ${MANIFESTS}/webhid.daemon_nm_host.json %{buildroot}/usr/lib/$d/native-messaging-hosts/webhid.daemon_nm_host.json`,
      `  sed -i 's|{{DAEMON_BIN}}|/usr/bin/webhid-daemon|g' %{buildroot}/usr/lib/$d/native-messaging-hosts/webhid.daemon_nm_host.json`,
      `done`,
      `install -Dm644 ${join(ROOT, 'LICENSE')} %{buildroot}/usr/share/licenses/webhid/LICENSE`,
      ``,
      `%pre`,
      `getent group webhid >/dev/null || groupadd -r webhid`,
      `exit 0`,
      ``,
      `%post`,
      `%systemd_post webhid-daemon.service`,
      ``,
      `%preun`,
      `%systemd_preun webhid-daemon.service`,
      ``,
      `%postun`,
      `%systemd_postun webhid-daemon.service`,
      ``,
      `%files`,
      `%license /usr/share/licenses/webhid/LICENSE`,
      `/usr/bin/webhid-daemon`,
      `/usr/bin/webhid-native-messaging`,
      `/usr/lib/systemd/system/webhid-daemon.service`,
      nmFileList,
      ''
    ].join('\n')
  )
}

function runRpmbuild(rpmRoot, arch) {
  execFileSync(
    'rpmbuild',
    [
      '-bb',
      `--define=_topdir ${rpmRoot}`,
      '--define=_binaries_in_noarch_packages_terminate_build 0',
      '--define=_unpackaged_files_terminate_build 0',
      `--target=${arch}`,
      join(rpmRoot, 'SPECS/webhid.spec')
    ],
    { stdio: 'inherit' }
  )
}

function collectRpmArtifacts(rpmRoot) {
  mkdirSync(DIST, { recursive: true })
  const rpms = execFileSync('find', [join(rpmRoot, 'RPMS'), '-name', '*.rpm'], {
    encoding: 'utf-8'
  })
    .trim()
    .split('\n')
    .filter(Boolean)
  let last = ''
  for (const rpm of rpms) {
    cpSync(rpm, join(DIST, basename(rpm)))
    last = rpm
  }
  return last
}

function buildRpm(ver, arch) {
  log(`Packaging rpm ${ver} [${arch}]`)
  const binDir = join(CRATES, 'target/release')
  checkBins(binDir, 'webhid-daemon', 'webhid-native-messaging')

  const rpmRoot = join(DIST, 'stage-rpm')
  wipe(rpmRoot)
  prepareRpmTree(rpmRoot)
  writeRpmSpec(rpmRoot, ver, binDir)
  runRpmbuild(rpmRoot, arch)
  const last = collectRpmArtifacts(rpmRoot)
  log(`Done: ${last || '(no rpm produced)'}`)
}

function toMsiVersion(ver) {
  const parts = ver
    .split('.')
    .map((p) => p.replace(/\D/g, ''))
    .filter((p) => p !== '')
  while (parts.length < 3) parts.push('0')
  return parts.slice(0, 4).join('.')
}

function buildMsi(ver, arch) {
  log(`Packaging msi ${ver} [${arch}]`)
  const rustTarget = arch === 'aarch64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const binDir = join(CRATES, `target/${rustTarget}/release`)
  checkBins(binDir, 'webhid-daemon.exe', 'webhid-native-messaging.exe')

  const stage = join(DIST, 'stage-msi')
  wipe(stage)

  copyBins(binDir, stage, 'webhid-daemon.exe', 'webhid-native-messaging.exe')
  template(
    join(MANIFESTS, 'webhid.forwarder_nm_host.json'),
    join(stage, 'webhid.forwarder_nm_host.json'),
    { '{{NM_BIN}}': 'C:\\Program Files\\WebHID\\webhid-native-messaging.exe' }
  )
  template(
    join(MANIFESTS, 'webhid.daemon_nm_host.json'),
    join(stage, 'webhid.daemon_nm_host.json'),
    { '{{DAEMON_BIN}}': 'C:\\Program Files\\WebHID\\webhid-daemon.exe' }
  )
  cpSync(join(PACKAGING, 'windows/License.rtf'), join(stage, 'License.rtf'))

  mkdirSync(DIST, { recursive: true })
  const out = join(DIST, `webhid-windows-${arch}-v${ver}.msi`)
  const wixArch = arch === 'aarch64' ? 'arm64' : 'x64'
  execFileSync(
    'wix',
    [
      'build',
      '-ext',
      'WixToolset.UI.wixext',
      '-arch',
      wixArch,
      '-d',
      `Version=${toMsiVersion(ver)}`,
      '-d',
      `BuildDir=${stage}`,
      '-o',
      out,
      join(PACKAGING, 'windows/webhid.wxs')
    ],
    { stdio: 'inherit' }
  )
  log(`Done: ${out}`)
}

function usage() {
  die(`Usage: node build-package.mjs <deb|rpm|msi> [--version=<ver>] [--arch=<arch>]`)
}

const type = process.argv[2]
if (!type) usage()

let ver = pkg.version
let arch = ''

const args = process.argv.slice(3)
for (const a of args) {
  if (a.startsWith('--version=')) ver = a.split('=')[1]
  else if (a.startsWith('--arch=')) arch = a.split('=')[1]
}

switch (type) {
  case 'deb':
    buildDeb(ver, arch || 'amd64')
    break
  case 'rpm':
    buildRpm(ver, arch || 'x86_64')
    break
  case 'msi':
    buildMsi(ver, arch || 'x86_64')
    break
  default:
    usage()
}
