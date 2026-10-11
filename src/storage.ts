import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function stateDirectory(root: string): Promise<string> {
  const path = join(root, '.prooflane');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error('ProofLane state directory must not be a symbolic link');
  return path;
}

export async function readJson(path: string, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if ((await lstat(path)).isSymbolicLink()) throw new Error('ProofLane JSON input must not be a symbolic link');
  const handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid or oversized ProofLane state file');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}

export async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('ProofLane state exceeds 16 MiB');
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await rename(temporary, join(directory, name));
  } finally { await handle.close(); await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
}
