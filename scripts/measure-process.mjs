import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const tree = { sampledMaxRssKiB: null, samples: 0, sampledMaxProcesses: 0, error: null };
if (process.env.PROOFLANE_SAMPLE_TREE === '1') {
  let pending = false;
  const sample = () => {
    if (pending) return;
    pending = true;
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([math]::Ceiling($_.WorkingSetSize / 1024)) }"], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5000 })
        : spawn('ps', ['-A', '-o', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    } catch (error) { tree.error = error.message; clearInterval(timer); pending = false; return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { tree.error = error.message; clearInterval(timer); });
    child.on('close', (code) => {
      pending = false;
      if (code !== 0) { tree.error ??= stderr.trim().slice(0, 500) || 'Process sampler failed or timed out'; clearInterval(timer); return; }
      const rows = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3 && row.every(Number.isFinite));
      if (!rows.some(([pid]) => pid === process.pid)) { tree.error = 'Sampler did not report the measured process'; return; }
      const family = new Set([process.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows) if (pid !== child.pid && family.has(parent) && !family.has(pid)) { family.add(pid); changed = true; }
      }
      const rss = rows.filter(([pid]) => family.has(pid)).reduce((sum, row) => sum + row[2], 0);
      tree.samples++;
      tree.sampledMaxRssKiB = Math.max(tree.sampledMaxRssKiB ?? 0, rss);
      tree.sampledMaxProcesses = Math.max(tree.sampledMaxProcesses, family.size);
    });
  };
  const timer = setInterval(sample, 250);
  timer.unref();
  sample();
}

process.on('exit', () => {
  writeFileSync(process.env.PROOFLANE_METRICS, JSON.stringify({ ...process.resourceUsage(), processTree: tree }));
});
