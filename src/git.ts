import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './process.js';

async function git(root: string, args: string[], signal?: AbortSignal, allowFailure = false): Promise<string> {
  const result = await run('git', args, root, 30_000, signal);
  if (result.failure || (result.code !== 0 && !allowFailure)) {
    throw new Error(result.failure ?? `Git ${args[0]} failed: ${result.stderr.trim().slice(0, 1000)}`);
  }
  return result.code === 0 ? result.stdout : '';
}

function splitPaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

export async function repositoryRoot(root: string, signal?: AbortSignal): Promise<string> {
  return realpath((await git(root, ['rev-parse', '--show-toplevel'], signal)).trimEnd());
}

export async function changedFiles(root: string, base: string | undefined, signal?: AbortSignal): Promise<{ files: string[]; deletedOrRenamed: boolean; base?: string }> {
  const revision = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base ?? 'HEAD'}^{commit}`], signal, base === undefined)).trim();
  if (!revision) {
    return { files: [...new Set(splitPaths(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)))].sort(), deletedOrRenamed: false };
  }
  const changes = splitPaths(await git(root, ['diff', '--name-status', '-z', '--find-renames', revision, '--'], signal));
  const files = new Set<string>();
  let deletedOrRenamed = false;
  for (let i = 0; i < changes.length;) {
    const status = changes[i++]!;
    const oldPath = changes[i++];
    if (!oldPath) throw new Error('Invalid Git diff output');
    files.add(oldPath);
    if (status.startsWith('R') || status.startsWith('C')) {
      const newPath = changes[i++];
      if (!newPath) throw new Error('Invalid Git rename output');
      files.add(newPath);
    }
    if (/^[DRTC]/.test(status)) deletedOrRenamed = true;
  }
  for (const file of splitPaths(await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], signal))) files.add(file);
  return { files: [...files].sort(), deletedOrRenamed, base: revision };
}

export async function snapshot(root: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await git(root, ['rev-parse', '--verify', 'HEAD'], signal, true));
  hash.update(await git(root, ['ls-files', '--stage', '-z'], signal));
  const files = [...new Set(splitPaths(await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)))].sort();
  for (const file of files) {
    if (signal?.aborted) throw new Error('Verification cancelled');
    hash.update(`${file}\0`);
    try {
      const path = join(root, file);
      const stat = await lstat(path);
      hash.update(`${stat.mode}\0`);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported in the verification scope: ${file}`);
      if (!stat.isFile()) throw new Error(`Submodules and non-regular files are not supported: ${file}`);
      const fileHash = createHash('sha256');
      for await (const chunk of createReadStream(path)) fileHash.update(chunk);
      hash.update(fileHash.digest());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted\0');
      else throw error;
    }
  }
  return hash.digest('hex');
}
