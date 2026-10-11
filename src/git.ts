import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readlink, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
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

export function internalFile(file: string): boolean {
  return file.startsWith('.prooflane/runs/') || file === '.prooflane/baseline.lock' || file.startsWith('.prooflane/observations.') || file.startsWith('.prooflane/.tmp-');
}

export async function visibleFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const paths = [...new Set(splitPaths(await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], signal)))].filter((file) => !internalFile(file)).sort();
  const files: string[] = [];
  for (const file of paths) {
    try {
      if ((await lstat(join(root, file))).isDirectory()) {
        const directory = await realpath(join(root, file));
        if (await repositoryRoot(directory, signal) !== directory) throw new Error(`Submodule is not initialized: ${file}`);
        for (const child of await visibleFiles(directory, signal)) files.push(`${file}/${child}`);
      } else files.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push(file);
      else throw error;
    }
  }
  return files.sort();
}

export function sourceFile(file: string): boolean { return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file); }

export async function repositoryRoot(root: string, signal?: AbortSignal): Promise<string> {
  return realpath((await git(root, ['rev-parse', '--show-toplevel'], signal)).replace(/\n$/, ''));
}

export async function changedFiles(root: string, base: string | undefined, signal?: AbortSignal): Promise<{ files: string[]; deletedOrRenamed: boolean; base?: string }> {
  const revision = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${base ?? 'HEAD'}^{commit}`], signal, base === undefined)).trim();
  if (!revision) {
    return { files: await visibleFiles(root, signal), deletedOrRenamed: false };
  }
  const changes = splitPaths(await git(root, ['diff', '--name-status', '-z', '--find-renames', revision, '--'], signal));
  const files = new Set<string>();
  let deletedOrRenamed = false;
  for (let i = 0; i < changes.length;) {
    const status = changes[i++]!;
    const oldPath = changes[i++];
    if (!oldPath) throw new Error('Invalid Git diff output');
    files.add(oldPath);
    try { if ((await lstat(join(root, oldPath))).isDirectory()) deletedOrRenamed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (status.startsWith('R') || status.startsWith('C')) {
      const newPath = changes[i++];
      if (!newPath) throw new Error('Invalid Git rename output');
      files.add(newPath);
    }
    if (/^[DRTC]/.test(status)) deletedOrRenamed = true;
  }
  for (const file of splitPaths(await git(root, ['ls-files', '-z', '--others', '--exclude-standard'], signal))) files.add(file);
  return { files: [...files].filter((file) => !internalFile(file)).sort(), deletedOrRenamed, base: revision };
}

export async function snapshot(root: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await git(root, ['rev-parse', '--verify', 'HEAD'], signal, true));
  const index = await git(root, ['ls-files', '--stage', '-z'], signal);
  hash.update(index);
  if (splitPaths(index).some((entry) => entry.startsWith('160000 '))) hash.update(await git(root, ['submodule', 'status', '--recursive'], signal));
  const files = await visibleFiles(root, signal);
  const digests: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const position = next++;
      const file = files[position]!;
      if (signal?.aborted) throw new Error('Verification cancelled');
      const digest = createHash('sha256').update(`${file}\0`);
      try {
        const path = join(root, file);
        const metadata = await lstat(path);
        digest.update(`${metadata.mode}\0`);
        if (metadata.isSymbolicLink()) {
          const target = await realpath(path);
          const within = relative(root, target);
          if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || !(await stat(target)).isFile()) throw new Error(`Source symlink must point to a file inside the repository: ${file}`);
          digest.update(await readlink(path));
        } else if (!metadata.isFile()) throw new Error(`Non-regular file is not supported: ${file}`);
        for await (const chunk of createReadStream(path)) digest.update(chunk);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') digest.update('deleted\0');
        else throw error;
      }
      digests[position] = digest.digest('hex');
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  for (const digest of digests) hash.update(digest);
  return hash.digest('hex');
}
