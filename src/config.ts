import { join } from 'node:path';
import { z } from 'zod';
import { readJson } from './storage.js';

const schema = z.object({
  analyzers: z.array(z.enum(['oxlint', 'vitest', 'knip', 'react-doctor'])).min(1).max(4).refine((names) => new Set(names).size === names.length).default(['oxlint']),
  concurrency: z.number().int().min(1).max(4).default(2),
}).strict();

export async function readConfig(root: string): Promise<z.infer<typeof schema>> {
  try { return schema.parse(await readJson(join(root, 'prooflane.json'), 64 * 1024)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return schema.parse({}); throw new Error(`Invalid prooflane.json: ${String(error)}`); }
}
