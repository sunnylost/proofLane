import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: string;
}

export function run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: '', failure: 'Verification cancelled' });
      return;
    }
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: string | undefined;
    let finished = false;
    const stop = (reason: string) => {
      failure ??= reason;
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure += `; could not terminate process: ${String(error)}`;
        }
      }
    };
    const timer = setTimeout(() => stop(`Process timed out after ${timeoutMs}ms`), timeoutMs);
    const cancel = () => stop('Verification cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop('Process output exceeded 8 MiB');
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), failure });
    };
    child.on('error', (error) => { failure ??= error.message; finish(null); });
    child.on('close', (code, exitSignal) => {
      if (exitSignal) failure ??= `Process terminated by ${exitSignal}`;
      finish(code);
    });
  });
}
