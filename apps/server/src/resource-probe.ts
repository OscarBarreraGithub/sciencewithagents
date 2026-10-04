import { execFile } from 'node:child_process';
import type { CpuInfo } from 'node:os';
import { basename } from 'node:path';
import {
  resourceSampleSchema,
  type MachineCapacity,
  type ResourceSample,
  type ResourceGroup,
  type ResourceJob,
  type ResourceProcess,
} from '@dock/shared';
export type ResourceRoot = Pick<
  ResourceJob,
  'id' | 'projectId' | 'projectName' | 'name' | 'kind' | 'status'
> & { pid: number };

const MiB = 1024 ** 2;
type ProcessReading = {
  identity: string;
  startedAt: string;
  pid: number;
  parentPid: number;
  name: string;
  cpuSeconds: number;
  memoryBytes: number;
};
export type MachineReading = {
  machine: MachineCapacity | null;
  cores: CpuInfo[];
  diskTotalBytes: number | null;
  compressedBytes: number | null;
  swapOutBytes: number | null;
  memoryObservedAt: number | null;
};
export function parseProcesses(raw: string): ProcessReading[] {
  const result: ProcessReading[] = [];
  for (const line of raw.split('\n')) {
    // comm contains only the executable path, never arguments, URLs or environment variables.
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+([\d:.\-]+)\s+(\d+)\s+(.+)$/.exec(
        line,
      );
    if (!match) continue;
    const pid = match[1]!,
      start = match[3]!,
      elapsed = match[4]!,
      rss = match[5]!,
      executable = match[6]!;
    const parts = elapsed.split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) continue;
    const seconds = parts.reverse().reduce((sum, n, i) => sum + n * 60 ** i, 0);
    const app = /(?:^|\/)([^/]+)\.app\//.exec(executable)?.[1];
    const name = (app ?? basename(executable)).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
    const started = Date.parse(start);
    if (!Number.isFinite(started)) continue;
    result.push({
      identity: `${pid}:${start}`,
      startedAt: new Date(started).toISOString(),
      pid: Number(pid),
      parentPid: Number(match[2]),
      name,
      cpuSeconds: seconds,
      memoryBytes: Number(rss) * 1024,
    });
  }
  return result;
}
/** Retain only an interpreter's entry point, never its options, code or data arguments. */
export function processEntrypoint(command: string, name: string): string | null {
  const python = /^python(?:\d+(?:\.\d+)*)?$/i.test(name);
  const node = /^(?:node|nodejs|bun|deno)$/i.test(name);
  const shell = /^(?:bash|zsh|sh|fish)$/i.test(name);
  if (!python && !node && !shell) return null;
  const tokens = (command.slice(0, 16384).match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((v) =>
    v.replace(/^(["'])(.*)\1$/, '$2'),
  );
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (['-c', '-e', '--eval', '-p', '--print'].includes(token)) return `${name} inline code`;
    if (python && token === '-m')
      return /^[A-Za-z_][\w.]*$/.test(tokens[i + 1] ?? '')
        ? `python -m ${tokens[i + 1]}`.slice(0, 200)
        : null;
    if (python && ['-W', '-X'].includes(token)) {
      i++;
      continue;
    }
    if (token === '--' || (python && /^-[uOBEIsSqvb]+$/.test(token))) continue;
    if (node && /^--(?:max-old-space-size|stack-size)=\d+$/.test(token)) continue;
    if (node && token === 'run') continue;
    if (token.startsWith('-')) return null;
    const script = basename(token);
    const extension = python ? /\.py[wc]?$/i : node ? /\.(?:[cm]?js|[cm]?ts|tsx)$/i : /\.sh$/i;
    return extension.test(script) && !/[\x00-\x1f\x7f?=]/.test(script)
      ? script.slice(0, 200)
      : null;
  }
  return null;
}
export function parseVm(raw: string) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(raw)?.[1]);
  const count = (name: string) => {
    const value = Number(new RegExp(`${name}:\\s+(\\d+)\\.`).exec(raw)?.[1]);
    return pageSize > 0 && Number.isFinite(value) ? value * pageSize : null;
  };
  return {
    compressedBytes: count('Pages occupied by compressor'),
    swapOutBytes: count('Swapouts'),
  };
}
export function parseSwap(raw: string) {
  const match = /used\s*=\s*([\d.]+)([KMGTP])/.exec(raw);
  return match ? Number(match[1]) * 1024 ** ('KMGTP'.indexOf(match[2]!) + 1) : null;
}
// This sysctl exports dispatch flags (1/2/4), not XNU's internal pressure enum (0/1/3).
export function parsePressure(raw: string): ResourceSample['memoryPressure'] {
  return (
    ({ '1': 'normal', '2': 'warning', '4': 'critical' } as const)[raw.trim() as '1' | '2' | '4'] ??
    'unknown'
  );
}
const read = (file: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 2500, maxBuffer: 2 * MiB, signal, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) =>
        error ? reject(new Error('Resource probe unavailable')) : resolve(stdout),
    );
  });

