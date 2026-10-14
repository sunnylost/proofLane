import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const tree = { sampledMaxRssKiB: null, samples: 0, sampledMaxProcesses: 0, startupMs: 0, error: null };
function record(stdout, samplerPid) {
  const rows = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3 && row.every(Number.isFinite));
  if (!rows.some(([pid]) => pid === process.pid)) { tree.error = 'Sampler did not report the measured process'; return; }
  const family = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) if (pid !== samplerPid && family.has(parent) && !family.has(pid)) { family.add(pid); changed = true; }
  }
  tree.samples++;
  tree.sampledMaxRssKiB = Math.max(tree.sampledMaxRssKiB ?? 0, rows.filter(([pid]) => family.has(pid)).reduce((sum, row) => sum + row[2], 0));
  tree.sampledMaxProcesses = Math.max(tree.sampledMaxProcesses, family.size);
}

if (process.env.PROOFLANE_SAMPLE_TREE === '1' && process.platform === 'win32') {
  const started = performance.now();
  let sampler;
  try {
    sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; while ($true) { Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, WorkingSetSize FROM Win32_Process' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([math]::Ceiling($_.WorkingSetSize / 1024)) }; [Console]::Out.WriteLine('PROOFLANE_END'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 250 }"], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) { tree.error = error.message; }
  if (sampler) {
    let buffer = '', stderr = '', lastSample = performance.now(), stopping = false;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { tree.error = 'Windows sampler did not become ready'; sampler.kill(); resolve(); }, 5000);
      const ready = () => { clearTimeout(timeout); resolve(); };
      sampler.stdout.on('data', (chunk) => {
        buffer += chunk.toString().replaceAll('\r', '');
        let boundary;
        while ((boundary = buffer.indexOf('PROOFLANE_END\n')) >= 0) {
          record(buffer.slice(0, boundary), sampler.pid);
          buffer = buffer.slice(boundary + 'PROOFLANE_END\n'.length);
          lastSample = performance.now();
          ready();
        }
      });
      sampler.stderr.on('data', (chunk) => { stderr += chunk; });
      sampler.on('error', (error) => { tree.error = error.message; ready(); });
      sampler.on('close', () => { if (!stopping) tree.error ??= stderr.trim().slice(0, 500) || 'Windows sampler stopped'; ready(); });
    });
    tree.startupMs = Math.round(performance.now() - started);
    sampler.unref(); sampler.stdout.unref(); sampler.stderr.unref();
    const health = setInterval(() => {
      if (performance.now() - lastSample > 5000) { tree.error = 'Windows sampler stalled'; sampler.kill(); clearInterval(health); }
    }, 1000);
    health.unref();
    process.on('exit', () => { stopping = true; sampler.kill(); });
  }
} else if (process.env.PROOFLANE_SAMPLE_TREE === '1') {
  let pending = false;
  const sample = () => {
    if (pending) return;
    pending = true;
    let child;
    try {
      child = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    } catch (error) { tree.error = error.message; clearInterval(timer); pending = false; return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { tree.error = error.message; clearInterval(timer); });
    child.on('close', (code) => {
      pending = false;
      if (code !== 0) { tree.error ??= stderr.trim().slice(0, 500) || 'Process sampler failed or timed out'; clearInterval(timer); return; }
      record(stdout, child.pid);
    });
  };
  const timer = setInterval(sample, 250);
  timer.unref();
  sample();
}

process.on('exit', () => {
  writeFileSync(process.env.PROOFLANE_METRICS, JSON.stringify({ ...process.resourceUsage(), processTree: tree }));
});
