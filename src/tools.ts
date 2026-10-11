import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AnalyzerName } from './types.js';

export const analyzerVersions = {
  oxlint: { minimum: '1.74.0', recommended: '1.87.0', exclusiveMaximum: '2.0.0' },
  vitest: { minimum: '5.0.0', recommended: '5.0.3', exclusiveMaximum: '6.0.0' },
  knip: { minimum: '6.0.0', recommended: '6.41.0', exclusiveMaximum: '7.0.0' },
  'react-doctor': { minimum: '0.9.0', recommended: '0.9.17', exclusiveMaximum: '0.10.0' },
} satisfies Record<AnalyzerName, { minimum: string; recommended: string; exclusiveMaximum: string }>;

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
    const range = analyzerVersions[name];
    const parts = manifest.version.split('.').map(Number);
    const compare = (version: string) => parts.map((part, index) => part - Number(version.split('.')[index])).find((difference) => difference !== 0) ?? 0;
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version) || !parts.every(Number.isSafeInteger) || compare(range.minimum) < 0 || compare(range.exclusiveMaximum) >= 0) {
      throw new Error(`Unsupported ${name} version ${manifest.version}; supported >=${range.minimum} <${range.exclusiveMaximum} stable releases; recommended ${range.recommended}`);
    }
    const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[name];
    if (!entry) throw new Error(`${name} has no executable entrypoint`);
    return { version: manifest.version, bin: resolve(dirname(path), entry) };
  }
}
