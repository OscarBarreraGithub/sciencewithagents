import type { CpuInfo } from 'node:os';
import { Worker } from 'node:worker_threads';

export type MachineSample = {
  processors: CpuInfo[];
  disk: { available: number; total: number } | null;
};

// Linux cpus() reads every host CPU's frequency synchronously. On compute nodes
// those sysfs reads can block for seconds; shared-filesystem statfs can too.
const program = `
const { parentPort, workerData } = require('node:worker_threads');
const { cpus } = require('node:os');
const { statfsSync } = require('node:fs');
parentPort.on('message', () => {
  try {
    const processors = cpus();
    let disk = null;
    try {
      const value = statfsSync(workerData.directory);
      disk = { available: value.bavail * value.bsize, total: value.blocks * value.bsize };
    } catch {}
    parentPort.postMessage({ processors, disk });
  } catch { parentPort.postMessage(null); }
});`;

/** One compute-owned sampler; pending ticks share work and never block HTTP. */
export class ClusterMachineSampler {
  private worker: Worker | null = null;
  private pending: Promise<MachineSample | null> | null = null;
  private resolve: ((sample: MachineSample | null) => void) | null = null;
  private closed = false;
  constructor(
    private readonly directory: string,
    private readonly create = (directory: string) =>
      new Worker(program, { eval: true, workerData: { directory } }),
  ) {}
  sample() {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) return this.pending;
    if (!this.worker) {
      let worker: Worker;
      try {
        worker = this.create(this.directory);
      } catch {
        return Promise.resolve(null);
      }
      this.worker = worker;
      worker.on('message', (sample: MachineSample | null) => {
        if (this.worker === worker) this.finish(sample);
      });
      worker.on('error', () => {
        if (this.worker === worker) {
          this.worker = null;
          this.finish(null);
        }
      });
      worker.on('exit', () => {
        if (this.worker === worker) {
          this.worker = null;
          this.finish(null);
        }
      });
      worker.unref();
    }
    this.pending = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.worker.postMessage(null);
    return this.pending;
  }
  private finish(sample: MachineSample | null) {
    const resolve = this.resolve;
    this.resolve = null;
    this.pending = null;
    resolve?.(this.closed ? null : sample);
  }
  async close() {
    this.closed = true;
    this.finish(null);
    await this.worker?.terminate();
    this.worker = null;
  }
}
