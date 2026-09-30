import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { assertClaudeSubscriptionEnvironment, readClaudeIdentity } from './claude-session.js';

const object = z.record(z.string(), z.unknown());
const percent = z.number().finite().min(0).max(100);
const endpoint = 'https://api.anthropic.com/api/oauth/usage';
const failureMessages = {
  'sign-in':
    'The native Claude sign-in could not be read. Check Claude on this computer; no account was changed.',
  profile:
    'This custom Claude profile is not supported by the usage reader. Its native conversations can still work.',
  authorization:
    'Claude rejected the usage authorization. Check the existing sign-in in Claude on this computer.',
  refused:
    'Claude refused this usage read. Native conversations may still work; the shared collector will retry.',
  'rate-limit':
    'Claude is limiting usage checks. The shared collector will wait before retrying; this does not mean your model allowance is exhausted.',
  service:
    'Claude’s usage service is temporarily unavailable. The shared collector will retry automatically.',
  network: 'Could not reach Claude’s usage service. The shared collector will retry automatically.',
  format:
    'Claude returned an unsupported usage report. The saved reading is retained; the reader may need an update.',
  'account-changed':
    'Claude’s signed-in account changed during the usage read. That report was discarded.',
} as const;
/** Only fixed explanations and a bounded retry time can cross the reader boundary. */
export class ClaudeCapacityError extends Error {
  constructor(
    readonly reason: keyof typeof failureMessages,
    readonly retryAt: number | null = null,
  ) {
    super(`Native Claude usage unavailable. ${failureMessages[reason]}`);
  }
}
function retryAt(header: string | null, now: number): number | null {
  if (!header || header.length > 100) return null;
  const value = header.trim();
  const delay = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /^[A-Za-z]{3}, /.test(value)
      ? Date.parse(value) - now
      : NaN;
  // A malformed/far-future hint cannot suppress checks indefinitely.
  return Number.isFinite(delay) && delay >= 0 ? now + Math.min(delay, 86400_000) : null;
}

/** Read only the existing native subscription. No refresh, login, cookies or paid fallback. */
async function nativeCredential(signal: AbortSignal): Promise<string> {
  assertClaudeSubscriptionEnvironment();
  // Custom profiles use a different native credential namespace. Never show another account.
  if (process.env.CLAUDE_CONFIG_DIR) throw new ClaudeCapacityError('profile');
  let raw: string;
  if (process.platform === 'darwin') {
    raw = await new Promise<string>((resolve, reject) => {
      execFile(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000, maxBuffer: 64 * 1024, signal },
        (error, stdout) => {
          if (error) reject(new Error('Native Claude sign-in unavailable.'));
          else resolve(stdout);
        },
      );
    });
  } else {
    const bytes = await readFile(join(homedir(), '.claude', '.credentials.json'), { signal });
    if (bytes.length > 64 * 1024) throw new Error('Invalid native credential.');
    raw = bytes.toString('utf8');
  }
  return z
    .object({ claudeAiOauth: z.object({ accessToken: z.string().min(1).max(16000) }) })
    .parse(JSON.parse(raw)).claudeAiOauth.accessToken;
}

/** Normalize only allowance fields; unrelated server data never enters the store. */
export function normalizeClaudeCapacity(raw: unknown, now = Date.now()) {
  const report = object.parse(raw);
  const window = (value: unknown, minutes: number) => {
    if (value == null) return null;
    const input = z.object({ utilization: percent, resets_at: z.string().nullable() }).parse(value);
    return { usedPercent: input.utilization, resetsAt: input.resets_at, windowMinutes: minutes };
  };
  const extras: Array<{ id: string; title: string; window: unknown }> = [];
  for (const [key, name] of [
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
  ] as const) {
    if (report[key])
      extras.push({ id: key, title: `${name} weekly`, window: window(report[key], 10080) });
  }
  const limits = report.limits == null ? [] : z.array(object).max(64).parse(report.limits);
  for (const limit of limits) {
    if (limit.kind !== 'weekly_scoped' && limit.kind !== 'session_scoped') continue;
    const scope = object.parse(limit.scope);
    if (scope.model == null) continue; // Surface-only windows are not model capacity.
    const model = z
      .object({ display_name: z.string().min(1).max(100) })
      .parse(scope.model).display_name;
    const isWeekly = limit.kind === 'weekly_scoped';
    const key = model.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const legacy = `seven_day_${key}`;
    if (isWeekly && extras.some((entry) => entry.id === legacy)) continue;
    extras.push({
      id: `${key}-${isWeekly ? 'weekly' : 'session'}`,
      title: `${model} ${isWeekly ? 'weekly' : 'session'}`,
      window: {
        usedPercent: percent.parse(limit.percent),
        resetsAt: z.string().nullable().parse(limit.resets_at),
        windowMinutes: isWeekly ? 10080 : 300,
      },
    });
  }
  return [
    {
      provider: 'claude',
      source: 'claude-native-oauth',
      usage: {
        updatedAt: new Date(now).toISOString(),
        loginMethod: 'Native Claude subscription',
        primary: window(report.five_hour, 300),
        secondary: window(report.seven_day, 10080),
        extraRateWindows: extras,
      },
    },
  ];
}

export function nativeClaudeFetcher(
  dependencies: {
    credential?: typeof nativeCredential;
    fetch?: typeof fetch;
    clock?: () => number;
    affinity?: () => Promise<string>;
  } = {},
) {
  return async (signal: AbortSignal): Promise<unknown> => {
    // All network/credential errors are replaced before reaching a log, event or browser.
    let stage: keyof typeof failureMessages = 'sign-in';
    try {
      const identity =
        dependencies.affinity ??
        (async () => (await readClaudeIdentity(process.env.DOCK_CLAUDE_BIN ?? 'claude')).affinity);
      const affinity = await identity();
      const token = await (dependencies.credential ?? nativeCredential)(signal);
      stage = 'network';
      const response = await (dependencies.fetch ?? fetch)(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          accept: 'application/json',
        },
      });
      if (!response.ok) {
        const reason =
          response.status === 429
            ? 'rate-limit'
            : response.status === 401
              ? 'authorization'
              : response.status === 403
                ? 'refused'
                : response.status >= 500
                  ? 'service'
                  : 'format';
        const retry =
          response.status === 429 || response.status === 503
            ? retryAt(response.headers.get('retry-after'), (dependencies.clock ?? Date.now)())
            : null;
        await response.body?.cancel().catch(() => {});
        throw new ClaudeCapacityError(reason, retry);
      }
      stage = 'format';
      if (!response.body) throw new Error('Missing report.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) throw new Error('Usage report too large.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      stage = 'sign-in';
      if (affinity !== (await identity())) throw new ClaudeCapacityError('account-changed');
      stage = 'format';
      const result = normalizeClaudeCapacity(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        (dependencies.clock ?? Date.now)(),
      );
      return result.map((row) => ({ ...row, usage: { ...row.usage, accountAffinity: affinity } }));
    } catch (error) {
      throw error instanceof ClaudeCapacityError ? error : new ClaudeCapacityError(stage);
    }
  };
}