export class ResourceProbe {
  private entrypoints = new Map<string, { value: string | null; at: number }>();
  private previous: {
    at: number;
    processes: ProcessReading[] | null;
    cores: CpuInfo[];
    swap: number | null;
    swapAt: number | null;
    groups: ResourceGroup[];
    jobs: ResourceJob[];
  } | null = null;
  constructor(
    private reading: () => MachineReading,
    private roots: () => ResourceRoot[] = () => [],
  ) {}
  async sample(signal: AbortSignal, now = Date.now()): Promise<ResourceSample> {
    const mac = process.platform === 'darwin';
    const calls = mac
      ? [
          read('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,time=,rss=,comm='], signal),
          read('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], signal),
          read('/usr/sbin/sysctl', ['vm.swapusage'], signal),
        ]
      : [];
    const values = await Promise.allSettled(calls);
    const output = (i: number) => {
      const v = values[i];
      return v?.status === 'fulfilled' ? v.value : null;
    };
    const rawProcesses = output(0);
    const parsedProcesses = rawProcesses === null ? [] : parseProcesses(rawProcesses);
    const processes = parsedProcesses.length ? parsedProcesses : null;
    const shared = this.reading();
    const vm = shared;
    const cores = shared.cores;
    const previous = this.previous;
    const seconds = previous ? (now - previous.at) / 1000 : 0;
    const swapSeconds =
      vm.memoryObservedAt !== null && previous?.swapAt != null
        ? (vm.memoryObservedAt - previous.swapAt) / 1000
        : 0;
    // Sleep/restart gaps are not continuous measurements or evidence of a spike.
    const interval = seconds >= 1 && seconds <= 45;
    const coreUsage = cores.flatMap((core, i) => {
      const old = interval ? previous?.cores[i] : null;
      if (!old) return [];
      const total =
        Object.values(core.times).reduce((a, b) => a + b, 0) -
        Object.values(old.times).reduce((a, b) => a + b, 0);
      return total > 0
        ? [Math.max(0, Math.min(100, 100 * (1 - (core.times.idle - old.times.idle) / total)))]
        : [];
    });
    const oldProcesses = new Map(previous?.processes?.map((p) => [p.identity, p]) ?? []);
    const roots = this.roots();
    const byPid = new Map(processes?.map((p) => [p.pid, p]) ?? []);
    const owned = new Map(roots.map((root) => [root.pid, root]));
    const jobs = new Map<string, ResourceJob>();
    const owner = (process: ProcessReading): ResourceRoot | undefined => {
      const seen = new Set<number>();
      let current: ProcessReading | undefined = process;
      while (current && !seen.has(current.pid) && seen.size < 64) {
        seen.add(current.pid);
        const root = owned.get(current.pid);
        if (root) return root;
        current = byPid.get(current.parentPid);
      }
    };
    const groups = new Map<string, ResourceGroup>();
    const detailed: ResourceProcess[] = [];
    for (const process of processes ?? []) {
      const group = groups.get(process.name) ?? {
        name: process.name,
        processes: 0,
        cpuPercent: interval && previous?.processes ? 0 : null,
        memoryBytes: 0,
        memoryChangeBytes: null,
      };
      const old = oldProcesses.get(process.identity);
      const cpuPercent =
        interval && previous?.processes
          ? old
            ? ((Math.max(0, process.cpuSeconds - old.cpuSeconds) / seconds) * 100) /
              Math.max(1, cores.length)
            : 0
          : null;
      if (group.cpuPercent !== null && cpuPercent !== null) group.cpuPercent += cpuPercent;
      group.memoryBytes += process.memoryBytes;
      group.processes++;
      groups.set(process.name, group);
      const root = owner(process);
      detailed.push({
        pid: process.pid,
        parentPid: process.parentPid,
        startedAt: process.startedAt,
        name: process.name,
        entrypoint: null,
        parentName: byPid.get(process.parentPid)?.name ?? null,
        cpuPercent,
        memoryBytes: process.memoryBytes,
        jobId: root?.id ?? null,
        projectId: root?.projectId ?? null,
      });
      if (root) {
        const { pid: _pid, ...identity } = root;
        const job = jobs.get(root.id) ?? {
          ...identity,
          processes: 0,
          cpuPercent: cpuPercent === null ? null : 0,
          memoryBytes: 0,
          memoryChangeBytes: null,
        };
        if (job.cpuPercent !== null && cpuPercent !== null) job.cpuPercent += cpuPercent;
        job.processes++;
        job.memoryBytes += process.memoryBytes;
        jobs.set(root.id, job);
      }
    }
    for (const group of groups.values()) {
      const old = previous?.groups.find((p) => p.name === group.name);
      if (interval && old) group.memoryChangeBytes = group.memoryBytes - old.memoryBytes;
    }
    for (const job of jobs.values()) {
      const old = previous?.jobs.find((value) => value.id === job.id);
      if (interval && old) job.memoryChangeBytes = job.memoryBytes - old.memoryBytes;
    }
    const ranked = [...groups.values()].sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0));
    const byMemory = [...groups.values()].sort((a, b) => b.memoryBytes - a.memoryBytes);
    const selected = [
      ...new Map(
        [...ranked.slice(0, 10), ...byMemory.slice(0, 10)].map((g) => [g.name, g]),
      ).values(),
    ];
    const selectedProcesses = [
      ...new Map(
        [
          ...[...detailed].sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)).slice(0, 10),
          ...[...detailed].sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, 10),
        ].map((p) => [p.pid, p]),
      ).values(),
    ];
    const keyFor = (p: ResourceProcess) => `${p.pid}:${p.startedAt}`;
    const liveIdentities = new Set(detailed.map(keyFor));
    for (const key of this.entrypoints.keys())
      if (!liveIdentities.has(key)) this.entrypoints.delete(key);
    const unknown = selectedProcesses.filter(
      (p) =>
        /^(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|bash|zsh|sh|fish)$/i.test(p.name) &&
        (!this.entrypoints.has(keyFor(p)) || now - this.entrypoints.get(keyFor(p))!.at >= 60_000),
    );
    if (mac && unknown.length) {
      // Target only selected interpreters. Raw command lines exist only in this call;
      // they are never returned, logged, persisted or supplied to a model.
      const raw = await read(
        '/bin/ps',
        ['-ww', '-p', unknown.map((p) => p.pid).join(','), '-o', 'pid=,lstart=,command='],
        signal,
      ).catch(() => '');
      for (const line of raw.split('\n')) {
        const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/.exec(line);
        if (!match) continue;
        const p = unknown.find(
          (p) => p.pid === Number(match[1]) && Date.parse(p.startedAt) === Date.parse(match[2]!),
        );
        if (p)
          this.entrypoints.set(keyFor(p), { value: processEntrypoint(match[3]!, p.name), at: now });
      }
    }
    for (const p of selectedProcesses) {
      const cached = this.entrypoints.get(keyFor(p));
      p.entrypoint = cached && now - cached.at < 60_000 ? cached.value : null;
    }
    const base = shared.machine;
    const machine =
      base && now - Date.parse(base.observedAt) < 30_000
        ? {
            ...base,
            cpuUsedPercent: coreUsage.length
              ? coreUsage.reduce((a, b) => a + b, 0) / coreUsage.length
              : base.cpuUsedPercent,
          }
        : null;
    const sample = resourceSampleSchema.parse({
      observedAt: new Date(now).toISOString(),
      machine,
      hottestCorePercent: coreUsage.length ? Math.max(...coreUsage) : null,
      memoryPressure: parsePressure(output(1) ?? ''),
      compressedBytes: vm.compressedBytes,
      swapUsedBytes: parseSwap(output(2) ?? ''),
      swapOutBytesPerSecond:
        interval &&
        swapSeconds > 0 &&
        swapSeconds <= 45 &&
        vm.swapOutBytes !== null &&
        previous?.swap !== null &&
        previous?.swap !== undefined &&
        vm.swapOutBytes >= previous.swap
          ? (vm.swapOutBytes - previous.swap) / swapSeconds
          : null,
      diskTotalBytes: machine ? shared.diskTotalBytes : null,
      groups: selected,
      jobs: [...jobs.values()]
        .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0))
        .slice(0, 100),
      processCount: processes?.length ?? null,
      processes: selectedProcesses,
      unavailable: [
        !mac ? 'Detailed process and memory probes currently support macOS.' : '',
        mac && !processes ? 'App process readings unavailable.' : '',
        roots.some((root) => !jobs.has(root.id))
          ? 'Some owned process trees were not visible in this sample.'
          : '',
        jobs.size > 100 ? 'Only the busiest 100 owned work groups are shown.' : '',
        vm.compressedBytes === null ||
        parsePressure(output(1) ?? '') === 'unknown' ||
        parseSwap(output(2) ?? '') === null
          ? 'Some memory readings are unavailable.'
          : '',
        'GPU, temperatures, disk I/O and network traffic are not measured.',
      ].filter(Boolean),
    });
    this.previous = {
      at: now,
      processes,
      cores,
      swap: vm.swapOutBytes,
      swapAt: vm.memoryObservedAt,
      groups: [...groups.values()],
      jobs: [...jobs.values()],
    };
    return sample;
  }
}
