import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { GroupNativeAuth } from './group-native-auth.js';
import type { CodexRpc } from './codex.js';

function fixture() {
  let account = false;
  const provider = new EventEmitter() as CodexRpc;
  provider.ready = true;
  provider.request = vi.fn(async (method: string) => {
    if (method === 'config/read') return { config: { cli_auth_credentials_store: 'ephemeral' } };
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'account/read')
      return {
        requiresOpenaiAuth: true,
        account: account ? { type: 'chatgpt', email: 'not-exported@example.invalid' } : null,
      };
    if (method === 'account/login/start')
      return {
        type: 'chatgptDeviceCode',
        loginId: 'local-only',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'FABRICATED',
      };
    return {};
  });
  const release = vi.fn(async () => {}),
    admission = vi.fn(() => {});
  const auth = new GroupNativeAuth(provider, admission, release);
  return {
    auth,
    provider,
    release,
    admission,
    signedIn: () => {
      account = true;
    },
  };
}

it('inspects scoped memory-only policy/account without starting sign-in, exposes no native RPC or identity', async () => {
  const f = fixture();
  try {
    expect(await f.auth.inspect()).toBe('signed-out');
    expect(vi.mocked(f.provider.request).mock.calls.map(([method]) => method)).toEqual([
      'config/read',
      'configRequirements/read',
      'account/read',
    ]);
    expect('request' in f.auth).toBe(false);
    expect('provider' in JSON.parse(JSON.stringify(f.auth))).toBe(false);
  } finally {
    await f.auth.close();
  }
  expect(f.release).toHaveBeenCalledOnce();
});

it('holds native device codes only in memory and verifies subscription again after matching completion', async () => {
  const f = fixture();
  try {
    expect(await f.auth.beginDeviceSignIn()).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'FABRICATED',
    });
    expect(f.auth.status()).toBe('pending');
    f.provider.emit('notification', 'account/login/completed', {
      loginId: 'another-context',
      success: true,
    });
    expect(f.auth.status()).toBe('pending');
    f.signedIn();
    f.provider.emit('notification', 'account/login/completed', {
      loginId: 'local-only',
      success: true,
    });
    await expect.poll(() => f.auth.status()).toBe('authenticated');
    expect(JSON.stringify(f.auth)).not.toContain('FABRICATED');
  } finally {
    await f.auth.close();
  }
  await f.auth.closed;
  expect(f.release).toHaveBeenCalledOnce();
});

it.each(['file', 'keyring', 'auto'])(
  'rejects managed credential store %s before reading the native account or starting sign-in',
  async (mode) => {
    const f = fixture();
    vi.mocked(f.provider.request).mockImplementation(async (method) =>
      method === 'config/read'
        ? { config: { cli_auth_credentials_store: 'ephemeral' } }
        : { requirements: { cliAuthCredentialsStore: mode } },
    );
    try {
      await expect(f.auth.inspect()).rejects.toThrow(/could not be verified/);
      expect(vi.mocked(f.provider.request).mock.calls.map(([method]) => method)).not.toContain(
        'account/read',
      );
    } finally {
      await f.auth.close();
    }
  },
);

it('revocation denies device start, cancellation stops the owned process, and raw native diagnostics are never returned', async () => {
  const f = fixture();
  await f.auth.beginDeviceSignIn();
  await Promise.all([f.auth.close(), f.auth.close()]);
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.provider.request).toHaveBeenCalledWith('account/login/cancel', {
    loginId: 'local-only',
  });
  const other = fixture();
  other.admission.mockImplementation(() => {
    throw new Error('held');
  });
  await expect(other.auth.beginDeviceSignIn()).rejects.toThrow('held');
  expect(other.provider.request).not.toHaveBeenCalled();
  await other.auth.close();
  const error = fixture();
  vi.mocked(error.provider.request).mockRejectedValue(
    new Error('FABRICATED_SECRET_PROVIDER_DIAGNOSTIC'),
  );
  await expect(error.auth.inspect()).rejects.toThrow(/could not be verified/);
  await error.auth.close();
});
