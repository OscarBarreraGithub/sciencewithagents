import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import {
  providerMaintenanceRequestSchema,
  providerMaintenanceStateSchema,
  type ProviderId,
  type ProviderMaintenanceState,
} from '@dock/shared';
import { Store } from './store.js';

const execute = promisify(execFile);
const version = (output: string) => output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null;
function executable(name: string) {
  const paths = isAbsolute(name)
    ? [name]
    : [
        ...(process.env.PATH ?? '').split(delimiter),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        join(homedir(), '.local/bin'),
      ]
        .filter(Boolean)
        .map((p) => join(p, name));
  for (const p of paths) {
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* Try next installed path. */
    }
  }
  return null;
}
export function updatePlan(
  provider: ProviderId,
  entry: string,
  resolved: string,
  find = executable,
) {
  if (
    resolved.includes(`/Caskroom/${provider === 'codex' ? 'codex' : 'claude-code'}/`) ||
    resolved.includes('/Caskroom/claude-code@latest/')
  ) {
    const brew = find('brew');
    if (!brew) return null;
    const name = resolved.includes('/claude-code@latest/')
      ? 'claude-code@latest'
      : provider === 'codex'
        ? 'codex'
        : 'claude-code';
    return {
      binary: brew,
      args: ['upgrade', '--cask', name],
      command: `brew upgrade --cask ${name}`,
    };
  }
  const packageName = provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const marker = `/lib/node_modules/${packageName}/`;
  if (resolved.includes(marker)) {
    const npm = find('npm');
    if (!npm) return null;
    const prefix = resolved.slice(0, resolved.indexOf(marker));
    return {
      binary: npm,
      args: ['install', '--global', '--prefix', prefix, `${packageName}@latest`],
      command: `npm install -g ${packageName}@latest`,
    };
  }
  if (
    provider === 'claude' &&
    resolved.startsWith(join(homedir(), '.local/share/claude/versions') + '/')
  )
    return { binary: entry, args: ['update'], command: 'claude update' };
  return null;
}
/** The existing runtime heartbeat owns waiting requests; no updater daemon or shell endpoint. */
export class ProviderMaintenance {
  private pending = new Map<ProviderId, Promise<void>>();
  private closed = false;
  constructor(
    readonly store: Store,
    private binaries: Record<ProviderId, string>,
    private busy: (provider: ProviderId) => boolean,
    private refreshed: (provider: ProviderId) => Promise<unknown>,
    private runner = async (binary: string, args: string[]) =>
      (
        await execute(binary, args, {
          timeout: 180_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, CI: '1', NONINTERACTIVE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' },
        })
      ).stdout,
  ) {
    for (const p of ['codex', 'claude'] as const)
      if (this.status(p).state === 'updating')
        this.save(p, {
          state: 'needs-help',
          message:
            'The app stopped during an update. Check the installed version before retrying; the installer was not replayed.',
        });
  }
  status(provider: ProviderId): ProviderMaintenanceState {
    return providerMaintenanceStateSchema.parse(
      this.store.getSetting(`provider:update:${provider}`) ?? {
        provider,
        state: 'idle',
        message: 'Updates use your installed provider’s own installer.',
        before: null,
        after: null,
        checkedAt: null,
        command: null,
      },
    );
  }
  private save(provider: ProviderId, patch: Partial<ProviderMaintenanceState>) {
    const value = providerMaintenanceStateSchema.parse({ ...this.status(provider), ...patch });
    this.store.setSetting(`provider:update:${provider}`, value);
    this.store.event('provider.update', null, null, value);
    return value;
  }
  request(raw: unknown) {
    const input = providerMaintenanceRequestSchema.parse(raw);
    this.store.operation(`provider:update:${input.key}`, input, () => {
      if (!['waiting', 'updating'].includes(this.status(input.provider).state))
        this.save(input.provider, {
          state: 'waiting',
          message:
            'Waiting for this provider’s active app jobs to finish. New app jobs wait for the update.',
          checkedAt: new Date().toISOString(),
        });
      return { accepted: true };
    });
    this.tick();
    return this.status(input.provider);
  }
  blocks(provider: ProviderId) {
    return ['waiting', 'updating'].includes(this.status(provider).state);
  }
  tick() {
    if (this.closed) return;
    for (const provider of ['codex', 'claude'] as const) {
      if (
        this.status(provider).state !== 'waiting' ||
        this.pending.has(provider) ||
        this.busy(provider)
      )
        continue;
      const promise = this.update(provider).finally(() => this.pending.delete(provider));
      this.pending.set(provider, promise);
    }
  }
  private async update(provider: ProviderId) {
    this.save(provider, {
      state: 'updating',
      message: 'Checking and updating the installed provider…',
      command: null,
    });
    try {
      const entry = executable(this.binaries[provider]);
      if (!entry) {
        this.save(provider, {
          state: 'needs-help',
          message:
            'This provider executable is unavailable. Open Welcome to connect it, then retry.',
        });
        return;
      }
      const before = version(await this.runner(entry, ['--version']));
      const plan = updatePlan(provider, entry, realpathSync(entry));
      if (!plan) {
        this.save(provider, {
          state: 'needs-help',
          before,
          message:
            'This provider is bundled with another app or uses a custom installation. Update it through that app or its original installer; no installation was replaced.',
        });
        return;
      }
      this.save(provider, { before, command: plan.command });
      await this.runner(plan.binary, plan.args);
      const after = version(await this.runner(entry, ['--version']));
      if (!after) throw new Error('Version not reported');
      this.save(provider, {
        state: before === after ? 'current' : 'updated',
        after,
        checkedAt: new Date().toISOString(),
        message:
          before === after
            ? `Up to date · ${after}`
            : `Updated to ${after}. New conversations use the updated provider.`,
      });
      await this.refreshed(provider).catch(() => {});
    } catch {
      this.save(provider, {
        state: 'needs-help',
        message:
          'The update could not be verified. Your accounts and chats are retained. Retry, or run the displayed installer command in Terminal. No administrator prompt was left waiting.',
      });
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.pending.values());
  }
}
