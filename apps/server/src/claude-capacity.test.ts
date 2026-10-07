import { expect, it } from 'vitest';
import {
  ClaudeCapacityError,
  normalizeClaudeCapacity,
  nativeClaudeFetcher,
} from './claude-capacity.js';
import { parseCapacity, macAvailableMemory } from './capacity.js';

const now = Date.parse('2026-09-24T06:00:00Z');
const raw = {
  five_hour: { utilization: 13, resets_at: '2026-09-24T09:20:00.002935+00:00' },
  seven_day: null,
  limits: [
    {
      kind: 'weekly_scoped',
      percent: 50,
      resets_at: '2026-09-26T01:00:00.003242+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
  unrelated_private_field: 'must never persist',
};
it.each([
  [429, 'rate-limit', '600', now + 600_000],
  [503, 'service', new Date(now + 300_000).toUTCString(), now + 300_000],
  [401, 'authorization', '600', null],
  [403, 'refused', null, null],
  [404, 'format', null, null],
  [429, 'rate-limit', 'invalid private header', null],
  [429, 'rate-limit', '999999999', now + 86400_000],
] as const)(
  'retains a safe reason and bounded retry hint for HTTP %s',
  async (status, reason, hint, retryAt) => {
    const response = new Response('private error body', {
      status,
      headers: hint ? { 'Retry-After': hint } : {},
    });
    const reader = nativeClaudeFetcher({
      affinity: async () => 'account',
      credential: async () => 'private-token',
      clock: () => now,
      fetch: async () => response,
    });
    const failure = await reader(new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClaudeCapacityError);
    expect(failure).toMatchObject({ reason, retryAt });
    expect(String(failure)).not.toMatch(/private-token|private error body|private header/);
    expect(response.body?.locked).toBe(false);
  },
);
it('explains a usage authorization rejection without declaring native Claude signed out', () => {
  const { message } = new ClaudeCapacityError('authorization');
  expect(message).toContain('does not mean Claude is signed out');
  expect(message).toContain('may still work');
  expect(message).not.toMatch(/will work|refresh/i);
});
it('retains native Fable weekly without inventing a Fable session or general weekly limit', () => {
  const parsed = parseCapacity('claude', normalizeClaudeCapacity(raw, now), now);
  expect(parsed.source).toBe('claude-native-oauth');
  expect(parsed.weeklyPolicy).toBe('not-reported');
  expect(parsed.windows.map((w) => [w.scope, w.model, w.usedPercent, w.windowMinutes])).toEqual([
    ['general', null, 13, 300],
    ['model', 'fable', 50, 10080],
  ]);
  expect(JSON.stringify(parsed)).not.toContain('private');
});
it('sends a read only to the fixed provider endpoint and returns no credentials', async () => {
  let requests = 0;
  const reader = nativeClaudeFetcher({
    affinity: async () => 'test-account',
    credential: async () => 'private-token',
    clock: () => now,
    fetch: async (url, init) => {
      requests++;
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: { authorization: 'Bearer private-token' },
      });
      return new Response(JSON.stringify(raw));
    },
  });
  expect(JSON.stringify(await reader(new AbortController().signal))).not.toMatch(
    /private-token|unrelated_private/,
  );
  expect(requests).toBe(1);
});
it('fails closed on credentials, authentication, oversized and malformed reports without secret errors', async () => {
  for (const response of [
    new Response('secret', { status: 401 }),
    new Response('x'.repeat(300_000)),
    new Response('{bad'),
  ]) {
    await expect(
      nativeClaudeFetcher({
        affinity: async () => 'test-account',
        credential: async () => 'secret',
        fetch: async () => response,
      })(new AbortController().signal),
    ).rejects.toThrow('Native Claude usage unavailable');
  }
  await expect(
    nativeClaudeFetcher({
      affinity: async () => 'test-account',
      credential: async () => {
        throw new Error('private credential');
      },
    })(new AbortController().signal),
  ).rejects.not.toThrow('private credential');
  expect(() =>
    normalizeClaudeCapacity({ ...raw, five_hour: { utilization: 101, resets_at: null } }, now),
  ).toThrow();
});
it('estimates macOS reclaimable memory without counting wired or active pages as available', () => {
  expect(
    macAvailableMemory(
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages active: 200.\nPages inactive: 20.\nPages speculative: 2.\nPages wired down: 300.',
    ),
  ).toBe(32 * 16384);
  expect(macAvailableMemory('unknown')).toBeNull();
});
it('does not attribute a quota report across a native account change', async () => {
  let reads = 0;
  const reader = nativeClaudeFetcher({
    affinity: async () => String(++reads),
    credential: async () => 'token',
    fetch: async () => new Response(JSON.stringify(raw)),
  });
  await expect(reader(new AbortController().signal)).rejects.toThrow(
    'Native Claude usage unavailable',
  );
});
