import { execFile } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { cpus, freemem, totalmem, loadavg } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  defaultModelPolicy,
  modelPolicySchema,
  type ModelPolicy,
  providerCapacitySchema,
  capacityStatusSchema,
  type CapacityProvider,
  type CapacityWindow,
  type ProviderCapacity,
  type MachineCapacity,
} from '@dock/shared';
import { Store } from './store.js';
import { ClaudeCapacityError, nativeClaudeFetcher } from './claude-capacity.js';
import { parseVm, type MachineReading } from './resource-probe.js';

const prefix = 'capacity:v1:';
export const refreshSeconds = 60;
export const capacityStaleMs = 3 * 60_000;
// Claude's shared endpoint throttles frequent polling. Its successful cache spans one five-minute interval.
export const capacityMaxAge = (provider: CapacityProvider) =>
  provider === 'claude' ? 6 * 60_000 : capacityStaleMs;
export function macAvailableMemory(raw: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(raw)?.[1]);
  const values = ['free', 'inactive', 'speculative'].map((name) =>
    Number(new RegExp(`Pages ${name}:\\s+(\\d+)\\.`).exec(raw)?.[1]),
  );
  return pageSize > 0 && values.every(Number.isFinite)
    ? values.reduce((a, b) => a + b, 0) * pageSize
    : null;
}
const record = z.record(z.string(), z.unknown());
const finite = z.number().finite().min(0).max(100);
const windowInput = z.object({
  usedPercent: finite,
  windowMinutes: z.number().finite().positive().nullish(),
  resetsAt: z.string().nullish(),
});
type Fetcher = (provider: CapacityProvider, signal: AbortSignal) => Promise<unknown>;

function empty(provider: CapacityProvider): ProviderCapacity {
  return {
    provider,
    account: 'local-sign-in',
    label: provider === 'claude' ? 'Claude' : 'Codex',
    plan: null,
    source: 'codexbar-oauth',
    observedAt: null,
    attemptedAt: null,
    nextRefreshAt: null,
    state: 'unknown',
    stale: true,
    message: 'Waiting for this computer’s signed-in usage report.',
    windows: [],
    weeklyPolicy: 'not-reported',
  };
}

/** Pick fields, never persist arbitrary CLI output, account email, cookies or credentials. */
export function parseCapacity(
  provider: CapacityProvider,
  raw: unknown,
  now: number,
  policy: ModelPolicy = defaultModelPolicy,
): ProviderCapacity {
  const rows = z
    .array(record)
    .max(20)
    .parse(raw)
    .filter((row) => row.provider === provider);
  if (
    rows.length !== 1 ||
    !(
      rows[0]!.source === 'oauth' ||
      (provider === 'claude' && rows[0]!.source === 'claude-native-oauth')
    ) ||
    rows[0]!.error
  )
    throw new Error('No single authenticated usage report.');
  const usage = record.parse(rows[0]!.usage);
  const stamp = z.string().datetime({ offset: true }).parse(usage.updatedAt);
  const timestamp = Date.parse(stamp);
  if (timestamp > now + 30_000 || timestamp < now - capacityStaleMs)
    throw new Error('The provider returned an old or future report.');
  const windows: CapacityWindow[] = [];
  const add = (
    id: string,
    label: string,
    scope: CapacityWindow['scope'],
    model: string | null,
    input: unknown,
  ) => {
    if (input === undefined || input === null) return;
    const value = windowInput.parse(input);
    let resetsAt: string | null = null;
    if (value.resetsAt) {
      const date = Date.parse(value.resetsAt);
      if (!Number.isFinite(date)) throw new Error('Malformed reset time.');
      resetsAt = new Date(date).toISOString();
    }
    windows.push({
      id,
      label: label.slice(0, 160),
      scope,
      model,
      usedPercent: value.usedPercent,
      windowMinutes: value.windowMinutes ?? null,
      resetsAt,
    });
  };
  add('primary', 'Session', 'general', null, usage.primary);
  add('secondary', 'Weekly', 'general', null, usage.secondary);
  add('tertiary', 'Model allowance', 'model', null, usage.tertiary);
  const extras =
    usage.extraRateWindows == null ? [] : z.array(record).max(32).parse(usage.extraRateWindows);
  for (const extra of extras) {
    const id = z.string().min(1).max(120).parse(extra.id);
    const title = z.string().min(1).max(160).parse(extra.title);
    const words = `${id} ${title}`.toLowerCase().split(/[^a-z0-9]+/);
    const model =
      Object.values(policy.models[provider])
        .map((choice) => choice.family.toLowerCase())
        .find((family) => words.includes(family)) ?? null;
    add(`extra:${id}`, title, model ? 'model' : 'other', model, extra.window);
  }
  if (new Set(windows.map((w) => w.id)).size !== windows.length || windows.length === 0)
    throw new Error('No unambiguous usage windows.');
  return providerCapacitySchema.parse({
    ...empty(provider),
    source: rows[0]!.source === 'claude-native-oauth' ? 'claude-native-oauth' : 'codexbar-oauth',
    plan: typeof usage.loginMethod === 'string' ? usage.loginMethod.slice(0, 120) : null,
    observedAt: new Date(timestamp).toISOString(),
    state: 'ready',
    stale: false,
    message: 'Provider-reported allowance. All managers on this computer share this reading.',
    windows,
    weeklyPolicy: windows.some((w) => w.scope === 'general' && w.windowMinutes === 10080)
      ? 'reported'
      : 'not-reported',
  });
}

