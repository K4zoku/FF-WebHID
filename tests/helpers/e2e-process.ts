import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
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

// User-mode daemon default socket, matching the forwarder's candidate list
// ($XDG_RUNTIME_DIR/webhid/webhid.sock). The e2e daemon must listen here so the
// NM forwarder spawned by the test Firefox can find it without env overrides.
const xdgRuntime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
export const DEFAULT_SOCKET = join(xdgRuntime, 'webhid', 'webhid.sock');

export interface DaemonProcess {
  process: ChildProcess;
  socketPath: string;
}

export async function startDaemon(socketPath: string = DEFAULT_SOCKET): Promise<DaemonProcess> {
  return new Promise((resolvePromise, reject) => {
    const bin = join(projectRoot, 'crates', 'target', 'debug', 'webhid-daemon');
    if (!existsSync(bin)) {
      reject(new Error(`Daemon binary not found at ${bin}. Build with 'cargo build' first.`));
      return;
    }
    const resolvedSocket = resolve(socketPath);
    const tmpDir = resolve('/tmp');
    if (!resolvedSocket.startsWith(tmpDir + '/') && !resolvedSocket.startsWith(projectRoot)) {
      throw new Error(`socketPath must be under ${tmpDir} or ${projectRoot}`);
    }
    const proc = spawn(bin, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WEBHID_SOCKET: resolvedSocket },
    });
    const onData = (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('listening')) {
        resolvePromise({ process: proc, socketPath });
      }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
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

export interface WebhidMockProcess {
  process: ChildProcess;
  ready: Promise<void>;
}

export function startWebhidMock(
  descriptor: string,
  vid: number,
  pid: number,
  _socketPath: string = DEFAULT_SOCKET,
): WebhidMockProcess {
  const bin = join(projectRoot, 'crates', 'target', 'debug', 'webhid-mock');
  if (!existsSync(bin)) {
    throw new Error(`webhid-mock binary not found at ${bin}. Build with 'cargo build' first.`);
  }
  if (descriptor.includes('/') || descriptor.includes('\\') || descriptor === '..' || descriptor.startsWith('..')) {
    throw new Error(`Invalid descriptor filename: ${descriptor}`);
  }
  const proc = spawn(bin, [
    'spawn',
    '--vid', `0x${vid.toString(16)}`,
    '--pid', `0x${pid.toString(16)}`,
    '--descriptor', join(projectRoot, 'tests', 'fixtures', 'descriptors', descriptor),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise<void>((resolvePromise, reject) => {
    proc.stdout.on('data', (data: Buffer) => {
      if (data.toString().includes('ready')) {
        resolvePromise();
      }
    });
    proc.on('error', reject);
    proc.on('exit', (code: number | null) => {
      reject(new Error(`webhid-mock exited with code ${code} before ready`));
    });
    setTimeout(() => reject(new Error('webhid-mock start timeout')), 10000);
  });
  return { process: proc, ready };
}

export function stopWebhidMock(mock: WebhidMockProcess): void {
  try {
    mock.process.stdin!.write('{"cmd":"destroy"}\n');
  } catch {}
  mock.process.kill('SIGTERM');
}

export function sendInput(mock: WebhidMockProcess, reportId: number, data: number[]): void {
  const cmd = JSON.stringify({
    cmd: 'input',
    reportId: reportId,
    data: data,
  });
  mock.process.stdin!.write(cmd + '\n');
}

export async function waitForOutputReport(
  mock: WebhidMockProcess,
  timeout = 5000,
): Promise<{ reportId: number; data: number[] }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for output report')), timeout);
    mock.process.stdout!.on('data', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as { event: string; data?: number[] };
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

export function installNmManifest(_socketPath: string): void {
  const nmDir = join(homedir(), '.mozilla', 'native-messaging-hosts');
  mkdirSync(nmDir, { recursive: true });
  const manifest = {
    name: 'webhid.forwarder_nm_host',
    description: 'WebHID daemon native messaging host (e2e: debug forwarder)',
    path: join(projectRoot, 'crates', 'target', 'debug', 'webhid-native-messaging'),
    type: 'stdio',
    allowed_extensions: ['webhid@k4zoku.dev'],
  };
  writeFileSync(join(nmDir, 'webhid.forwarder_nm_host.json'), JSON.stringify(manifest, null, 2));
}

export function uninstallNmManifest(): void {
  const manifestPath = join(homedir(), '.mozilla', 'native-messaging-hosts', 'webhid.forwarder_nm_host.json');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}

export function createProfile(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
}

export async function cleanupAll(): Promise<void> {
  for (const p of [DEFAULT_SOCKET, '/tmp/webhid-daemon.sock', '/tmp/webhid-daemon.pid']) {
    if (existsSync(p)) await rm(p, { force: true });
  }
}
