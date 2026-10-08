import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClusterMachineSampler } from './cluster-machine-sampler.js';
import { CapacityMonitor } from './capacity.js';
import { Store } from './store.js';

async function until(test: () => boolean) {
  for (let i = 0; i < 200 && !test(); i++) await delay(5);
  expect(test()).toBe(true);
}
function blockedSampler(failSecond = false) {
  const buffer = new SharedArrayBuffer(8),
    flags = new Int32Array(buffer);
  let starts = 0;
  const sampler = new ClusterMachineSampler(tmpdir(), () => {
    starts++;
    return new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const flags = new Int32Array(workerData.buffer);
       parentPort.on('message', () => {
         Atomics.add(flags, 0, 1);
         Atomics.wait(flags, 1, 0);
         if (workerData.failSecond && Atomics.load(flags, 0) > 1) throw new Error('sample failed');
         parentPort.postMessage({ processors: Array.from({length:8}, () => ({model:'CPU', speed:2000, times:{user:10,nice:0,sys:5,idle:85,irq:0}})), disk:{available:100,total:200} });
       });`,
      { eval: true, workerData: { buffer, failSecond } },
    );
  });
  return {
    sampler,
    flags,
    starts: () => starts,
    release: () => {
      Atomics.store(flags, 1, 1);
      Atomics.notify(flags, 1);
    },
  };
}

it('keeps HTTP responsive during a blocked compute sample, coalesces ticks and clips allocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-compute-sampler-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const blocked = blockedSampler();
  let now = Date.parse('2026-10-08T12:00:00Z');
  const monitor = new CapacityMonitor(
    store,
    root,
    async () => [],
    () => now,
    blocked.sampler,
  );
  monitor.allocationLimits = { cpus: 2, memoryMb: 8192 };
  const server = createServer((_request, response) => response.end('ready'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    monitor.sampleMachine();
    await until(() => Atomics.load(blocked.flags, 0) === 1);
    monitor.sampleMachine();
    monitor.sampleMachine();
    expect(monitor.resourceReading().machine).toBeNull();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      signal: AbortSignal.timeout(500),
    });
    expect(await response.text()).toBe('ready');
    expect(blocked.starts()).toBe(1);
    expect(Atomics.load(blocked.flags, 0)).toBe(1);
    blocked.release();
    await until(() => monitor.resourceReading().machine !== null);
    expect(monitor.resourceReading().machine).toMatchObject({
      cpuCount: 2,
      diskAvailableBytes: 100,
    });
    expect(monitor.resourceReading().machine!.memoryTotalBytes).toBeLessThanOrEqual(
      8192 * 1024 ** 2,
    );
    const observedAt = monitor.resourceReading().machine!.observedAt;
    now += 1000;
    await monitor.close();
    monitor.sampleMachine();
    expect(monitor.resourceReading().machine!.observedAt).toBe(observedAt);
  } finally {
    blocked.release();
    await monitor.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('terminates the owned blocked worker and discards pending and future readings on close', async () => {
  const blocked = blockedSampler();
  try {
    const first = blocked.sampler.sample();
    expect(blocked.sampler.sample()).toBe(first);
    await until(() => Atomics.load(blocked.flags, 0) === 1);
    await blocked.sampler.close();
    blocked.release();
    expect(await first).toBeNull();
    expect(await blocked.sampler.sample()).toBeNull();
    expect(blocked.starts()).toBe(1);
  } finally {
    blocked.release();
    await blocked.sampler.close();
  }
});

it('reports worker creation failures as unknown rather than fresh data', async () => {
  const sampler = new ClusterMachineSampler(tmpdir(), () => {
    throw new Error('unavailable');
  });
  expect(await sampler.sample()).toBeNull();
  await sampler.close();
});

it('retains the last observation time when the sampling worker fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-failed-sampler-'));
  const store = new Store(join(root, 'dock.sqlite'));
  const blocked = blockedSampler(true);
  let now = Date.parse('2026-10-08T12:00:00Z');
  const monitor = new CapacityMonitor(
    store,
    root,
    async () => [],
    () => now,
    blocked.sampler,
  );
  monitor.allocationLimits = { cpus: 2, memoryMb: 8192 };
  try {
    blocked.release();
    monitor.sampleMachine();
    await until(() => monitor.resourceReading().machine !== null);
    const observedAt = monitor.resourceReading().machine!.observedAt;
    now += 1000;
    monitor.sampleMachine();
    await until(() => Atomics.load(blocked.flags, 0) === 2);
    await delay(20);
    expect(monitor.resourceReading().machine!.observedAt).toBe(observedAt);
  } finally {
    await monitor.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('collects real CPU counters and filesystem capacity using the fixed worker program', async () => {
  const sampler = new ClusterMachineSampler(tmpdir());
  try {
    const sample = await sampler.sample();
    expect(sample!.processors.length).toBeGreaterThan(0);
    expect(sample!.processors[0]!.times.idle).toBeGreaterThanOrEqual(0);
    expect(sample!.disk!.total).toBeGreaterThan(0);
  } finally {
    await sampler.close();
  }
});

it('keeps ordinary local sampling on its existing path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'swa-local-sampler-'));
  const store = new Store(join(root, 'dock.sqlite'));
  let starts = 0;
  const sampler = new ClusterMachineSampler(root, () => {
    starts++;
    throw new Error('unexpected worker');
  });
  const monitor = new CapacityMonitor(store, root, async () => [], Date.now, sampler);
  try {
    monitor.sampleMachine();
    expect(monitor.resourceReading().machine!.cpuCount).toBeGreaterThan(0);
    expect(starts).toBe(0);
  } finally {
    await monitor.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
