import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupNativeAuth } from './group-native-auth.js';
import type { CodexRpc } from './codex.js';

afterEach(() => vi.useRealTimers());
function fixture(cancelStatus: string = 'canceled') {
  let authenticated = false,
    starts = 0;
  const provider = new EventEmitter() as CodexRpc;
  provider.ready = true;
  provider.request = vi.fn(async (method: string) => {
    if (method === 'config/read') return { config: { cli_auth_credentials_store: 'ephemeral' } };
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'account/read')
      return { requiresOpenaiAuth: true, account: authenticated ? { type: 'chatgpt' } : null };
    if (method === 'account/login/cancel') return { status: cancelStatus };
    if (method === 'account/login/start')
      return {
        type: 'chatgptDeviceCode',
        loginId: `owned-${++starts}`,
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: `SYNTHETIC-${starts}`,
      };
    throw new Error('Unexpected native method');
  });
  const release = vi.fn(async () => {});
  const auth = new GroupNativeAuth(provider, vi.fn(), release);
  return {
    auth,
    provider,
    release,
    authenticated: () => {
      authenticated = true;
    },
    starts: () => starts,
  };
}

it.each(['canceled', 'notFound'])(
  'restarts only after supported native %s acknowledgment in the same owned runtime',
  async (status) => {
    const f = fixture(status);
    try {
      await f.auth.beginDeviceSignIn();
      expect((await f.auth.restartDeviceSignIn()).userCode).toBe('SYNTHETIC-2');
      expect(f.provider.request).toHaveBeenCalledWith('account/login/cancel', {
        loginId: 'owned-1',
      });
      const methods = vi.mocked(f.provider.request).mock.calls.map(([method]) => method);
      expect(methods.lastIndexOf('account/read')).toBeGreaterThan(
        methods.indexOf('account/login/cancel'),
      );
      expect(f.starts()).toBe(2);
      expect(f.release).not.toHaveBeenCalled();
      expect(
        methods.every((method) => !method.startsWith('thread/') && !method.startsWith('turn/')),
      ).toBe(true);
    } finally {
      await f.auth.close();
    }
  },
);

it('expired and declined challenges allow explicit authorization retry without automatic login or namespace restart', async () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    await f.auth.beginDeviceSignIn();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(f.auth.status()).toBe('failed');
    expect(f.starts()).toBe(1);
    expect(f.release).not.toHaveBeenCalled();
    await f.auth.restartDeviceSignIn();
    f.provider.emit('notification', 'account/login/completed', {
      loginId: 'owned-2',
      success: false,
    });
    expect(f.auth.status()).toBe('failed');
    expect(f.starts()).toBe(2);
    expect(f.release).not.toHaveBeenCalled();
    await f.auth.restartDeviceSignIn();
    expect(f.starts()).toBe(3);
  } finally {
    await f.auth.close();
  }
});

it('unknown cancellation cannot create another challenge and native process loss remains explicit uncertainty', async () => {
  const f = fixture('unknown');
  await f.auth.beginDeviceSignIn();
  await expect(f.auth.restartDeviceSignIn()).rejects.toThrow('could not be verified');
  expect(f.starts()).toBe(1);
  expect(f.release).toHaveBeenCalledOnce();
  const lost = fixture();
  await lost.auth.beginDeviceSignIn();
  lost.provider.emit('unavailable');
  await lost.auth.closed;
  await expect(lost.auth.restartDeviceSignIn()).rejects.toThrow('runtime ended');
  expect(lost.starts()).toBe(1);
  expect(lost.release).toHaveBeenCalledOnce();
});

it('authenticated native state wins over a requested retry', async () => {
  const f = fixture();
  try {
    await f.auth.beginDeviceSignIn();
    f.authenticated();
    await expect(f.auth.restartDeviceSignIn()).rejects.toThrow('already authenticated');
    expect(f.starts()).toBe(1);
    expect(f.release).not.toHaveBeenCalled();
  } finally {
    await f.auth.close();
  }
});

it('an old expiry cancellation cannot clear or fail a newer explicit challenge', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const original = vi.mocked(f.provider.request).getMockImplementation()!;
  let cancelCalls = 0,
    releaseOld!: (value: { status: string }) => void;
  vi.mocked(f.provider.request).mockImplementation(async (method, params) => {
    if (method === 'account/login/cancel' && ++cancelCalls === 1)
      return new Promise((resolve) => {
        releaseOld = resolve;
      });
    return original(method, params);
  });
  try {
    await f.auth.beginDeviceSignIn();
    vi.advanceTimersByTime(15 * 60_000);
    expect((await f.auth.restartDeviceSignIn()).userCode).toBe('SYNTHETIC-2');
    releaseOld({ status: 'canceled' });
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(f.auth.status()).toBe('pending');
    expect(f.starts()).toBe(2);
    expect(f.release).not.toHaveBeenCalled();
  } finally {
    await f.auth.close();
  }
});

it('changed native authentication requirements remain authoritative before an explicit retry', async () => {
  const f = fixture();
  await f.auth.beginDeviceSignIn();
  const original = vi.mocked(f.provider.request).getMockImplementation()!;
  vi.mocked(f.provider.request).mockImplementation(async (method, params) =>
    method === 'configRequirements/read'
      ? { requirements: { cliAuthCredentialsStore: 'keyring' } }
      : original(method, params),
  );
  await expect(f.auth.restartDeviceSignIn()).rejects.toThrow(
    'account/policy could not be verified',
  );
  expect(f.starts()).toBe(1);
  expect(f.release).toHaveBeenCalledOnce();
});
