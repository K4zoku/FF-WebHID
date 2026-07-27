declare module 'module' {
  export function createRequire(filename: string): (id: string) => unknown;
}

declare module 'path' {
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function extname(path: string): string;
}

declare module 'url' {
  export function fileURLToPath(url: string): string;
}

declare module 'http' {
  interface Server {
    close(callback?: () => void): void;
    listen(port: number, callback?: () => void): void;
    address(): { port: number } | null;
  }
  type IncomingMessage = { url?: string };
  type ServerResponse = {
    writeHead(status: number, headers: Record<string, string>): void;
    end(data?: string): void;
  };
  function createServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}

declare module 'child_process' {
  interface ChildProcess {
    stdout: { on(event: 'data', listener: (data: Buffer) => void): void; once(event: 'data', listener: (data: Buffer) => void): void } | null;
    stderr: { on(event: 'data', listener: (data: Buffer) => void): void } | null;
    stdin: { write(data: Buffer): void } | null;
    kill(signal?: string): void;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'exit', listener: (code: number | null) => void): void;
  }
  function spawn(command: string, args?: string[], options?: { stdio?: (string | 'ignore' | 'pipe')[] }): ChildProcess;
}

declare module 'fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string, encoding?: string): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string): void;
  export function unlinkSync(path: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function mkdtempSync(prefix: string): string;
}

declare module 'fs/promises' {
  export function readFile(path: string): Promise<Buffer>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function rm(path: string, options?: { force?: boolean }): Promise<void>;
  export function copyFile(src: string, dest: string): Promise<void>;
}

declare module 'os' {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module 'events' {
  export function once(emitter: { once(event: string, listener: (...args: unknown[]) => void): void }, event: string): Promise<unknown[]>;
}

declare var Buffer: {
  alloc(size: number): Buffer;
  from(data: number[]): Buffer;
  isBuffer(obj: unknown): obj is Buffer;
};
interface Buffer {
  toString(encoding?: string): string;
  subarray(start?: number, end?: number): Buffer;
  readonly length: number;
  [index: number]: number;
}

interface ImportMeta {
  url: string;
}

declare module '../serve-policy.mjs' {
  import { Server } from 'http';
  export function startServer(port: number): Promise<{ port: number; server: Server }>;
}
