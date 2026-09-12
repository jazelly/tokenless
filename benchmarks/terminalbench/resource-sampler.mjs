import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const command = async (file, args) => (await exec(file, args, { timeout: 8000, maxBuffer: 2 ** 20 })).stdout;
const seconds = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const bytes = value => {
  const match = value.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/);
  if (!match) return null;
  const powers = { B: 1, kB: 1000, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Number(match[1]) * powers[match[2]];
};

// CPU percentages use interval deltas; process 100% means one logical CPU.
export function createResourceSampler(meta, browserPid, daemonPid) {
  let previousCpu, previousProcesses = new Map(), previousAt;
  return async () => {
    const at = Date.now();
    const totals = os.cpus().reduce((sum, cpu) => {
      for (const [key, value] of Object.entries(cpu.times)) sum[key] = (sum[key] ?? 0) + value;
      return sum;
    }, {});
    let hostCpuBusyPercent = null;
    if (previousCpu) {
      const delta = Object.keys(totals).reduce((sum, key) => sum + totals[key] - previousCpu[key], 0);
      hostCpuBusyPercent = 100 * (1 - (totals.idle - previousCpu.idle) / delta);
    }
    previousCpu = totals;
    const [processText, vmText, dockerText] = await Promise.all([
      command('ps', ['-axo', 'pid=,ppid=,time=,rss=,comm=']),
      command('vm_stat', []),
      command('docker', ['ps', '--format', '{{json .}}']),
    ]);
    const processes = processText.trim().split('\n').map(line => {
      const [, pid, parent, time, rss, executable] = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
      const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
      return { pid: Number(pid), parent: Number(parent), seconds: Number(days) * 86400 + seconds(clock), rssBytes: Number(rss) * 1024, executable };
    });
    const descendantIds = root => {
      const ids = new Set([root]);
      for (let size = -1; size !== ids.size;) {
        size = ids.size;
        for (const process of processes) if (ids.has(process.parent)) ids.add(process.pid);
      }
      return ids;
    };
    const browserIds = descendantIds(browserPid);
    const groups = { browser: processes.filter(p => browserIds.has(p.pid)), daemon: processes.filter(p => p.pid === daemonPid), dockerHost: processes.filter(p => /com\.docker\.(backend|virtualization)|Virtualization\.VirtualMachine/.test(p.executable)) };
    const processGroups = Object.fromEntries(Object.entries(groups).map(([name, rows]) => [name, {
      pids: rows.map(p => p.pid), rssBytes: rows.reduce((sum, p) => sum + p.rssBytes, 0),
      cpuPercent: previousAt ? rows.reduce((sum, p) => sum + Math.max(0, p.seconds - (previousProcesses.get(p.pid) ?? p.seconds)), 0) / ((at - previousAt) / 1000) * 100 : null,
    }]));
    previousProcesses = new Map(processes.map(p => [p.pid, p.seconds])); previousAt = at;
    const prefixes = [];
    for (const entry of meta.tasks) {
      const names = await fs.readdir(entry.jobDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      prefixes.push(...names.filter(n => n.startsWith(entry.task + '__')).map(n => n.toLowerCase() + '__'));
    }
    const containers = dockerText.trim().split('\n').filter(Boolean).map(JSON.parse).filter(c => prefixes.some(prefix => c.Names.startsWith(prefix)));
    let statsText = '';
    let containerObservation = { availability: 'observed' };
    if (containers.length) {
      try {
        statsText = await command('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...containers.map(c => c.ID)]);
      } catch {
        // A trial may exit between discovery and docker stats; retain host data.
        containerObservation = { availability: 'unavailable', reason: 'docker_stats_failed' };
      }
    }
    const stats = statsText.trim().split('\n').filter(Boolean).map(JSON.parse).map(row => {
      const [used, limit] = row.MemUsage.split('/');
      return { name: row.Name, cpuPercent: Number.parseFloat(row.CPUPerc), memoryBytes: bytes(used), memoryLimitBytes: bytes(limit), pids: Number(row.PIDs) };
    });
    const pageSize = Number(vmText.match(/page size of (\d+) bytes/)[1]);
    const vm = Object.fromEntries([...vmText.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map(m => [m[1], Number(m[2]) * pageSize]));
    return { at: new Date(at).toISOString(), logicalCpus: os.cpus().length, hostCpuBusyPercent, hostMemory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), activeBytes: vm['Pages active'], inactiveBytes: vm['Pages inactive'], wiredBytes: vm['Pages wired down'], compressorBytes: vm['Pages occupied by compressor'] }, processGroups, containers: stats, containerObservation };
  };
}
