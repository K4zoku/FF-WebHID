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
  throw new Error('Could not find project root (crates/Cargo.toml)');
}

const projectRoot = findProjectRoot(__dirname);

export const DEFAULT_SOCKET = '/tmp/webhid-daemon.sock';

export interface DaemonProcess {
  process: ChildProcess;
  socketPath: string;
}

export async function startDaemon(socketPath: string = DEFAULT_SOCKET): Promise<DaemonProcess> {
  return new Promise((resolvePromise, reject) => {
    const bin = join(projectRoot, 'target', 'debug', 'webhid-daemon');
    if (!existsSync(bin)) {
      reject(new Error(`Daemon binary not found at ${bin}. Build with 'cargo build' first.`));
      return;
    }
    const proc = spawn(bin, ['--socket', socketPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('listening')) {
        resolvePromise({ process: proc, socketPath });
      }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        reject(new Error(`Daemon error: ${msg}`));
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code: number | null) => {
      reject(new Error(`Daemon exited with code ${code} before listening`));
    });
    setTimeout(() => reject(new Error('Daemon start timeout')), 10000);
  });
}

export function stopDaemon(daemon: DaemonProcess): void {
  daemon.process.kill('SIGTERM');
}

export interface UhidMockProcess {
  process: ChildProcess;
  ready: Promise<void>;
}

export function startUhidMock(
  descriptor: string,
  vid: number,
  pid: number,
  socketPath: string = DEFAULT_SOCKET,
): UhidMockProcess {
  const bin = join(projectRoot, 'target', 'debug', 'uhid-mock');
  if (!existsSync(bin)) {
    throw new Error(`uhid-mock binary not found at ${bin}. Build with 'cargo build' first.`);
  }
  const proc = spawn(bin, [
    '--socket', socketPath,
    '--descriptor', join(projectRoot, 'tests', 'e2e', 'fixtures', descriptor),
    '--vid', vid.toString(16),
    '--pid', pid.toString(16),
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolvePromise, reject) => {
    proc.stdout!.on('data', (data: Buffer) => {
      if (data.toString().includes('Device created')) {
        resolvePromise();
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code: number | null) => {
      reject(new Error(`uhid-mock exited with code ${code} before ready`));
    });
    setTimeout(() => reject(new Error('uhid-mock start timeout')), 10000);
  });
  return { process: proc, ready };
}

export function stopUhidMock(mock: UhidMockProcess): void {
  mock.process.kill('SIGTERM');
}

export function sendInput(mock: UhidMockProcess, reportId: number, data: number[]): void {
  const payload = Buffer.alloc(data.length + 1);
  payload[0] = reportId;
  for (let i = 0; i < data.length; i++) {
    payload[i + 1] = data[i];
  }
  mock.process.stdin!.write(payload);
}

export async function waitForOutputReport(
  mock: UhidMockProcess,
  timeout = 5000,
): Promise<{ reportId: number; data: number[] }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for output report')), timeout);
    mock.process.stdout!.once('data', (data: Buffer) => {
      clearTimeout(timer);
      resolvePromise({
        reportId: data[0],
        data: Array.from(data.subarray(1)),
      });
    });
  });
}

export function installNmManifest(socketPath: string): void {
  const nmDir = join(homedir(), '.mozilla', 'native-messaging-hosts');
  mkdirSync(nmDir, { recursive: true });
  const manifest = {
    name: 'webhid_daemon',
    description: 'WebHID daemon native messaging host',
    path: join(projectRoot, 'target', 'debug', 'nm-host'),
    type: 'stdio',
    allowed_extensions: ['webhid-polyfill@example.com'],
  };
  writeFileSync(join(nmDir, 'webhid_daemon.json'), JSON.stringify(manifest, null, 2));
}

export function uninstallNmManifest(): void {
  const manifestPath = join(homedir(), '.mozilla', 'native-messaging-hosts', 'webhid_daemon.json');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}

export function createProfile(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
}

export async function cleanupAll(): Promise<void> {
  for (const p of ['/tmp/webhid-daemon.sock', '/tmp/webhid-daemon.pid']) {
    if (existsSync(p)) await rm(p, { force: true });
  }
}
