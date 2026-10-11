import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AnalyzerName } from './types.js';

export async function localTool(root: string, name: AnalyzerName, start = root): Promise<{ version: string; bin: string }> {
  let directory = await realpath(start);
  const within = relative(root, directory);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Tool lookup must start inside the repository');
  while (true) {
    let path: string;
    try { path = await realpath(join(directory, 'node_modules', name, 'package.json')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (directory === root) throw new Error(`${name} is not installed within this repository`);
      directory = dirname(directory); continue;
    }
    const manifest = z.object({ version: z.string(), bin: z.union([z.string(), z.record(z.string(), z.string())]) }).parse(JSON.parse(await readFile(path, 'utf8')));
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
    if (!entry) throw new Error(`${name} has no executable entrypoint`);
    return { version: manifest.version, bin: resolve(dirname(path), entry) };
  }
}