export function readCapacity(
  store: Store,
  provider: CapacityProvider,
  now = Date.now(),
): ProviderCapacity {
  const parsed = providerCapacitySchema.safeParse(store.getSetting(`${prefix}${provider}`));
  const value = parsed.success ? parsed.data : empty(provider);
  return {
    ...value,
    stale:
      value.state !== 'ready' ||
      !value.observedAt ||
      now - Date.parse(value.observedAt) > capacityMaxAge(provider),
  };
}

export function codexbarFetcher(binary: string): Fetcher {
  return (provider, signal) =>
    new Promise((resolve, reject) => {
      // A fixed OAuth read avoids browser-cookie scanning, account switching and model turns.
      execFile(
        binary,
        ['usage', '--provider', provider, '--source', 'oauth', '--format', 'json', '--no-credits'],
        { timeout: 30_000, maxBuffer: 512 * 1024, signal, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(new Error('Usage collector unavailable.'));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error('Invalid usage report.'));
          }
        },
      );
    });
}

export function collectorBinary(dataDir: string) {
  const installed = join(dataDir, 'tools', 'codexbar');
  return (
    process.env.DOCK_CODEXBAR_BIN ??
    (existsSync(installed) ? installed : '/opt/homebrew/bin/codexbar')
  );
}

export function sharedCapacityFetcher(dataDir: string): Fetcher {
  const codex = codexbarFetcher(collectorBinary(dataDir)),
    claude = nativeClaudeFetcher();
  return (provider, signal) => (provider === 'claude' ? claude(signal) : codex(provider, signal));
}

export class CapacityMonitor {
  private timer: NodeJS.Timeout | null = null;
  private pending = new Map<CapacityProvider, Promise<void>>();
  private failures = new Map<CapacityProvider, number>();
  private abort = new AbortController();
  private previousCpu: { idle: number; total: number; at: number } | null = null;
  private cores: MachineReading['cores'] = [];
  private diskTotalBytes: number | null = null;
  private machine: MachineCapacity | null = null;
  private closed = false;
  private memoryProbe: Promise<void> | null = null;
  private memoryReading: {
    bytes: number;
    observedAt: number;
    compressedBytes: number | null;
    swapOutBytes: number | null;
  } | null = null;
  constructor(
    readonly store: Store,
    readonly dataDir: string,
    private fetcher: Fetcher = sharedCapacityFetcher(dataDir),
    private clock = Date.now,
  ) {}

