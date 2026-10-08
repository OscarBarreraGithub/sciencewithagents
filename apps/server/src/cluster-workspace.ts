import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import {
  clusterWorkspaceControlSchema,
  clusterFolderDescriptorSchema,
  clusterIndexEntrySchema,
  clusterRootIndexSchema,
  clusterWorkspaceLeaseRequestSchema,
  clusterWorkspaceRefreshSchema,
  clusterWorkspaceSchema,
  clusterWorkspaceSettingsSchema,
  clusterWorkspaceUpdateResultSchema,
  defaultModelPolicy,
  modelPolicySchema,
  newProjectWorkflow,
  type ClusterFolderDescriptor,
  type ClusterWorkspaceRoot,
  type ClusterWorkspaceStatus,
  type ClusterWorkspaceUpdateResult,
  type ClusterDevelopment,
} from '@dock/shared';
import { Conflict } from './store.js';
import { queryOptions, type ClusterMonitor } from './cluster.js';
import {
  spawnClusterLease,
  type ClusterLeaseSpawn,
  type HeldClusterClient,
} from './cluster-connection-lease.js';
import { clusterWorkspaceProbe } from './cluster-workspace-probe.js';

const prefix = 'cluster:workspace:v1:';
const blankIndex = () =>
  clusterRootIndexSchema.parse({
    state: 'stale',
    observedAt: null,
    connectionId: null,
    canonicalPath: null,
    error: null,
    entries: [],
    omitted: 0,
  });
const rawIndex = z
  .object({
    id: z.uuid(),
    canonicalPath: z.string().max(1000).nullable(),
    entries: z.array(clusterIndexEntrySchema.omit({ id: true })).max(300),
    omitted: z.number().int().nonnegative(),
    truncated: z.boolean(),
    error: z.string().max(400).nullable(),
  })
  .strict();
const probeResult = z
  .object({
    username: z.string().min(1).max(100),
    defaultAccount: z.string().max(100).nullable(),
    accounts: z.array(z.string().max(100)).max(50),
    setupError: z.string().max(400).nullable(),
    roots: z.array(rawIndex).max(8),
  })
  .strict();
type Saved = ClusterWorkspaceStatus & { confirmedUsername: string | null };
export type ClusterWorkspaceSetupApproval = {
  key: string;
  alias: string;
  workspaceRevision: number;
  username: string | null;
  account: string | null;
  siteRules: ClusterWorkspaceStatus['siteRules'];
  development: ClusterDevelopment;
};

/** Saved metadata and account approval are scoped to the configured alias. Only the
 * owner setup API accepts root paths; execution resolves an opaque directory ID. */
