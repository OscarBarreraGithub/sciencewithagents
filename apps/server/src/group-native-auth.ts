import { z } from 'zod';
import type { CodexRpc } from './codex.js';
import { GroupIsolationBlocked } from './group-isolation.js';

const deviceResponse = z.object({
  type: z.literal('chatgptDeviceCode'),
  loginId: z.string().min(1),
  verificationUrl: z.string().url(),
  userCode: z.string().min(1).max(128),
});
const accountResponse = z.object({
  requiresOpenaiAuth: z.boolean(),
  account: z.object({ type: z.literal('chatgpt') }).nullable(),
});
// Installed generated v2 CancelLoginAccountResponse/Status: both outcomes prove
// that this old native challenge is no longer pending; unknown responses do not.
const canceledResponse = z.object({ status: z.enum(['canceled', 'notFound']) });
export type GroupNativeAuthState = 'signed-out' | 'pending' | 'authenticated' | 'failed' | 'closed';

/** Host-owned, auth-only capability. Does not expose arbitrary provider RPC,
 * native IDs, credentials, emails, events, turns, Store or publication access.
 * One-time device codes exist in memory only and are returned only to the local
 * owning host. Calling beginDeviceSignIn requires the owner's manual consent;
 * merely constructing/inspecting this route never starts sign-in. */
