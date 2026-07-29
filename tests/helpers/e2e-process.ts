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
    const proc = spawn(bin, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEBHID_SOCKET: socketPath },
    });
    const onData = (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('listening')) {
        resolvePromise({ process: proc, socketPath });
      }
    };
    proc.stderr!.on('data', onData);
    proc.stdout!.on('data', onData);
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
    'spawn',
    '--vid', '0x' + vid.toString(16),
    '--pid', '0x' + pid.toString(16),
    '--descriptor', join(projectRoot, 'tests', 'fixtures', 'descriptors', descriptor),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolvePromise, reject) => {
    proc.stdout!.on('data', (data: Buffer) => {
      if (data.toString().includes('ready')) {
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
  try {
    mock.process.stdin!.write('{"cmd":"destroy"}\n');
  } catch {}
  mock.process.kill('SIGTERM');
}

export function sendInput(mock: UhidMockProcess, reportId: number, data: number[]): void {
  const cmd = JSON.stringify({
    cmd: 'input',
    reportId: reportId,
    data: data,
  });
  mock.process.stdin!.write(cmd + '\n');
}

export async function waitForOutputReport(
  mock: UhidMockProcess,
  timeout = 5000,
): Promise<{ reportId: number; data: number[] }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for output report')), timeout);
    mock.process.stdout!.on('data', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.event === 'output_report') {
          clearTimeout(timer);
          resolvePromise({
            reportId: 0,
            data: parsed.data || [],
          });
        }
      } catch {
        // Ignore non-JSON output
      }
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
