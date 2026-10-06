import { expect, it } from 'vitest';
import {
  adaptivePaceSchema,
  pulsarPolicySchema,
  type CapacityWindow,
  type ProviderCapacity,
} from '@dock/shared';
import { adaptivePace, notifyRelevance, type ProjectDemand } from './quark-demand.js';

const now = Date.parse('2026-10-06T06:40:00Z');
const policy = pulsarPolicySchema.parse({
  enabled: true,
  providerReserves: {
    codex: { reservePercent: 0, releaseEnabled: false, releaseBeforeResetMinutes: 720 },
    claude: { reservePercent: 5, releaseEnabled: false, releaseBeforeResetMinutes: 45 },
  },
});
function reading(provider: 'codex' | 'claude', window: CapacityWindow, stale = false) {
  return {
    provider,
    account: 'local-sign-in',
    label: provider,
    plan: null,
    source: provider === 'codex' ? 'codexbar-oauth' : 'claude-native-oauth',
    observedAt: new Date(now - 60_000).toISOString(),
    attemptedAt: null,
    nextRefreshAt: null,
    state: 'ready',
    stale,
    message: '',
    windows: [window],
    weeklyPolicy: 'reported',
  } satisfies ProviderCapacity;
}
const weekly: CapacityWindow = {
  id: 'secondary',
  label: 'Weekly',
  scope: 'general',
  model: null,
  usedPercent: 34,
  windowMinutes: 10080,
  resetsAt: new Date(now + 156 * 3600_000).toISOString(),
};
const session: CapacityWindow = {
  id: 'primary',
  label: 'Session',
  scope: 'general',
  model: null,
  usedPercent: 4,
  windowMinutes: 300,
  resetsAt: new Date(now + 4.5 * 3600_000).toISOString(),
};
function demand(count: number, provider: 'codex' | 'claude', blocked = false) {
  return new Map(
    Array.from({ length: count }, (_, i): [string, ProjectDemand] => [
      `p${i}`,
      {
        projectId: `p${i}`,
        managerId: `m${i}`,
        paused: false,
        runs: [{ runId: `r${i}`, provider, model: null, status: 'queued' }],
        unfinishedTasks: 1,
        blockedProviders: new Set(blocked && i === 0 ? [provider] : []),
      },
    ]),
  );
}
function pace(
  provider: 'codex' | 'claude',
  window: CapacityWindow,
  projects: Map<string, ProjectDemand>,
  extra: Partial<Parameters<typeof adaptivePace>[0]> = {},
) {
  return adaptivePaceSchema.parse(
    adaptivePace({
      now,
      capacity: reading(provider, window),
      window,
      policy,
      reservedPercent: 0,
      projectId: 'p0',
      demand: projects,
      weight: () => 1,
      hourlyCapPercent: null,
      ...extra,
    }),
  );
}

it('derives distinct provider rates from each window’s own reported reset and shares by demand', () => {
  const codexOne = pace('codex', weekly, demand(1, 'codex'));
  const claudeOne = pace('claude', session, demand(1, 'claude'));
  expect(codexOne).toMatchObject({ state: 'ready', demandProjects: 1, resetsAt: weekly.resetsAt });
  // 66 points over 155.75 h versus 91 points (after the 5% reserve) over 4.25 h.
  expect(codexOne.percentPerHour).toBeCloseTo(66 / 155.75, 2);
  expect(claudeOne.percentPerHour).toBeCloseTo(91 / 4.25, 2);
  const claudeTen = pace('claude', session, demand(10, 'claude'));
  expect(claudeTen.demandProjects).toBe(10);
  expect(claudeTen.percentPerHour).toBeCloseTo(91 / 4.25 / 10, 2);
  const weighted = pace('claude', session, demand(2, 'claude'), {
    weight: (id) => (id === 'p0' ? 3 : 1),
  });
  expect(weighted.percentPerHour).toBeCloseTo((91 / 4.25) * 0.75, 2);
  // Outstanding admission reservations reduce headroom; saved caps stay authoritative.
  const reserved = pace('claude', session, demand(1, 'claude'), {
    reservedPercent: 6,
    hourlyCapPercent: 2,
  });
  expect(reserved.percentPerHour).toBeCloseTo(85 / 4.25, 2);
  expect(reserved.reason).toContain('saved 2%/hour cap stays authoritative');
});

it('never suggests pace for idle, stale, expired, zero-limit or exhausted windows', () => {
  expect(pace('claude', session, demand(1, 'codex'))).toMatchObject({
    state: 'idle',
    percentPerHour: null,
    demandProjects: 0,
  });
  expect(
    adaptivePace({
      now,
      capacity: reading('claude', session, true),
      window: session,
      policy,
      reservedPercent: 0,
      projectId: 'p0',
      demand: demand(1, 'claude'),
      weight: () => 1,
      hourlyCapPercent: null,
    }),
  ).toMatchObject({ state: 'unknown', percentPerHour: null });
  expect(
    pace('claude', { ...session, resetsAt: new Date(now - 1000).toISOString() }, demand(1, 'claude')),
  ).toMatchObject({ state: 'unknown', percentPerHour: null });
  expect(pace('claude', session, demand(1, 'claude'), { hourlyCapPercent: 0 })).toMatchObject({
    state: 'blocked',
    percentPerHour: 0,
  });
  expect(pace('claude', session, demand(2, 'claude', true))).toMatchObject({
    state: 'blocked',
    demandProjects: 1,
  });
  expect(pace('claude', { ...session, usedPercent: 96 }, demand(1, 'claude'))).toMatchObject({
    state: 'blocked',
    percentPerHour: 0,
  });
});

it('rejects notices for blocked manager providers before considering other provider work', () => {
  const mixed = demand(1, 'claude').get('p0')!;
  mixed.blockedProviders.add('codex');
  expect(notifyRelevance(mixed, 'codex')).toMatch(/Only the owner/);
  expect(notifyRelevance(mixed, 'claude')).toBeNull();
  expect(notifyRelevance({ ...mixed, runs: [], unfinishedTasks: 0 }, 'claude')).toMatch(
    /no unfinished/,
  );
  expect(notifyRelevance({ ...mixed, paused: true }, 'claude')).toMatch(/paused/);
});