  start() {
    if (this.timer || this.closed) return;
    this.sampleMachine();
    void this.refresh();
    this.timer = setInterval(() => {
      this.sampleMachine();
      void this.refresh();
    }, 1000);
    this.timer.unref();
  }
  sampleMachine() {
    if (
      process.platform === 'darwin' &&
      !this.memoryProbe &&
      (!this.memoryReading || this.clock() - this.memoryReading.observedAt > 10_000)
    ) {
      this.memoryProbe = new Promise<void>((resolve) => {
        execFile(
          '/usr/bin/vm_stat',
          [],
          { timeout: 2000, maxBuffer: 16000, signal: this.abort.signal },
          (error, stdout) => {
            const bytes = error ? null : macAvailableMemory(stdout);
            if (!this.closed && bytes !== null)
              this.memoryReading = {
                bytes: Math.min(bytes, totalmem()),
                observedAt: this.clock(),
                ...parseVm(stdout),
              };
            resolve();
          },
        );
      }).finally(() => {
        this.memoryProbe = null;
      });
    }
    const processors = cpus();
    this.cores = processors;
    const current = processors.reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 },
    );
    const previous =
      this.previousCpu &&
      this.clock() > this.previousCpu.at &&
      this.clock() - this.previousCpu.at <= 30_000
        ? this.previousCpu
        : null;
    const delta = previous ? current.total - previous.total : 0;
    const used = previous && delta > 0 ? 100 * (1 - (current.idle - previous.idle) / delta) : null;
    this.previousCpu = { ...current, at: this.clock() };
    let diskAvailableBytes: number | null = null;
    this.diskTotalBytes = null;
    try {
      const disk = statfsSync(this.dataDir);
      diskAvailableBytes = disk.bavail * disk.bsize;
      this.diskTotalBytes = disk.blocks * disk.bsize;
    } catch {
      /* reported unknown */
    }
    this.machine = {
      observedAt: new Date(this.clock()).toISOString(),
      cpuCount: Math.max(1, processors.length),
      cpuUsedPercent: used === null ? null : Math.max(0, Math.min(100, used)),
      memoryTotalBytes: totalmem(),
      memoryAvailableBytes:
        this.memoryReading && this.clock() - this.memoryReading.observedAt < 30_000
          ? this.memoryReading.bytes
          : freemem(),
      memoryBasis:
        this.memoryReading && this.clock() - this.memoryReading.observedAt < 30_000
          ? 'free-plus-reclaimable-estimate'
          : 'free-only',
      diskAvailableBytes,
      loadPerCore: loadavg()[0]! / Math.max(1, processors.length),
    };
  }
  /** The watcher and scheduler consume the same OS readings; this does no I/O. */
  resourceReading(): MachineReading {
    const memory =
      this.memoryReading && this.clock() - this.memoryReading.observedAt < 30_000
        ? this.memoryReading
        : null;
    return {
      machine: this.machine,
      cores: this.cores,
      diskTotalBytes: this.diskTotalBytes,
      compressedBytes: memory?.compressedBytes ?? null,
      swapOutBytes: memory?.swapOutBytes ?? null,
      memoryObservedAt: memory?.observedAt ?? null,
    };
  }
  status() {
    return capacityStatusSchema.parse({
      providers: (['codex', 'claude'] as const).map((p) =>
        readCapacity(this.store, p, this.clock()),
      ),
      machine: this.machine,
      refreshing: this.pending.size > 0,
      refreshSeconds,
      notice:
        'One collector per computer. Percentages are subscription usage, not token prices. Missing windows are unknown; elapsed reset times require a fresh report. Native/editor work outside QUARK may also consume capacity.',
    });
  }
  async refresh(provider?: CapacityProvider) {
    await Promise.all(
      (provider ? [provider] : (['codex', 'claude'] as const)).map((p) => this.refreshOne(p)),
    );
    return this.status();
  }
  private refreshOne(provider: CapacityProvider): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.pending.get(provider);
    if (existing) return existing;
    const previous = readCapacity(this.store, provider, this.clock());
    // Manual refresh shares the same cooldown; many browsers cannot cause a polling storm.
    if (previous.nextRefreshAt && Date.parse(previous.nextRefreshAt) > this.clock())
      return Promise.resolve();
    const attemptedAt = new Date(this.clock()).toISOString();
    const promise = (async () => {
      let value: ProviderCapacity;
      let retryAt = 0;
      try {
        const raw = await this.fetcher(provider, this.abort.signal);
        if (this.closed) return;
        value = parseCapacity(
          provider,
          raw,
          this.clock(),
          modelPolicySchema.parse(this.store.getSetting('model-policy') ?? defaultModelPolicy),
        );
        // An owner's plan statement is bound to the verified native account, never a plan name.
        if (
          provider === 'claude' &&
          value.source === 'claude-native-oauth' &&
          value.weeklyPolicy === 'not-reported'
        ) {
          const affinity = z
            .array(
              z.object({
                usage: z.object({ accountAffinity: z.string().regex(/^[a-f0-9]{64}$/) }),
              }),
            )
            .safeParse(raw);
          if (
            affinity.success &&
            this.store.getSetting(
              `capacity:owner-no-weekly:${affinity.data[0]?.usage.accountAffinity}`,
            ) === true
          )
            value.weeklyPolicy = 'owner-reported-none';
        }
        this.failures.set(provider, 0);
      } catch (error) {
        if (this.closed) return;
        this.failures.set(provider, (this.failures.get(provider) ?? 0) + 1);
        const known = provider === 'claude' && error instanceof ClaudeCapacityError ? error : null;
        retryAt = known?.retryAt ?? 0;
        value = {
          ...previous,
          state: 'error',
          stale: true,
          message: known
            ? `${known.message} Saved readings remain stale; protected work waits for a fresh report.`
            : 'Could not refresh usage. Check this computer’s provider sign-in and usage collector. Saved readings are shown as stale; automatic work waits for a fresh report.',
        };
      }
      const delay = Math.min(
        15 * 60,
        (provider === 'claude' && !this.failures.get(provider) ? 300 : refreshSeconds) *
          2 ** Math.min(4, this.failures.get(provider) ?? 0),
      );
      value = {
        ...value,
        attemptedAt,
        nextRefreshAt: new Date(Math.max(this.clock() + delay * 1000, retryAt)).toISOString(),
      };
      this.store.setSetting(`${prefix}${provider}`, value);
      this.store.event('capacity.updated', null, null, {
        provider,
        state: value.state,
        observedAt: value.observedAt,
      });
    })();
    this.pending.set(provider, promise);
    return promise.finally(() => this.pending.delete(provider));
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await Promise.allSettled(this.pending.values());
    await this.memoryProbe;
  }
}
