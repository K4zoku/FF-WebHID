import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'fs';
import { readFile, writeFile, mkdir, rm, copyFile } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findProjectRoot(dir: string): string {
  while (dir !== '/') {
    if (existsSync(join(dir, 'crates', 'Cargo.toml'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('Could not find project root');
}

const PROJECT_ROOT = findProjectRoot(__dirname);
export const DEFAULT_SOCKET = '/tmp/webhid-e2e.sock';
const NM_MANIFEST_ID = 'webhid.forwarder_nm_host.json';
const NM_USER_DIR = join(homedir(), '.mozilla', 'native-messaging-hosts');

export interface DaemonProcess {
  process: ChildProcess;
  socketPath: string;
  pid: number;
}

export interface UhidMockProcess {
  process: ChildProcess;
  descriptor: string;
  vid: number;
  pid: number;
  ready: Promise<void>;
}

let _running: { daemon?: ChildProcess; uhid: ChildProcess[] } = { uhid: [] };

function resolveBin(name: string): string {
  const debug = join(PROJECT_ROOT, 'crates', 'target', 'debug', name);
  if (existsSync(debug)) return debug;
  const release = join(PROJECT_ROOT, 'crates', 'target', 'release', name);
  if (existsSync(release)) return release;
  throw new Error(`Binary not found: ${name} (looked at ${debug} and ${release})`);
}

function resolveFixture(name: string): string {
  const p = join(PROJECT_ROOT, 'tests', 'fixtures', 'descriptors', name);
  if (!existsSync(p)) throw new Error(`Fixture not found: ${p}`);
  return p;
}

async function waitForSocket(socketPath: string, timeoutMs = 15000): Promise<void> {
  const { existsSync } = await import('fs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await new Promise(r => setTimeout(r, 300));
  }
  // Check one more time
  if (existsSync(socketPath)) return;
  throw new Error(`Socket file not found within ${timeoutMs}ms: ${socketPath}`);
}

export async function startDaemon(socketPath = DEFAULT_SOCKET): Promise<DaemonProcess> {
  // Clean up stale socket from previous runs
  try { unlinkSync(socketPath); } catch {}
  const bin = resolveBin('webhid-daemon');
  const proc = spawn(bin, [], {
    env: {
      ...process.env,
      WEBHID_SOCKET: socketPath,
      RUST_LOG: 'debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
  proc.on('exit', (code) => {
    if (code !== 0 && _running.daemon) {
      console.error(`Daemon exited with code ${code}`);
    }
  });

  await waitForSocket(socketPath);

  const dp: DaemonProcess = { process: proc, socketPath, pid: proc.pid! };
  _running.daemon = proc;
  return dp;
}

export function stopDaemon(daemon: DaemonProcess): void {
  try { daemon.process.kill('SIGTERM'); } catch {}
  _running.daemon = undefined;
}

export async function startUhidMock(
  descriptorName: string,
  vid = 0x1234,
  pid = 0x5678,
): Promise<UhidMockProcess> {
  const bin = resolveBin('uhid-mock');
  const descPath = resolveFixture(descriptorName);
  const proc = spawn(bin, ['spawn', '--vid', String(vid), '--pid', String(pid), '--descriptor', descPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('uhid-mock ready timeout (20s)')), 20000);
    proc.stdout!.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'ready') {
            clearTimeout(timeout);
            resolve();
          }
        } catch {}
      }
    });
    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`uhid-mock exited with code ${code}`)); });
  });

  const mp: UhidMockProcess = { process: proc, descriptor: descriptorName, vid, pid, ready };
  _running.uhid.push(proc);
  return mp;
}

export function stopUhidMock(mock: UhidMockProcess): void {
  try {
    mock.process.stdin!.write(JSON.stringify({ cmd: 'destroy' }) + '\n');
  } catch {}
  setTimeout(() => { try { mock.process.kill(); } catch {} }, 1000);
  _running.uhid = _running.uhid.filter(p => p !== mock.process);
}

export function sendInput(mock: UhidMockProcess, reportId: number | undefined, data: number[]): void {
  const cmd = reportId !== undefined
    ? { cmd: 'input', reportId, data }
    : { cmd: 'input', data };
  mock.process.stdin!.write(JSON.stringify(cmd) + '\n');
}

export function waitForOutputReport(mock: UhidMockProcess, timeout = 10000): Promise<{ data: number[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for output_report')), timeout);
    const handler = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'output_report') {
            clearTimeout(timer);
            mock.process.stdout!.removeListener('data', handler);
            resolve({ data: ev.data || [] });
            return;
          }
        } catch {}
      }
    };
    mock.process.stdout!.on('data', handler);
  });
}

export async function installNmManifest(socketPath?: string): Promise<void> {
  const forwarderBin = resolveBin('webhid-native-messaging');
  const wrapperDir = mkdtempSync(join(tmpdir(), 'webhid-nm-wrapper-'));
  const wrapperPath = join(wrapperDir, 'nm-wrapper.sh');
  const effectiveSocket = socketPath || DEFAULT_SOCKET;
  writeFileSync(wrapperPath, `#!/bin/sh\nWEBHID_SOCKET="${effectiveSocket}" exec "${forwarderBin}"\n`);
  chmodSync(wrapperPath, 0o755);

  const template = join(PROJECT_ROOT, 'manifests', NM_MANIFEST_ID);
  let content = readFileSync(template, 'utf-8');
  content = content.replace('{{NM_BIN}}', wrapperPath);

  mkdirSync(NM_USER_DIR, { recursive: true });
  writeFileSync(join(NM_USER_DIR, NM_MANIFEST_ID), content);
}

export function uninstallNmManifest(): void {
  try {
    unlinkSync(join(NM_USER_DIR, NM_MANIFEST_ID));
  } catch {}
}

export async function createProfile(xpiPath?: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'webhid-e2e-'));
  const extensionsDir = join(dir, 'extensions');
  mkdirSync(extensionsDir, { recursive: true });

  if (xpiPath && existsSync(xpiPath)) {
    await copyFile(xpiPath, join(extensionsDir, 'webhid@k4zoku.dev.xpi'));
  }

  const userJs = `user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.allowPrivateBrowsingByDefault", true);`;
  writeFileSync(join(dir, 'user.js'), userJs);

  return dir;
}

export async function cleanupAll(): Promise<void> {
  uninstallNmManifest();
  for (const p of _running.uhid) {
    try { p.kill('SIGTERM'); } catch {}
  }
  _running.uhid = [];
  if (_running.daemon) {
    try { _running.daemon.kill('SIGTERM'); } catch {}
    _running.daemon = undefined;
  }
  await new Promise(r => setTimeout(r, 500));
}
