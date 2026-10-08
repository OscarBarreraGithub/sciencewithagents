import { expect, it, vi } from 'vitest';
import { ClusterNativeAccounts, projectNativeCodexAccount } from './cluster-native-accounts.js';
import { ClaudePreflightError } from './claude-session.js';

const clock = Date.parse('2026-10-08T06:00:00Z');
const identity = {
  affinity: 'a'.repeat(64),
  authMethod: 'claude.ai' as const,
  provider: 'firstParty' as const,
};

it('shares a metadata check without reading usage, starting a turn, or copying raw account identity', async () => {
  let resolve!: (value: unknown) => void;
  const codexRead = vi.fn(
    () =>
      new Promise<unknown>((done) => {
        resolve = done;
      }),
  );
  const claudeIdentity = vi.fn(async () => identity);
  const claudeUsage = vi.fn(async () => {
    throw new Error('Usage was not requested');
  });
  const accounts = new ClusterNativeAccounts(codexRead, () => clock, {
    claudeIdentity,
    claudeUsage,
  });
  const first = accounts.discover('codex'),
    second = accounts.discover('codex');
  expect(codexRead).toHaveBeenCalledTimes(1);
  resolve({
    accountId: 'private-native-id',
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 1 } },
  });
  const reading = await first;
  expect(await second).toEqual(reading);
  expect(await accounts.discover('codex')).toEqual(reading);
  expect(reading.ordinaryUsageAllowed).toBe(false);
  expect(reading.capacity?.state).toBe('error');
  expect(JSON.stringify(accounts.all())).not.toContain('private-native-id');
  expect(claudeIdentity).not.toHaveBeenCalled();
  expect(claudeUsage).not.toHaveBeenCalled();
});

it.each(['timeout', 'unavailable'] as const)(
  'keeps a typed Claude %s separate from native sign-out and permits explicit recheck',
  async (code) => {
    const claudeIdentity = vi
      .fn()
      .mockRejectedValueOnce(new ClaudePreflightError(code, 'sanitized metadata failure'))
      .mockResolvedValueOnce(identity);
    const claudeUsage = vi.fn(async () => {
      throw new Error('Usage was not requested');
    });
    const accounts = new ClusterNativeAccounts(
      async () => {
        throw new Error('Wrong provider');
      },
      () => clock,
      { claudeIdentity, claudeUsage },
    );
    expect((await accounts.discover('claude')).account).toMatchObject({
      state: 'unavailable',
      affinity: null,
    });
    expect((await accounts.discover('claude', true)).account).toMatchObject({
      state: 'ready',
      affinity: identity.affinity,
    });
    expect(claudeIdentity).toHaveBeenCalledTimes(2);
    expect(claudeUsage).not.toHaveBeenCalled();
  },
);

it('retains a native signed-out result and never switches providers or reads usage', async () => {
  const codexRead = vi.fn();
  const claudeIdentity = vi.fn(async () => {
    throw new ClaudePreflightError('signed_out', 'Native signed-out metadata');
  });
  const claudeUsage = vi.fn();
  const accounts = new ClusterNativeAccounts(codexRead, () => clock, {
    claudeIdentity,
    claudeUsage,
  });
  expect((await accounts.capacity('claude')).account.state).toBe('setup-required');
  expect(codexRead).not.toHaveBeenCalled();
  expect(claudeUsage).not.toHaveBeenCalled();
});

it('drops cached Claude capacity when the native account changes', async () => {
  const claudeIdentity = vi
    .fn()
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, affinity: 'b'.repeat(64) });
  const claudeUsage = vi.fn(async () => [
    {
      provider: 'claude',
      source: 'claude-native-oauth',
      usage: {
        accountAffinity: identity.affinity,
        updatedAt: new Date(clock).toISOString(),
        primary: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
      },
    },
  ]);
  const accounts = new ClusterNativeAccounts(
    async () => null,
    () => clock,
    { claudeIdentity, claudeUsage },
  );
  expect((await accounts.capacity('claude')).capacity).not.toBeNull();
  expect((await accounts.discover('claude', true)).capacity).toBeNull();
});

it('requires the native Codex account id rather than guessing from allowance percentages', () => {
  expect(() => projectNativeCodexAccount({ accountId: null, rateLimits: {} }, clock)).toThrow(
    'native account identity',
  );
});

it('cannot restore an earlier account when an in-flight usage read finishes after native identity changes', async () => {
  const changed = { ...identity, affinity: 'b'.repeat(64) };
  const claudeIdentity = vi.fn().mockResolvedValueOnce(identity).mockResolvedValueOnce(changed);
  let finish!: (value: unknown) => void;
  const claudeUsage = vi.fn(
    () =>
      new Promise<unknown>((resolve) => {
        finish = resolve;
      }),
  );
  const accounts = new ClusterNativeAccounts(
    async () => null,
    () => clock,
    { claudeIdentity, claudeUsage },
  );
  const reading = accounts.capacity('claude');
  await vi.waitFor(() => expect(claudeUsage).toHaveBeenCalledOnce());
  await accounts.discover('claude', true);
  finish([
    {
      provider: 'claude',
      source: 'claude-native-oauth',
      usage: {
        accountAffinity: identity.affinity,
        updatedAt: new Date(clock).toISOString(),
        primary: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
      },
    },
  ]);
  expect((await reading).account.affinity).toBe(changed.affinity);
  expect(accounts.reading('claude')).toMatchObject({
    account: { affinity: changed.affinity },
    capacity: null,
  });
});