export class ClusterWorkspace {
  private closed = false;
  private generation = 0;
  private running: Promise<void> | null = null;
  private reindex = false;
  private fingerprint: string | null = null;
  private connectionId: string | null = null;
  private forcedConnectionId: string | null = null;
  private connected = false;
  private holder: HeldClusterClient | null = null;
  private holderAlias: string | null = null;
  private expiry: NodeJS.Timeout | null = null;
  private nextHoldAttempt = 0;
  private closingHolders = new Set<Promise<void>>();
  private unwatch: (() => void)[];
  constructor(
    private cluster: ClusterMonitor,
    private spawn: ClusterLeaseSpawn = spawnClusterLease,
    /** Synchronous, inside the setup transaction. Merge and version the review policy
     * using this same Store; never start a nested transaction or a provider call. */
    private onSetupSaved?: (approval: ClusterWorkspaceSetupApproval) => void,
  ) {
    this.unwatch = [
      cluster.onTargetChange(() => {
        this.generation++;
        this.fingerprint = this.connectionId = this.forcedConnectionId = null;
        this.connected = false;
        this.stopHolder();
        this.clearExpiry();
      }),
      cluster.onSignedIn((id) => {
        if (id) {
          this.generation++;
          this.forcedConnectionId = id;
          this.fingerprint = null;
          this.connected = false;
          this.reindex = true;
        }
        // The collector invokes reconcile once its fresh account/partition reading finishes.
      }),
    ];
  }
  private alias() {
    return this.cluster.settings()?.alias ?? null;
  }
  private read(alias = this.alias()): Saved {
    const raw = alias ? this.cluster.store.getSetting(prefix + alias) : null;
    if (raw) {
      const { confirmedUsername, ...visible } = raw as Saved;
      return {
        ...clusterWorkspaceSchema.parse(visible),
        confirmedUsername: typeof confirmedUsername === 'string' ? confirmedUsername : null,
      };
    }
    return {
      ...clusterWorkspaceSchema.parse({
        alias,
        revision: 0,
        connectionId: null,
        connected: false,
        setup: {
          username: null,
          defaultAccount: null,
          accounts: [],
          partitions: [],
          selectedAccount: null,
          accountConfirmed: false,
          observedAt: null,
          fairshareObservedAt: null,
          partitionsObservedAt: null,
          developmentSuggestion: null,
          suggestedDevelopment: null,
          error: null,
        },
        roots: [],
        development: {},
        siteRules: null,
        workflow: newProjectWorkflow(
          modelPolicySchema.parse(
            this.cluster.store.getSetting('model-policy') ?? defaultModelPolicy,
          ),
        ),
        keepConnected: {
          enabled: false,
          expiresAt: null,
          state: 'off',
          message: 'Keep connected is off.',
        },
      }),
      confirmedUsername: null,
    };
  }
  private write(saved: Saved) {
    if (saved.alias) this.cluster.store.setSetting(prefix + saved.alias, saved);
  }
  private assertAlias(alias: string) {
    if (this.closed || alias !== this.alias() || !this.cluster.settings()?.enabled)
      throw new Conflict('The connected cluster changed. Reopen its setup before retrying.');
  }
  status(): ClusterWorkspaceStatus {
    const { confirmedUsername: _, ...saved } = this.read();
    const reading = this.cluster.status();
    const fresh = (section: { observedAt: string | null; error: string | null }) =>
      this.connected &&
      reading.connection.state === 'connected' &&
      !section.error &&
      Boolean(section.observedAt) &&
      this.cluster.now() - Date.parse(section.observedAt!) >= 0 &&
      this.cluster.now() - Date.parse(section.observedAt!) <= 20 * 60000;
    const partitions = fresh(reading.limits) ? reading.limits.partitions : [];
    const suggestTest =
      saved.siteRules === 'fasrc-cannon' &&
      partitions.some(
        (partition) =>
          partition.name === 'test' &&
          partition.accessible === true &&
          /^(UP|IDLE|MIXED|ALLOCATED)$/i.test(partition.state),
      );
    const deadline = saved.keepConnected.expiresAt ? Date.parse(saved.keepConnected.expiresAt) : 0;
    const enabled = deadline > this.cluster.now();
    const state = !deadline
      ? 'off'
      : !enabled
        ? 'expired'
        : this.holder
          ? 'holding'
          : 'reconnecting';
    return clusterWorkspaceSchema.parse({
      ...saved,
      connectionId: this.connectionId,
      connected: this.connected,
      setup: {
        ...saved.setup,
        accounts: saved.setup.accounts.map(({ name }) => ({
          name,
          fairShare: fresh(reading.fairshare)
            ? (reading.fairshare.items.find((item) => item.account === name)?.fairShare ?? null)
            : null,
        })),
        partitions,
        fairshareObservedAt: reading.fairshare.observedAt,
        partitionsObservedAt: reading.limits.observedAt,
        developmentSuggestion: suggestTest
          ? 'Suggested for development: the accessible FASRC test partition, 2 CPUs, 8 GiB, 2 hours, and a 20-minute idle timeout. Review and save these editable defaults; native Slurm remains authoritative.'
          : null,
        suggestedDevelopment: suggestTest
          ? {
              partition: 'test',
              qos: null,
              cpus: 2,
              memoryMb: 8192,
              timeMinutes: 120,
              idleMinutes: 20,
            }
          : null,
        accountConfirmed: saved.setup.accountConfirmed,
      },
      roots: saved.roots.map((root) => ({
        ...root,
        index: {
          ...root.index,
          state:
            !['error', 'indexing'].includes(root.index.state) &&
            (!this.connected || root.index.connectionId !== this.connectionId)
              ? 'stale'
              : root.index.state,
        },
      })),
      keepConnected: {
        enabled,
        expiresAt: saved.keepConnected.expiresAt,
        state,
        message:
          state === 'holding'
            ? 'The app is holding a shared SSH client until this deadline. Authentication or network access may expire sooner.'
            : state === 'expired'
              ? 'The app’s keep-connected lease expired. Other SSH sessions and cluster jobs were left running.'
              : state === 'reconnecting'
                ? 'Waiting for an authenticated shared sign-in. The app never renews passwords or verification codes.'
                : 'Keep connected is off.',
      },
    });
  }
  /** CAS and durable receipts preserve both devices' unsaved setup choices. */
  save(raw: unknown): ClusterWorkspaceUpdateResult {
    const input = clusterWorkspaceSettingsSchema.parse(raw);
    this.assertAlias(input.alias);
    let changed = false;
    const result = this.cluster.store.operation(
      input.key,
      { kind: 'cluster.workspace.settings', ...input },
      () => {
        const saved = this.read();
        if (saved.revision !== input.revision)
          return {
            status: 'conflict',
            state: this.status(),
            reason:
              'Cluster setup changed on another device. Your unsaved choices are retained; read the current version before saving again.',
          };
        if (
          input.account &&
          !(saved.setup.accountConfirmed && input.account === saved.setup.selectedAccount) &&
          (!this.connected ||
            saved.setup.error ||
            !saved.setup.accounts.some((account) => account.name === input.account))
        )
          throw new Conflict('Choose an account from a successful current cluster setup reading.');
        const existing = new Map(saved.roots.map((root) => [root.id, root]));
        saved.roots = input.roots.map((root): ClusterWorkspaceRoot => {
          const previous = root.id ? existing.get(root.id) : undefined;
          if (root.id && !previous)
            throw new Conflict('This saved root changed. Read cluster setup before retrying.');
          return {
            id: previous?.id ?? randomUUID(),
            label: root.label,
            path: root.path,
            index:
              previous && previous.path === root.path
                ? { ...previous.index, state: 'stale' }
                : blankIndex(),
          };
        });
        if (new Set(saved.roots.map((root) => root.id)).size !== saved.roots.length)
          throw new Conflict('Save each cluster root once.');
        saved.setup.selectedAccount = input.account;
        saved.setup.accountConfirmed = Boolean(input.account);
        saved.confirmedUsername = input.account ? saved.setup.username : null;
        saved.development = input.development;
        if (input.siteRules !== undefined) saved.siteRules = input.siteRules;
        saved.workflow = input.workflow;
        saved.revision++;
        this.onSetupSaved?.({
          key: input.key,
          alias: input.alias,
          workspaceRevision: saved.revision,
          username: saved.setup.username,
          account: input.account,
          siteRules: saved.siteRules,
          development: saved.development,
        });
        this.write(saved);
        this.cluster.store.event('cluster.workspace_saved', null, null, {
          roots: saved.roots.length,
          accountConfirmed: saved.setup.accountConfirmed,
        });
        changed = true;
        return { status: 'saved', state: this.status(), reason: null };
      },
    );
    if (changed) {
      this.generation++;
      this.reindex = true;
      void this.reconcile(true).catch(() => {});
    }
    return clusterWorkspaceUpdateResultSchema.parse(result);
  }
  async renew(raw: unknown): Promise<ClusterWorkspaceUpdateResult> {
    const input = clusterWorkspaceLeaseRequestSchema.parse(raw);
    this.assertAlias(input.alias);
    let changed = false;
    const result = this.cluster.store.operation(
      input.key,
      { kind: 'cluster.workspace.lease', ...input },
      () => {
        const saved = this.read();
        if (saved.revision !== input.revision)
          return {
            status: 'conflict',
            state: this.status(),
            reason: 'Cluster setup changed. Read its current deadline before renewing.',
          };
        saved.keepConnected.expiresAt =
          input.hours === null
            ? null
            : new Date(this.cluster.now() + input.hours * 3600000).toISOString();
        saved.revision++;
        this.write(saved);
        this.cluster.store.event('cluster.connection_lease', null, null, {
          enabled: input.hours !== null,
          hours: input.hours,
        });
        changed = true;
        return { status: 'saved', state: this.status(), reason: null };
      },
    );
    if (changed) {
      this.generation++;
      this.stopHolder();
      this.clearExpiry();
      if (this.running) {
        this.reindex = true;
        void this.reconcile(true).catch(() => {});
      }
    }
    await this.ensureHolder();
    // Return the original durable receipt; GET reports the holder's current state.
    return clusterWorkspaceUpdateResultSchema.parse(result);
  }
  /** Bind a native tool retry to its first alias and revision, even after a lost reply. */
  async control(key: string, raw: unknown) {
    const input = clusterWorkspaceControlSchema.parse(raw);
    if (input.action === 'inspect') return this.status();
    const request = this.cluster.store.operation(
      key,
      { kind: 'cluster.workspace.control', input },
      () => {
        const status = this.status();
        if (!status.alias)
          throw new Conflict('Save the cluster connection before changing its lease.');
        return {
          key: randomUUID(),
          alias: status.alias,
          revision: status.revision,
          hours: input.action === 'renew' ? input.hours : null,
        };
      },
    );
    return this.renew(request);
  }
  async refresh(raw: unknown) {
    const input = clusterWorkspaceRefreshSchema.parse(raw);
    this.assertAlias(input.alias);
    await this.reconcile(true);
    return this.status();
  }
  /** After every collector result. A new authenticated master indexes saved roots once;
   * disconnected/failing attempts retain older metadata explicitly as stale. */
  async reconcile(force = false): Promise<void> {
    if (this.closed) return;
    if (this.running) {
      if (force) this.reindex = true;
      await this.running;
      if (this.reindex && !this.closed) {
        this.reindex = false;
        await this.reconcile(true);
      }
      return;
    }
    const alias = this.alias();
    if (!alias || !this.cluster.settings()?.enabled) return;
    const generation = this.generation;
    const target = this.cluster.target();
    const current = () =>
      !this.closed &&
      generation === this.generation &&
      this.cluster.isCurrent(target) &&
      this.alias() === alias &&
      Boolean(this.cluster.settings()?.enabled);
    const run = (async () => {
      const fingerprint = await this.cluster.masterIdentity(alias);
      if (!current()) return;
      if (!fingerprint || this.cluster.status().connection.state !== 'connected') {
        this.connected = false;
        this.fingerprint = null;
        this.stopHolder();
        return;
      }
      this.connected = true;
      const changed = fingerprint !== this.fingerprint || Boolean(this.forcedConnectionId);
      if (changed) {
        this.fingerprint = fingerprint;
        this.connectionId = this.forcedConnectionId ?? randomUUID();
        this.forcedConnectionId = null;
      }
      await this.ensureHolder();
      if (!current() || (!changed && !force && !this.reindex)) return;
      this.reindex = false;
      const saved = this.read(alias);
      const before = new Map(saved.roots.map((root) => [root.id, root.index]));
      saved.roots = saved.roots.map((root) => ({
        ...root,
        index: { ...root.index, state: 'indexing', error: null },
      }));
      this.write(saved);
      const payload = Buffer.from(
        JSON.stringify({ roots: saved.roots.map(({ id, path }) => ({ id, path })) }),
      ).toString('base64');
      try {
        const result = await this.cluster.runner(
          [...queryOptions, '--', alias, 'bash', '-s', '--', payload],
          clusterWorkspaceProbe,
          45000,
        );
        if (!current()) return;
        if (result.code !== 0) throw new Error('probe');
        const found = probeResult.parse(JSON.parse(result.stdout));
        const at = new Date(this.cluster.now()).toISOString();
        const previouslyApproved =
          saved.setup.accountConfirmed &&
          saved.confirmedUsername === found.username &&
          (Boolean(found.setupError) || found.accounts.includes(saved.setup.selectedAccount ?? ''));
        const selected = previouslyApproved
          ? saved.setup.selectedAccount
          : found.accounts.length === 1 && !found.setupError
            ? found.accounts[0]!
            : null;
        saved.setup = {
          username: found.username,
          defaultAccount: found.defaultAccount,
          accounts:
            found.setupError && saved.setup.username === found.username
              ? saved.setup.accounts
              : found.accounts.map((name) => ({ name, fairShare: null })),
          partitions: [],
          selectedAccount: selected,
          accountConfirmed: Boolean(selected),
          observedAt: at,
          fairshareObservedAt: null,
          partitionsObservedAt: null,
          developmentSuggestion: null,
          suggestedDevelopment: null,
          error: found.setupError,
        };
        saved.confirmedUsername = selected ? found.username : null;
        saved.connectionId = this.connectionId;
        saved.roots = saved.roots.map((root) => {
          const index = found.roots.find((item) => item.id === root.id);
          const previous = before.get(root.id)!;
          if (!index || index.error)
            return {
              ...root,
              index: {
                ...previous,
                state: 'error',
                error: index?.error ?? 'The saved folder was missing from the index reply.',
              },
            };
          const ids =
            previous.canonicalPath === index.canonicalPath
              ? new Map(previous.entries.map((item) => [item.relativePath, item.id]))
              : new Map<string, string>();
          return {
            ...root,
            index: {
              state: index.truncated ? 'truncated' : 'ready',
              observedAt: at,
              connectionId: this.connectionId,
              canonicalPath: index.canonicalPath,
              error: null,
              omitted: index.omitted,
              entries: index.entries.map((item) => ({
                ...item,
                id:
                  item.relativePath === '.'
                    ? root.id
                    : (ids.get(item.relativePath) ?? randomUUID()),
              })),
            },
          };
        });
        this.write(saved);
        this.cluster.store.event('cluster.workspace_indexed', null, null, {
          roots: saved.roots.length,
          accountConfirmed: saved.setup.accountConfirmed,
        });
      } catch {
        if (!current()) return;
        saved.setup.error =
          'Cluster setup could not be read. Cached metadata is retained; sign in and refresh to try again.';
        saved.roots = saved.roots.map((root) => ({
          ...root,
          index: {
            ...before.get(root.id)!,
            state: 'error',
            error: 'The index could not be refreshed. Previously saved metadata is retained.',
          },
        }));
        this.write(saved);
      }
    })();
    this.running = run;
    try {
      await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }
  async resolveFolder(folderId: string): Promise<ClusterFolderDescriptor> {
    z.uuid().parse(folderId);
    const state = this.status();
    if (
      !state.alias ||
      !state.connected ||
      !state.connectionId ||
      !state.setup.accountConfirmed ||
      state.setup.error ||
      !state.setup.username ||
      !state.setup.selectedAccount
    )
      throw new Conflict(
        'Sign in and explicitly confirm the cluster account before opening a project.',
      );
    const root = state.roots.find((root) =>
      root.index.entries.some((entry) => entry.id === folderId && entry.kind === 'directory'),
    );
    if (
      !root ||
      !['ready', 'truncated'].includes(root.index.state) ||
      root.index.connectionId !== state.connectionId ||
      !root.index.observedAt ||
      !root.index.canonicalPath
    )
      throw new Conflict('Refresh the saved root before selecting an indexed project folder.');
    const entry = root.index.entries.find((entry) => entry.id === folderId)!;
    const generation = this.generation,
      target = this.cluster.target(),
      connectionId = this.connectionId;
    const payload = Buffer.from(
      JSON.stringify({
        validate: {
          root: root.path,
          canonicalPath: root.index.canonicalPath,
          relativePath: entry.relativePath,
        },
      }),
    ).toString('base64');
    const result = await this.cluster.runner(
      [...queryOptions, '--', state.alias, 'bash', '-s', '--', payload],
      clusterWorkspaceProbe,
      15000,
    );
    if (
      this.closed ||
      generation !== this.generation ||
      connectionId !== this.connectionId ||
      !this.cluster.isCurrent(target)
    )
      throw new Conflict('The cluster connection changed. Select the project again.');
    let parsed: unknown = null;
    try {
      if (result.code === 0) parsed = JSON.parse(result.stdout);
    } catch {}
    const validated = z
      .object({
        username: z.string(),
        path: z.string().nullable(),
        directoryIdentity: z
          .string()
          .regex(/^\d+:\d+$/)
          .nullable()
          .default(null),
        directoryOwnerUid: z.number().int().nonnegative().nullable().optional(),
        error: z.string().nullable(),
      })
      .strict()
      .safeParse(parsed);
    const expectedPath = posix.resolve(root.index.canonicalPath, entry.relativePath);
    if (
      !validated.success ||
      validated.data.error ||
      !validated.data.path ||
      validated.data.username !== state.setup.username ||
      validated.data.path !== expectedPath
    )
      throw new Conflict(
        'The indexed folder or cluster identity changed. Refresh setup before opening it.',
      );
    return clusterFolderDescriptorSchema.parse({
      alias: state.alias,
      rootId: root.id,
      folderId,
      path: validated.data.path,
      directoryIdentity: validated.data.directoryIdentity,
      directoryOwnerUid: validated.data.directoryOwnerUid,
      gitMarker: entry.git,
      username: state.setup.username,
      account: state.setup.selectedAccount,
      development: state.development,
      siteRules: state.siteRules,
      workflow: state.workflow,
      indexObservedAt: root.index.observedAt,
      connectionId: state.connectionId,
    });
  }
  private clearExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }
  private stopHolder() {
    const holder = this.holder;
    this.holder = null;
    this.holderAlias = null;
    if (holder) {
      const closing = Promise.resolve(holder.close());
      this.closingHolders.add(closing);
      void closing.finally(() => this.closingHolders.delete(closing));
    }
  }
  private async ensureHolder() {
    const saved = this.read();
    const deadline = saved.keepConnected.expiresAt ? Date.parse(saved.keepConnected.expiresAt) : 0;
    this.clearExpiry();
    if (this.closed || !saved.alias || deadline <= this.cluster.now()) {
      this.stopHolder();
      return;
    }
    this.expiry = setTimeout(() => {
      this.stopHolder();
      this.clearExpiry();
    }, deadline - this.cluster.now());
    this.expiry.unref();
    if (this.holder && this.holderAlias === saved.alias) return;
    if (
      this.cluster.now() < this.nextHoldAttempt ||
      (await this.cluster.masterState(saved.alias)) !== 'running'
    )
      return;
    if (
      this.closed ||
      this.alias() !== saved.alias ||
      this.read().keepConnected.expiresAt !== saved.keepConnected.expiresAt
    )
      return;
    if (this.holder || this.cluster.now() < this.nextHoldAttempt) return;
    this.nextHoldAttempt = this.cluster.now() + 30000;
    const holder = this.spawn(saved.alias);
    this.holder = holder;
    this.holderAlias = saved.alias;
    holder.onExit(() => {
      if (this.holder === holder) {
        this.holder = null;
        this.holderAlias = null;
      }
    });
  }
  async close() {
    this.closed = true;
    this.generation++;
    for (const unwatch of this.unwatch) unwatch();
    this.clearExpiry();
    this.stopHolder();
    await Promise.all(this.closingHolders);
    await this.running?.catch(() => {});
  }
}
