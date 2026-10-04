import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({
  cpuCalls: 0,
  vmCalls: 0,
  ticks: 100,
  swaps: 4,
  processes: '',
  commands: '',
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  cpus: () => {
    probe.cpuCalls++;
    return [
      {
        model: 'fixture',
        speed: 1,
        times: { user: probe.ticks, nice: 0, sys: 0, idle: probe.ticks, irq: 0 },
      },
    ];
  },
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, output: string) => void,
  ) => {
    if (file.endsWith('vm_stat')) probe.vmCalls++;
    const output = file.endsWith('vm_stat')
      ? `page size of 4096 bytes\nPages free: 100.\nPages inactive: 100.\nPages speculative: 100.\nPages occupied by compressor: 20.\nSwapouts: ${probe.swaps}.`
      : file.endsWith('/ps')
        ? args.includes('pid=,lstart=,command=')
          ? probe.commands
          : probe.processes || ' 101 1 Mon Sep 28 10:00:00 2026 00:01.00 100 /fixture/app'
        : args.includes('vm.swapusage')
          ? 'used = 4M'
          : '1';
    callback(null, output);
  },
}));
import { CapacityMonitor } from './capacity.js';
import { ResourceProbe } from './resource-probe.js';
import { Store } from './store.js';

let root: string, store: Store, time: number, capacity: CapacityMonitor;
beforeEach(() => {
  Object.assign(probe, {
    cpuCalls: 0,
    vmCalls: 0,
    ticks: 100,
    swaps: 4,
    processes: '',
    commands: '',
  });
  root = mkdtempSync(join(tmpdir(), 'quark-shared-machine-'));
  store = new Store(join(root, 'dock.sqlite'));
  time = Date.now();
  capacity = new CapacityMonitor(
    store,
    root,
    async () => [],
    () => time,
  );
});
afterEach(async () => {
  await capacity.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'darwin')(
  'attributes descendants only to registered live roots, excludes unrelated names and handles PID reuse',
  async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    let roots = [
      {
        id,
        pid: 101,
        projectId: id,
        projectName: 'Research',
        name: 'Worker',
        kind: 'agent' as const,
        status: 'running',
      },
    ];
    const watcher = new ResourceProbe(
      () => capacity.resourceReading(),
      () => roots,
    );
    const signal = new AbortController().signal;
    const rows = (step: number, reused = false) =>
      [
        `101 1 Mon Sep 28 10:00:00 2026 00:0${1 + step}.00 100 /fixture/node`,
        `201 101 Mon Sep 28 ${reused ? '10:01:00' : '10:00:00'} 2026 ${reused ? '20:00.00' : `00:${10 + step * 2}.00`} 200 /fixture/node`,
        `202 201 Mon Sep 28 10:00:00 2026 00:0${5 + step}.00 300 /fixture/tool`,
        `301 1 Mon Sep 28 10:00:00 2026 01:${10 + step * 5}.00 90000 /fixture/node`,
      ].join('\n');
    probe.processes = rows(0);
    capacity.sampleMachine();
    expect((await watcher.sample(signal, time)).jobs[0]?.cpuPercent).toBeNull();
    time += 15000;
    probe.processes = rows(1);
    capacity.sampleMachine();
    const sample = await watcher.sample(signal, time);
    expect(sample.jobs).toHaveLength(1);
    expect(sample.jobs[0]).toMatchObject({ id, processes: 3, memoryBytes: 600 * 1024 });
    expect(sample.jobs[0]?.cpuPercent).toBeCloseTo((4 / 15) * 100);
    expect(JSON.stringify(sample.jobs)).not.toMatch(/pid|\/fixture/);
    time += 15000;
    probe.processes = rows(2, true);
    capacity.sampleMachine();
    expect((await watcher.sample(signal, time)).jobs[0]?.cpuPercent).toBeCloseTo((2 / 15) * 100);
    roots = [];
    time += 15000;
    capacity.sampleMachine();
    const closed = await watcher.sample(signal, time);
    expect(closed.jobs).toEqual([]);
    expect(closed.groups.length).toBeGreaterThan(0);
  },
);

