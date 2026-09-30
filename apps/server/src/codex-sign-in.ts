import { z } from 'zod';
import { signInRequestSchema, signInStatusSchema, type SignInStatus } from '@dock/shared';
import type { Provider } from './codex.js';
import { Conflict, type Store } from './store.js';

const savedKey = 'setup:codex-sign-in';
const idle: SignInStatus = {
  key: null,
  state: 'idle',
  verificationUrl: null,
  userCode: null,
  expiresAt: null,
};

/** Native device authorization only. Credentials stay in Codex; one-time codes never enter SQLite/events. */
export class CodexSignIn {
  private current: SignInStatus;
  private client: Provider | null = null;
  private loginId: string | null = null;
  private earlyCompletion: { loginId: string | null; success: boolean } | null = null;
  private pending: Promise<SignInStatus> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  constructor(
    private store: Store,
    private connect: () => Promise<Provider>,
  ) {
    const saved = signInRequestSchema.safeParse(store.getSetting(savedKey));
    this.current = {
      ...idle,
      ...(saved.success ? { key: saved.data.key, state: 'expired' as const } : {}),
    };
  }
  status() {
    return signInStatusSchema.parse(this.current);
  }
  async start(raw: unknown): Promise<SignInStatus> {
    const { key } = signInRequestSchema.parse(raw);
    if (this.closed) throw new Conflict('Sign-in is stopping. Reconnect to try again.');
    if (this.current.key === key) return this.pending ?? this.status();
    if (this.pending || this.current.state === 'pending')
      throw new Conflict(
        'A Codex sign-in is already open. Finish or cancel it before starting another.',
      );
    this.current = { ...idle, key, state: 'starting' };
    this.earlyCompletion = null;
    const request = (async () => {
      try {
        await this.store.externalOperation(`setup:codex-sign-in:${key}`, { key }, async () => {
          this.store.setSetting(savedKey, { key });
          const client = await this.connect();
          this.client = client;
          client.on('unavailable', this.unavailable);
          if (this.closed) throw new Error('Closed');
          const account = z
            .object({ account: z.unknown().nullable(), requiresOpenaiAuth: z.boolean() })
            .parse(await client.request('account/read', { refreshToken: false }));
          if (account.account !== null || !account.requiresOpenaiAuth)
            throw new Conflict(
              'Codex already has an account or custom authentication. This setup action will not replace it. Check this computer instead.',
            );
          client.on('notification', this.notification);
          const result = z
            .object({
              type: z.literal('chatgptDeviceCode'),
              loginId: z.string().min(1),
              verificationUrl: z.string().url(),
              userCode: z.string().min(1).max(128),
            })
            .parse(await client.request('account/login/start', { type: 'chatgptDeviceCode' }));
          this.loginId = result.loginId;
          const url = new URL(result.verificationUrl);
          if (
            url.protocol !== 'https:' ||
            url.hostname !== 'auth.openai.com' ||
            url.username ||
            url.password ||
            url.port
          )
            throw new Error('Unexpected authorization address');
          if (this.closed || this.client !== client) throw new Error('Closed');
          this.current = {
            key,
            state: 'pending',
            verificationUrl: url.href,
            userCode: result.userCode,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          };
          this.timer = setTimeout(() => {
            void this.release('expired');
          }, 15 * 60_000);
          this.timer.unref();
          if (this.earlyCompletion)
            this.notification('account/login/completed', this.earlyCompletion);
          return { key }; // The durable receipt contains no URL, token or device code.
        });
        // A completed receipt from a previous app lifetime must not replay login.
        if (this.current.state === 'starting') this.current = { ...idle, key, state: 'expired' };
      } catch (error) {
        await this.release('failed');
        if (error instanceof Conflict) throw error;
        throw new Conflict(
          'Codex sign-in could not open. Check that Codex is installed, then try sign-in again. No conversation was changed.',
        );
      }
      return this.status();
    })();
    this.pending = request;
    try {
      return await request;
    } finally {
      if (this.pending === request) this.pending = null;
    }
  }
  private notification = (method: string, raw: unknown) => {
    if (method !== 'account/login/completed') return;
    const result = z
      .object({ loginId: z.string().nullable(), success: z.boolean() })
      .safeParse(raw);
    if (!result.success) return;
    if (!this.loginId && this.current.state === 'starting') {
      this.earlyCompletion = result.data;
      return;
    }
    if (!this.loginId || result.data.loginId !== this.loginId) return;
    void this.release(result.data.success ? 'completed' : 'failed');
  };
  private unavailable = () => {
    void this.release('failed');
  };
  private async release(state: 'completed' | 'expired' | 'failed') {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const client = this.client,
      loginId = this.loginId;
    this.client = null;
    this.loginId = null;
    this.earlyCompletion = null;
    this.current = { ...idle, key: this.current.key, state };
    if (client) {
      client.off('notification', this.notification);
      client.off('unavailable', this.unavailable);
      try {
        if (loginId && state !== 'completed')
          await client.request('account/login/cancel', { loginId });
      } catch {
        /* Closing the owned runtime is the backstop. Never expose provider diagnostics. */
      } finally {
        await client.close().catch(() => {});
      }
    }
  }
  async cancel(raw: unknown) {
    const { key } = signInRequestSchema.parse(raw);
    if (this.pending)
      throw new Conflict('Sign-in is still opening. Check its status, then cancel.');
    if (key !== this.current.key) throw new Conflict('This sign-in changed. Reload its status.');
    if (this.current.state !== 'completed') await this.release('expired');
    return this.status();
  }
  async close() {
    this.closed = true;
    await this.pending?.catch(() => {});
    await this.release(this.current.state === 'completed' ? 'completed' : 'expired');
  }
}
