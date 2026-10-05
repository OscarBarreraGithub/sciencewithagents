import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  publishingAccountsSchema,
  publishingCheckRequestSchema,
  type PublishingAccount,
  type PublishingAccountId,
  type PublishingAccounts as Status,
} from '@dock/shared';
import type { Store } from './store.js';

type Output = { stdout: string; stderr: string };
export type AccountProbe = {
  binary(name: 'gh' | 'wrangler'): string | null;
  /** Rejections carry any captured stdout/stderr. */
  run(binary: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<Output>;
};
type Result = Pick<PublishingAccount, 'state' | 'identity' | 'message'>;

export const systemAccountProbe: AccountProbe = {
  binary(name) {
    const home = homedir();
    for (const directory of [
      ...(process.env.PATH ?? '').split(delimiter),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.local/bin'),
      join(home, '.npm-global/bin'),
      join(home, 'Library/pnpm'),
      join(home, '.volta/bin'),
    ].filter(Boolean)) {
      const path = join(directory, name);
      try {
        accessSync(path, constants.X_OK);
        return path;
      } catch {
        /* Next location. */
      }
    }
    return null;
  },
  run(binary, args, env, timeout) {
    return new Promise((resolve, reject) =>
      execFile(
        binary,
        args,
        { env, timeout, maxBuffer: 262_144, cwd: tmpdir(), windowsHide: true },
        (error, stdout, stderr) =>
          error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      ),
    );
  },
};
const output = (error: unknown) => {
  const value = error as Partial<Output>;
  return `${value?.stdout ?? ''}\n${value?.stderr ?? ''}`;
};
// Script-based CLIs need the Node that runs this app when launched with a minimal PATH.
const environment = (binary: string, extra: Record<string, string>) => ({
  ...process.env,
  PATH: [dirname(binary), dirname(process.execPath), process.env.PATH]
    .filter(Boolean)
    .join(delimiter),
  NO_COLOR: '1',
  ...extra,
});

/** Reads the signed-in account through gh's own authentication. Never reads a token. */
export async function checkGitHub(probe: AccountProbe): Promise<Result> {
  const gh = probe.binary('gh');
  if (!gh)
    return {
      state: 'missing',
      identity: null,
      message: 'GitHub CLI is not installed on this computer. The setup prompt installs it.',
    };
  try {
    const { stdout } = await probe.run(
      gh,
      ['api', '--hostname', 'github.com', 'user'],
      environment(gh, {
        GH_HOST: 'github.com',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
      }),
      15_000,
    );
    const { login } = z
      .object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/) })
      .parse(JSON.parse(stdout));
    return { state: 'connected', identity: login, message: `Signed in to GitHub as ${login}.` };
  } catch (error) {
    if (/gh auth login|not logged in|Bad credentials|HTTP 401/i.test(output(error)))
      return {
        state: 'signed_out',
        identity: null,
        message: 'GitHub CLI is installed but not signed in. The setup prompt signs it in.',
      };
    return {
      state: 'unavailable',
      identity: null,
      message:
        'GitHub could not confirm the sign-in. Check the internet connection, then check again. Nothing was changed.',
    };
  }
}

/** Asks Wrangler whether its saved sign-in works. Local files alone never count. */
export async function checkCloudflare(probe: AccountProbe): Promise<Result> {
  const wrangler = probe.binary('wrangler');
  if (!wrangler)
    return {
      state: 'missing',
      identity: null,
      message:
        'Wrangler is not installed where this app can run it. The setup prompt installs it, even if you signed in with npx before.',
    };
  const env = environment(wrangler, { WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' });
  const connected: Result = {
    state: 'connected',
    identity: null,
    message: 'Signed in to Cloudflare with Wrangler.',
  };
  const signedOut: Result = {
    state: 'signed_out',
    identity: null,
    message: 'Wrangler is installed but not signed in. The setup prompt signs it in.',
  };
  let text: string;
  try {
    text = (await probe.run(wrangler, ['whoami', '--json'], env, 25_000)).stdout;
  } catch (error) {
    text = output(error);
    // Older Wrangler releases have no --json; their readable reply has fixed phrases.
    if (/Unknown arguments?:.*json/i.test(text))
      try {
        text = (await probe.run(wrangler, ['whoami'], env, 25_000)).stdout;
      } catch (fallback) {
        text = output(fallback);
      }
  }
  if (/"loggedIn"\s*:\s*true|You are logged in with an/.test(text)) return connected;
  if (/"loggedIn"\s*:\s*false|You are not authenticated/.test(text)) return signedOut;
  return {
    state: 'unavailable',
    identity: null,
    message:
      'Cloudflare could not confirm the Wrangler sign-in. Check the internet connection, then check again. Nothing was changed.',
  };
}

const key = 'publishing-accounts:v1';
const ids: PublishingAccountId[] = ['github', 'cloudflare'];
const savedSchema = z.object({ accounts: publishingAccountsSchema.shape.accounts });
const automaticAge = 10 * 60_000;
const repeatAge = 15_000;
/** Bounded, read-only sign-in checks on this computer. Results persist across restarts. */
export class PublishingAccounts {
  private running: Promise<Status> | null = null;
  constructor(
    private store: Store,
    private probe: AccountProbe = systemAccountProbe,
    private clock = Date.now,
  ) {}
  private saved() {
    const value = savedSchema.safeParse(this.store.getSetting(key));
    return value.success ? value.data.accounts : [];
  }
  status(): Status {
    const saved = this.saved();
    return publishingAccountsSchema.parse({
      available: true,
      checking: !!this.running,
      accounts: ids.map(
        (id) =>
          saved.find((account) => account.id === id) ?? {
            id,
            state: 'unchecked',
            identity: null,
            message: 'Not checked yet.',
            checkedAt: null,
          },
      ),
    });
  }
  /** Reuses a fresh result: ten minutes for automatic checks, seconds for an explicit retry. */
  async check(raw: unknown): Promise<Status> {
    const { force } = publishingCheckRequestSchema.parse(raw ?? {});
    if (this.running) return this.running;
    const checked = this.saved().map((account) => Date.parse(account.checkedAt ?? ''));
    const age = checked.length === ids.length ? this.clock() - Math.min(...checked) : Infinity;
    if (age < (force ? repeatAge : automaticAge)) return this.status();
    this.running = (async () => {
      try {
        const results = await Promise.all([checkGitHub(this.probe), checkCloudflare(this.probe)]);
        const checkedAt = new Date(this.clock()).toISOString();
        this.store.setSetting(key, {
          accounts: results.map((result, index) => ({ id: ids[index], ...result, checkedAt })),
        });
      } finally {
        this.running = null;
      }
      return this.status();
    })();
    return this.running;
  }
}

const off = publishingAccountsSchema.parse({
  available: false,
  checking: false,
  accounts: ids.map((id) => ({
    id,
    state: 'unchecked',
    identity: null,
    message: 'This installation does not check account sign-in.',
    checkedAt: null,
  })),
});
export function registerPublishingAccountRoutes(
  app: FastifyInstance,
  accounts: PublishingAccounts | undefined,
) {
  app.get('/api/publishing-accounts', async () => accounts?.status() ?? off);
  app.post('/api/publishing-accounts/check', async (request) =>
    accounts ? accounts.check(request.body) : off,
  );
}