it('shares CPU/volume/VM readings, uses VM timestamps for swap rate and resets across sleep', async () => {
  const watcher = new ResourceProbe(() => capacity.resourceReading());
  const signal = new AbortController().signal;
  capacity.sampleMachine();
  await watcher.sample(signal, time);
  time += 11_000;
  probe.ticks += 100;
  probe.swaps += 11;
  capacity.sampleMachine();
  await Promise.resolve();
  time += 4_000;
  const sample = await watcher.sample(signal, time);
  expect(probe.cpuCalls).toBe(2);
  expect(sample.hottestCorePercent).toBe(50);
  expect(sample.diskTotalBytes).toBe(capacity.resourceReading().diskTotalBytes);
  if (process.platform === 'darwin') {
    expect(probe.vmCalls).toBe(2);
    expect(sample.compressedBytes).toBe(20 * 4096);
    expect(sample.swapOutBytesPerSecond).toBe(4096); // 11 VM seconds, not 15 watcher seconds.
    expect(sample.groups[0]?.name).toBe('app');
  }
  time += 60_000;
  capacity.sampleMachine();
  const afterSleep = await watcher.sample(signal, time);
  expect(afterSleep.hottestCorePercent).toBeNull();
  expect(afterSleep.machine?.cpuUsedPercent).toBeNull();
  expect(afterSleep.swapOutBytesPerSecond).toBeNull();
});

it.skipIf(process.platform !== 'darwin')(
  'identifies selected Python scripts, ties only supervised descendants to QUARK, and rejects reused PIDs',
  async () => {
    const id = '10000000-0000-4000-8000-000000000002';
    const watcher = new ResourceProbe(
      () => capacity.resourceReading(),
      () => [
        {
          id,
          pid: 101,
          projectId: id,
          projectName: 'Simulations',
          name: 'Research worker',
          kind: 'agent',
          status: 'running',
        },
      ],
    );
    const signal = new AbortController().signal;
    probe.processes = [
      '101 1 Mon Sep 28 10:00:00 2026 00:01.00 100 /fixture/node',
      '201 101 Mon Sep 28 10:00:00 2026 00:01.00 100000 /fixture/python3',
      '301 1 Mon Sep 28 10:00:00 2026 00:01.00 20000 /fixture/python3',
    ].join('\n');
    probe.commands = [
      '201 Mon Sep 28 10:00:00 2026 python3 -u /private/project/simulate.py --api-key VERY_SECRET --url https://private.invalid',
      '301 Mon Sep 28 10:00:00 2026 python3 -m outside.worker --password VERY_SECRET',
    ].join('\n');
    capacity.sampleMachine();
    await watcher.sample(signal, time);
    time += 15000;
    probe.processes = probe.processes.replace(
      '201 101 Mon Sep 28 10:00:00 2026 00:01.00',
      '201 101 Mon Sep 28 10:00:00 2026 00:12.00',
    );
    capacity.sampleMachine();
    const reading = await watcher.sample(signal, time);
    expect(reading.processes.find((p) => p.pid === 201)).toMatchObject({
      entrypoint: 'simulate.py',
      jobId: id,
      projectId: id,
      parentName: 'node',
    });
    expect(reading.processes.find((p) => p.pid === 201)!.cpuPercent).toBeCloseTo((11 / 15) * 100);
    expect(reading.processes.find((p) => p.pid === 301)).toMatchObject({
      entrypoint: 'python -m outside.worker',
      jobId: null,
      projectId: null,
    });
    expect(JSON.stringify(reading)).not.toMatch(/VERY_SECRET|private.invalid|\/private/);
    // The old command line must not be attributed to a new process using this PID.
    time += 15000;
    probe.processes = probe.processes.replace(
      '201 101 Mon Sep 28 10:00:00',
      '201 101 Mon Sep 28 11:00:00',
    );
    capacity.sampleMachine();
    expect((await watcher.sample(signal, time)).processes.find((p) => p.pid === 201)).toMatchObject(
      { entrypoint: null, cpuPercent: 0 },
    );
  },
);