export class GroupNativeAuth {
  #state: GroupNativeAuthState = 'signed-out';
  #loginId: string | null = null;
  #starting = false;
  #completion: { loginId: string | null; success: boolean } | null = null;
  #timer: NodeJS.Timeout | undefined;
  #closing: Promise<void> | undefined;
  #resolveClosed!: () => void;
  readonly #provider: CodexRpc;
  readonly #admitted: () => void;
  readonly #release: () => Promise<void>;
  readonly closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });
  constructor(
    provider: CodexRpc,
    admitted: () => void,
    release: () => Promise<void>,
    private readonly credentialStore: 'ephemeral' | 'file' = 'ephemeral',
  ) {
    this.#provider = provider;
    this.#admitted = admitted;
    this.#release = release;
    provider.on('notification', this.#notification);
    provider.on('unavailable', this.#unavailable);
  }
  status() {
    this.#admitted();
    return this.#state;
  }
  async inspect(): Promise<'signed-out' | 'authenticated'> {
    this.#admitted();
    if (this.#closing) throw new GroupIsolationBlocked('Native authentication is closed.');
    try {
      // Validate effective policy, rather than assuming CLI overrides won over
      // native enterprise requirements. Never relax those requirements.
      z.object({
        config: z.object({ cli_auth_credentials_store: z.literal(this.credentialStore) }),
      }).parse(await this.#provider.request('config/read', { includeLayers: false }));
      z.object({
        requirements: z
          .object({ cliAuthCredentialsStore: z.literal(this.credentialStore).nullish() })
          .nullable(),
      }).parse(await this.#provider.request('configRequirements/read', {}));
      const value = accountResponse.parse(
        await this.#provider.request('account/read', { refreshToken: false }),
      );
      this.#admitted();
      if (this.#closing) throw new Error('Closed');
      if (!value.requiresOpenaiAuth) throw new Error('Custom authentication');
      const state = value.account ? 'authenticated' : 'signed-out';
      if (this.#state !== 'pending' || state === 'authenticated') this.#state = state;
      return state;
    } catch {
      if (!this.#closing) this.#state = 'failed';
      throw new GroupIsolationBlocked(
        'Isolated native subscription authentication could not be verified. No credentials or provider diagnostics were exported.',
      );
    }
  }
  async beginDeviceSignIn() {
    this.#admitted();
    if (this.#starting || this.#state !== 'signed-out')
      throw new GroupIsolationBlocked(
        'The fresh native sign-in is already started or unavailable.',
      );
    this.#starting = true;
    try {
      if ((await this.inspect()) !== 'signed-out') throw new Error('Existing account');
      const result = deviceResponse.parse(
        await this.#provider.request('account/login/start', { type: 'chatgptDeviceCode' }),
      );
      this.#admitted();
      const url = new URL(result.verificationUrl);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'auth.openai.com' ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('Untrusted native verification URL');
      this.#loginId = result.loginId;
      this.#state = 'pending';
      this.#timer = setTimeout(() => {
        if (this.#loginId !== result.loginId) return;
        void this.#cancelChallenge()
          .then(async () => {
            if (this.#loginId !== null) return;
            const state = await this.inspect();
            if (this.#loginId === null && state === 'signed-out') this.#state = 'failed';
          })
          .catch(() => this.close().catch(() => {}));
      }, 15 * 60_000);
      if (this.#completion) this.#finish(this.#completion);
      return { verificationUrl: result.verificationUrl, userCode: result.userCode };
    } catch {
      this.#state = 'failed';
      await this.close();
      throw new GroupIsolationBlocked(
        'Scoped native device authorization failed. Personal sign-in was not accessed.',
      );
    } finally {
      this.#starting = false;
    }
  }
  /** Explicit owner retry of authorization only. No native thread/turn/input is
   * restarted. The execution capability separately verifies no turn ever began. */
  async restartDeviceSignIn() {
    this.#admitted();
    if (this.#starting || this.#closing)
      throw new GroupIsolationBlocked(
        'The original native sign-in is busy or its runtime ended. Inspect the retained request; no input was replayed.',
      );
    try {
      await this.#cancelChallenge();
    } catch {
      await this.close();
      throw new GroupIsolationBlocked(
        'Cancellation of the previous native sign-in could not be verified. Its owned runtime was stopped; no new challenge or model input was sent.',
      );
    }
    let state: 'signed-out' | 'authenticated';
    try {
      state = await this.inspect();
    } catch {
      await this.close();
      throw new GroupIsolationBlocked(
        'The same native account/policy could not be verified. No new sign-in or model input was sent.',
      );
    }
    if (state !== 'signed-out')
      throw new GroupIsolationBlocked(
        'This exact isolated context is already authenticated. Continue its saved request.',
      );
    this.#state = 'signed-out';
    return this.beginDeviceSignIn();
  }
  async #cancelChallenge() {
    const loginId = this.#loginId;
    if (loginId)
      canceledResponse.parse(await this.#provider.request('account/login/cancel', { loginId }));
    if (this.#closing) throw new GroupIsolationBlocked('Native sign-in runtime ended.');
    if (this.#loginId === loginId) {
      clearTimeout(this.#timer);
      this.#loginId = null;
      this.#completion = null;
    }
  }
  #notification = (method: string, params: unknown) => {
    if (method !== 'account/login/completed') return;
    const result = z
      .object({ loginId: z.string().nullable(), success: z.boolean() })
      .safeParse(params);
    if (!result.success) return;
    if (this.#starting && !this.#loginId) this.#completion = result.data;
    else this.#finish(result.data);
  };
  #finish(result: { loginId: string | null; success: boolean }) {
    if (!this.#loginId || result.loginId !== this.#loginId) return;
    clearTimeout(this.#timer);
    this.#loginId = null;
    if (!result.success) {
      this.#state = 'failed';
      return;
    }
    // Native completion is not sufficient: verify the sanitized subscription
    // account in this exact admitted process; no token-returning RPC exists here.
    void this.inspect().catch(() => this.close());
  }
  #unavailable = () => {
    void this.close();
  };
  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }
  /** The enclosing owned namespace has stopped; discard only auth observation
   * state/timers. This never claims a process stop or performs another login. */
  disposeObservation() {
    clearTimeout(this.#timer);
    this.#provider.off('notification', this.#notification);
    this.#provider.off('unavailable', this.#unavailable);
  }
  async #close() {
    this.#state = 'closed';
    clearTimeout(this.#timer);
    this.#provider.off('notification', this.#notification);
    this.#provider.off('unavailable', this.#unavailable);
    try {
      if (this.#loginId && this.#provider.ready)
        await this.#provider.request('account/login/cancel', { loginId: this.#loginId });
    } catch {
      /* Owned process stop is the backstop; never export diagnostics. */
    } finally {
      this.#loginId = null;
      await this.#release();
      this.#resolveClosed();
    }
  }
}
