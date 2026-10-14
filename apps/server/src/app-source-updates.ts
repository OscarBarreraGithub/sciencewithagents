import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  appSourceUpdatesSchema,
  type AppSourceBranch,
  type AppSourceUpdates as SourceUpdatesView,
} from '@dock/shared/dist/app-source-updates.js';
import type { Store } from './store.js';
import { inspectAppSource, appSourceUpstream, type Inspection } from './app-source-check.js';

const interval = 6 * 60 * 60 * 1000;
const retry = 15 * 60 * 1000;
/** Source metadata only. Shared by listeners; no provider/runtime/maintenance dependency. */
export class AppSourceUpdates {
  private pending?: Promise<SourceUpdatesView>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private cached?: SourceUpdatesView;
  constructor(
    private readonly store: Store,
    readonly branch: AppSourceBranch,
    root: string,
    private readonly inspect: () => Promise<Inspection> = () =>
      inspectAppSource(root, appSourceUpstream, branch),
    private readonly now = Date.now,
  ) {}
  private get key() {
    return `app-source-updates:${this.branch}`;
  }
  status(): SourceUpdatesView {
    const empty = { branch: this.branch, check: null, lastSuccessful: null, nextCheckAt: null };
    try {
      const parsed = appSourceUpdatesSchema.safeParse(this.store.getSetting(this.key));
      return parsed.success && parsed.data.branch === this.branch
        ? parsed.data
        : (this.cached ?? empty);
    } catch {
      return this.cached ?? empty;
    }
  }
  check(startup = false) {
    if (this.pending) return this.pending;
    const saved = this.status();
    if (
      this.stopped ||
      (saved.nextCheckAt &&
        Date.parse(saved.nextCheckAt) > this.now() &&
        (!startup || (saved.check && this.now() - Date.parse(saved.check.checkedAt) < 60_000)))
    )
      return Promise.resolve(saved);
    this.pending = (async () => {
      let check: NonNullable<SourceUpdatesView['check']>;
      try {
        const info = await this.inspect();
        check = {
          id: randomUUID(),
          checkedAt: new Date(this.now()).toISOString(),
          state: info.current ? 'current' : 'available',
          localChanges: info.localChanges,
          message: info.current
            ? `Up to date with ${this.branch}. Local customizations are retained.`
            : `An update is available on ${this.branch}. Ask your existing setup agent to prepare it.`,
        };
      } catch {
        check = {
          id: randomUUID(),
          checkedAt: new Date(this.now()).toISOString(),
          state: 'error',
          localChanges: false,
          message: `Could not check ${this.branch}. Your installation is unchanged. Retrying in 15 minutes.`,
        };
      }
      const result = appSourceUpdatesSchema.parse({
        branch: this.branch,
        check,
        lastSuccessful: check.state === 'error' ? saved.lastSuccessful : check,
        nextCheckAt: new Date(
          this.now() + (check.state === 'error' ? retry : interval),
        ).toISOString(),
      });
      this.cached = result;
      this.store.setSetting(this.key, result);
      return result;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  start() {
    if (this.timer || this.stopped) return;
    void this.check(true).catch(() => {});
    this.timer = setInterval(() => {
      void this.check().catch(() => {});
    }, 60_000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
export function registerAppSourceUpdateRoutes(
  app: FastifyInstance,
  service: AppSourceUpdates,
  authenticated: (request: FastifyRequest) => boolean,
) {
  app.get(
    '/api/groups/app-updates',
    {
      onRequest: async (request, reply) => {
        if (!authenticated(request))
          return reply
            .code(401)
            .send({ error: 'Open an authenticated owner browser or paired device.' });
      },
    },
    async () => service.status(),
  );
}
