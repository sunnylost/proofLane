import { writeFileSync } from 'node:fs';

process.on('exit', () => {
  writeFileSync(process.env.PROOFLANE_METRICS, JSON.stringify(process.resourceUsage()));
});
