import { expect, it, vi } from 'vitest';
import { ClaudePreflightError, readClaudeIdentity } from './claude-session.js';

const status = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'private-fixture@example.invalid',
  orgId: 'private-fixture-org',
};
it.each([
  [
    'timeout',
    () => Promise.reject({ killed: true, signal: 'SIGTERM', stderr: 'private-provider-text' }),
  ],
  ['unavailable', () => Promise.reject({ code: 'ENOENT', stderr: 'private-provider-text' })],
  ['malformed_status', async () => ({ stdout: 'private-provider-text' })],
  ['malformed_status', async () => ({ stdout: JSON.stringify({ loggedIn: true }) })],
  ['signed_out', async () => ({ stdout: JSON.stringify({ loggedIn: false }) })],
  ['signed_out', () => Promise.reject({ code: 1, stdout: JSON.stringify({ loggedIn: false }) })],
  [
    'unsupported_auth',
    async () => ({ stdout: JSON.stringify({ ...status, authMethod: 'api_key' }) }),
  ],
] as const)(
  'classifies native %s metadata without raw output or model submission',
  async (code, command) => {
    const reader = vi.fn(command);
    let failure: unknown;
    try {
      await readClaudeIdentity('/fixture/claude', reader);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ClaudePreflightError);
    expect((failure as ClaudePreflightError).code).toBe(code);
    expect((failure as Error).message.toLowerCase()).toContain('no model request was sent');
    expect((failure as Error).message).not.toContain('private-provider-text');
    expect((failure as Error).message).not.toContain(status.email);
    expect(reader).toHaveBeenCalledTimes(code === 'timeout' ? 2 : 1);
    expect(reader).toHaveBeenLastCalledWith('/fixture/claude');
  },
);
it('metadata refresh reads independently and neither caches an unknown account nor retries a model turn', async () => {
  let release!: () => void;
  const first = vi.fn(
    () =>
      new Promise<{ stdout: string }>((resolve) => {
        release = () => resolve({ stdout: JSON.stringify(status) });
      }),
  );
  const pending = readClaudeIdentity('/fixture/claude', first);
  const unavailable = vi.fn(async (): Promise<{ stdout: string }> => {
    throw { code: 'ENOENT' };
  });
  await expect(readClaudeIdentity('/fixture/claude', unavailable)).rejects.toMatchObject({
    code: 'unavailable',
  });
  release();
  const identity = await pending;
  expect(identity.affinity).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(identity)).not.toContain(status.email);
  expect(first).toHaveBeenCalledOnce();
  expect(unavailable).toHaveBeenCalledOnce();
});

it('recovers a transient metadata timeout once without reusing an old identity', async () => {
  const reader = vi
    .fn()
    .mockRejectedValueOnce({ killed: true, signal: 'SIGTERM' })
    .mockResolvedValueOnce({ stdout: JSON.stringify(status) });
  await expect(readClaudeIdentity('/fixture/claude', reader)).resolves.toMatchObject({
    authMethod: 'claude.ai',
    provider: 'firstParty',
  });
  expect(reader).toHaveBeenCalledTimes(2);
});
it('stops after a timeout if the fresh metadata reports signed out', async () => {
  const reader = vi
    .fn()
    .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
    .mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn: false }) });
  await expect(readClaudeIdentity('/fixture/claude', reader)).rejects.toMatchObject({
    code: 'signed_out',
  });
  expect(reader).toHaveBeenCalledTimes(2);
});
