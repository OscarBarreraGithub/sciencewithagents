import { createHash } from 'node:crypto';
import { z } from 'zod';

const oidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
export function sharedPath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(path) ||
    path.split('/').some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')
  )
    throw new Error('Invalid scoped path');
  return path;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export type Visibility = 'private' | 'metadata' | 'content';
export interface ContentPolicy {
  /** Immutable host grant revision; default must be private. Never infer grants from names. */
  revision: string;
  visibility(path: string): Visibility;
}
export interface GitCall {
  cwd: string;
  argv: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** Transport MUST disable lazy fetching, prompts and LFS inside the separately verified
   * host control-file boundary. Selective argv overrides do not establish that boundary. */
  environment: { GIT_TERMINAL_PROMPT: '0'; GIT_NO_LAZY_FETCH: '1'; GIT_LFS_SKIP_SMUDGE: '1' };
  stdin?: Buffer;
  transfer?:
    | { mode: 'blobless'; maxBytes: number; expectedTip: string }
    | { mode: 'proposal'; maxBytes: number };
}
export interface GitGateObservation {
  /** Fixture records must NEVER enable a production repository. Records are trusted adapter
   * observations, not self-authenticating proofs; production verification is not supplied. */
  scope: 'disposable-local-fixture' | 'production';
  endpoint: string;
  gate: 'blobless-byte-budget' | 'create-only-proposal';
  evidenceId: string;
  mechanism: string;
  expectedTip?: string;
  maxBytes?: number;
  ref?: string;
}
/** Trusted host registration and per-call verification; never supplied by a browser/agent.
 * configIdentity identifies the host control-file isolation policy revision, not a claim
 * that mutable repository config has been neutralized by these fields. */
export interface HostGitContext {
  scope: GitGateObservation['scope'];
  hostCallerId: string;
  boundaryRevision: string;
  repositoryId: string;
  root: string;
  endpoint: string;
  resourceIdentity: string;
  configIdentity: string;
  grantRevision: string;
  mappingDigest: string;
}
export interface HostGitBoundaryRequest extends HostGitContext {
  callDigest: string;
}
export interface HostGitBoundaryObservation extends HostGitBoundaryRequest {
  evidenceId: string;
  mechanism: string;
}
const hostContextSchema = z
  .object({
    scope: z.enum(['disposable-local-fixture', 'production']),
    hostCallerId: z.string().min(1).max(160),
    boundaryRevision: z.string().min(1).max(160),
    repositoryId: z.string().min(1).max(160),
    root: z.string().min(1),
    endpoint: z.string().min(1),
    resourceIdentity: z.string().min(1).max(160),
    configIdentity: z.string().min(1).max(160),
    grantRevision: z.string().min(1).max(160),
    mappingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Must execute before EVERY transport.run, including passive recovery/metadata reads.
 * The trusted observer must use an already safe host mechanism, never unsafe Git to
 * discover whether Git is safe. Matching records are not self-authenticating. */
export async function requireHostGitBoundary(
  git: GitTransport,
  context: HostGitContext,
  call: GitCall,
): Promise<void> {
  const registration = hostContextSchema.safeParse(context);
  if (!registration.success)
    throw new GroupGitBlocked('Host Git boundary registration missing or malformed');
  if (registration.data.scope === 'disposable-local-fixture') {
    const endpoint = new URL(registration.data.endpoint);
    if (endpoint.protocol !== 'file:' || endpoint.hostname)
      throw new GroupGitBlocked('Host Git fixture boundary requires a local file endpoint');
  }
  const expected = { ...registration.data, callDigest: digest(call) };
  if (call.cwd !== expected.root) throw new GroupGitBlocked('Host Git root mismatch');
  const observed = await git.observeHostGitBoundary?.(structuredClone(expected));
  const parsed = hostContextSchema
    .extend({
      callDigest: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceId: z.string().min(1).max(160),
      mechanism: z.string().min(1).max(200),
    })
    .strict()
    .safeParse(observed);
  if (!parsed.success) throw new GroupGitBlocked('Host Git boundary has not been verified');
  const { evidenceId: _evidence, mechanism: _mechanism, ...binding } = parsed.data;
  if (digest(binding) !== digest(expected))
    throw new GroupGitBlocked('Host Git boundary binding mismatch');
}
export interface GitResourceIdentity {
  resourceIdentity: string;
  configIdentity: string;
}
/** All behavior-affecting mappings/limits bind retries and host boundary observations. */
export function repositoryBinding(repository: GroupRepository): unknown {
  const { authorize: _authorize, policy, ...registration } = repository;
  return {
    ...registration,
    verificationScope: repository.verificationScope ?? 'production',
    policyRevision: policy.revision,
  };
}
function effectIntent(operation: GitOperation): boolean {
  return Boolean(
    operation.result &&
      typeof operation.result === 'object' &&
      Object.hasOwn(operation.result, 'effectIntent'),
  );
}
export interface GitTransport {
  run(call: GitCall): Promise<Buffer>;
  /** Production default deny. Trusted host observer revalidates control files, endpoint,
   * resource fencing and process containment BEFORE each call; must not run unsafe Git.
   * Fixture evidence never enables production. No production observer is implemented. */
  observeHostGitBoundary?(
    request: HostGitBoundaryRequest,
  ): Promise<HostGitBoundaryObservation | null>;
  /** Return null unless an executable endpoint/budget verification has actually been observed.
   * A caller-set capability boolean is not accepted. Fixture evidence is local-only. */
  observeBloblessGate?(
    endpoint: string,
    expectedTip: string,
    maxBytes: number,
  ): Promise<GitGateObservation | null>;
  observeCreateOnlyGate?(endpoint: string, ref: string): Promise<GitGateObservation | null>;
  /** Explicit selected-content transfer, never a lazy Git fallback. */
  readApprovedBlob?(request: {
    repositoryId: string;
    endpoint: string;
    oid: string;
    path: string;
    grantRevision: string;
    maxBytes: number;
    timeoutMs: number;
  }): Promise<Buffer>;
}
export class GroupGitBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroupGitBlocked';
  }
}
export type OperationState = 'planned' | 'running' | 'uncertain' | 'verified' | 'blocked';
export interface GitOperation {
  id: string;
  repositoryId: string;
  payloadHash: string;
  state: OperationState;
  result?: unknown;
}
export interface GitEvent {
  id: string;
  repositoryId: string;
  type: 'main-observed' | 'main-view' | 'task-pinned' | 'proposal-published';
  value: unknown;
}
export interface GitJournal {
  /** Durable repository exclusion. Crash recovery must first establish executor AND descendant Git process quiescence,
   * including children surviving executor SIGKILL.
   * Do not implement this with an expiring advisory edit intent or a process-local mutex alone. */
  exclusive<T>(repositoryId: string, work: () => Promise<T>): Promise<T>;
  /** Atomic insert-or-read of the latest durable state; same ID + different payload must fail.
   * No effect-intent may be lost/omitted: absence is the proof allowing pre-effect retry. */
  begin(operation: GitOperation): GitOperation;
  /** Append-only transition; verified result and optional deduplicated outbox event commit together. */
  /** Omitted result preserves the last durable expectation/effectIntent. Intent records must
   * commit durably BEFORE run(fetch/push) or views.create; failure to persist forbids the effect. */
  record(id: string, state: OperationState, result?: unknown, event?: GitEvent): void;
}
export interface ViewFile {
  path: string;
  mode: '100644' | '100755';
  bytes: Buffer;
}
export interface ViewExpectation {
  id: string;
  repositoryId: string;
  baseOid: string;
  manifestDigest: string;
}
export interface ImmutableViews {
  /** Inspect durable receipt + actual bytes/modes; mismatches must not be adopted. */
  inspect(id: string): Promise<ViewExpectation | null>;
  /** Create only in a new host-owned directory; never overwrite any editor/worktree.
   * Atomic durable publication; identical receipt is idempotent, mismatches throw.
   * Must reject symlink traversal. Immutable views are not editable task checkouts. */
  create(expectation: ViewExpectation, files: readonly ViewFile[]): Promise<void>;
}
export interface GroupRepository {
  repositoryId: string;
  /** All paths/endpoint/ref mappings originate in trusted host registration, never browser input. */
  root: string;
  endpoint: string;
  /** Registered host-owned store, distinct from the editable copy. No in-place migration. */
  observation: GitResourceIdentity & { root: string };
  active: GitResourceIdentity;
  hostCallerId: string;
  boundaryRevision: string;
  mainRef: string;
  /** Explicit test-host opt-in only. Defaults to production, which rejects fixture records. */
  verificationScope?: GitGateObservation['scope'];
  observedRefs: Readonly<Record<string, string>>;
  policy: ContentPolicy;
  maxOutputBytes: number;
  maxTransferBytes: number;
  maxFileBytes: number;
  maxViewBytes: number;
  maxFiles: number;
  /** Membership, endpoint identity, executor and grant revalidation before EACH retry/effect.
   * Observe requires a grant for fetched commit/tree metadata. Proposal must validate trusted
   * review and entire-history grant receipts bound to the exact request; booleans are not proof. */
  authorize(
    action: 'observe' | 'view' | 'proposal',
    grantRevision: string,
    request: ObserveRequest | ViewRequest | ProposalRequest,
  ): Promise<boolean>;
}
const refSchema = z
  .string()
  .max(240)
  .refine(
    (v) =>
      /^refs\/(?:heads|dock-observed)\//.test(v) &&
      !/[\s~^:?*\[\\]/.test(v) &&
      !v.includes('..') &&
      !v.includes('@{') &&
      !v.includes('//') &&
      !v.endsWith('/') &&
      !v.endsWith('.') &&
      v.split('/').every((p) => !p.startsWith('.') && !p.endsWith('.lock')),
    'Invalid ref',
  );
export interface ObserveRequest {
  operationId: string;
  remoteRef: string;
  expectedPrevious: string | null;
  expectedTip: string;
  grantRevision: string;
}
export interface ObserveResult {
  oid: string;
  previousOid: string | null;
  history: 'initial' | 'same' | 'advanced' | 'rewritten';
}
export interface ViewRequest {
  operationId: string;
  viewId: string;
  expectedMain: string;
  grantRevision: string;
  kind: 'main' | 'task';
}
export interface ProposalRequest {
  operationId: string;
  proposalId: string;
  sourceOid: string;
  expectedTarget: string | null;
  grantRevision: string;
  review: { approved: true; sourceOid: string; grantRevision: string; reviewId: string };
  /** Separate explicit grant for the complete reachable history, not just the current tree. */
  historyGrant: { revision: string; sourceOid: string; targetOid: string | null };
}

/** No runtime timer, model API, branch checkout, index writes, or main publication route. */
export class GroupGit {
  private deadline: number | null = null;
  constructor(
    readonly repository: GroupRepository,
    private readonly git: GitTransport,
    private readonly journal: GitJournal,
    private readonly views: ImmutableViews,
  ) {
    idSchema.parse(repository.repositoryId);
    if (!repository.observation?.root || repository.observation.root === repository.root)
      throw new GroupGitBlocked('Separate host-owned observation store required');
    if (repository.verificationScope === 'disposable-local-fixture') {
      const endpoint = new URL(repository.endpoint);
      if (endpoint.protocol !== 'file:' || endpoint.hostname)
        throw new Error('Fixture evidence is restricted to disposable local file endpoints');
    }
    refSchema.parse(repository.mainRef);
    if (!repository.observedRefs[repository.mainRef])
      throw new Error('Main ref is not allowlisted');
    const destinations = new Set<string>();
    for (const [source, target] of Object.entries(repository.observedRefs)) {
      refSchema.parse(source);
      refSchema.parse(target);
      if (
        !source.startsWith('refs/heads/') ||
        !target.startsWith('refs/dock-observed/') ||
        destinations.has(target)
      )
        throw new Error('Observation refs must be distinct from active branches');
      destinations.add(target);
    }
    if (
      !repository.endpoint ||
      repository.endpoint.startsWith('-') ||
      /[\x00-\x1f]/.test(repository.endpoint)
    )
      throw new Error('Invalid registered endpoint');
    z.number().int().positive().max(10_000).parse(repository.maxFiles);
    for (const n of [
      repository.maxOutputBytes,
      repository.maxTransferBytes,
      repository.maxFileBytes,
      repository.maxViewBytes,
      repository.maxFiles,
    ])
      z.number()
        .int()
        .positive()
        .max(256 * 1024 * 1024)
        .parse(n);
  }
  private async run(
    argv: string[],
    transfer?: GitCall['transfer'],
    stdin?: Buffer,
    source = false,
  ): Promise<Buffer> {
    const remaining =
      this.deadline === null
        ? 30_000
        : Math.min(30_000, Math.ceil(this.deadline - performance.now()));
    if (remaining <= 0) throw new Error('Git operation deadline exceeded');
    const call: GitCall = {
      cwd: source ? this.repository.root : this.repository.observation.root,
      argv: [
        '--no-optional-locks',
        '--no-replace-objects',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'submodule.recurse=false',
        '-c',
        'fetch.recurseSubmodules=false',
        ...argv,
      ],
      timeoutMs: remaining,
      maxOutputBytes: this.repository.maxOutputBytes,
      environment: { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1' },
      ...(transfer ? { transfer } : {}),
      ...(stdin ? { stdin } : {}),
    };
    const identity = source ? this.repository.active : this.repository.observation;
    await requireHostGitBoundary(
      this.git,
      {
        scope: this.repository.verificationScope ?? 'production',
        hostCallerId: this.repository.hostCallerId,
        boundaryRevision: this.repository.boundaryRevision,
        repositoryId: this.repository.repositoryId,
        root: call.cwd,
        endpoint: this.repository.endpoint,
        resourceIdentity: identity.resourceIdentity,
        configIdentity: identity.configIdentity,
        grantRevision: this.repository.policy.revision,
        mappingDigest: digest(repositoryBinding(this.repository)),
      },
      call,
    );
    const result = await this.git.run(call);
    if (result.length > this.repository.maxOutputBytes) throw new Error('Git output limit');
    return result;
  }
  private gate(
    observation: GitGateObservation | null | undefined,
    expected: {
      gate: GitGateObservation['gate'];
      expectedTip?: string;
      maxBytes?: number;
      ref?: string;
    },
  ): boolean {
    const parsed = z
      .object({
        scope: z.enum(['disposable-local-fixture', 'production']),
        endpoint: z.string(),
        gate: z.enum(['blobless-byte-budget', 'create-only-proposal']),
        evidenceId: z.string().min(1).max(160),
        mechanism: z.string().min(1).max(200),
        expectedTip: oidSchema.optional(),
        maxBytes: z.number().int().positive().optional(),
        ref: z.string().optional(),
      })
      .strict()
      .safeParse(observation);
    if (!parsed.success) return false;
    const value = parsed.data;
    return (
      value.scope === (this.repository.verificationScope ?? 'production') &&
      value.endpoint === this.repository.endpoint &&
      value.gate === expected.gate &&
      value.expectedTip === expected.expectedTip &&
      value.maxBytes === expected.maxBytes &&
      value.ref === expected.ref
    );
  }
  private async authorized(
    action: 'observe' | 'view' | 'proposal',
    request: ObserveRequest | ViewRequest | ProposalRequest,
  ) {
    if (
      request.grantRevision !== this.repository.policy.revision ||
      !(await this.repository.authorize(action, request.grantRevision, structuredClone(request)))
    )
      throw new GroupGitBlocked('Authorization changed or incomplete');
  }
  private async localRef(ref: string): Promise<string | null> {
    const rows = (await this.run(['for-each-ref', '--format=%(objectname) %(refname)', ref]))
      .toString()
      .trim()
      .split('\n');
    const row = rows.find((line) => line.endsWith(` ${ref}`));
    return row ? oidSchema.parse(row.split(' ')[0]) : null;
  }
  private async remoteRef(ref: string, source = false): Promise<string | null> {
    const rows = (
      await this.run(
        ['ls-remote', '--refs', '--', this.repository.endpoint, ref],
        undefined,
        undefined,
        source,
      )
    )
      .toString()
      .trim();
    if (!rows) return null;
    const parsed = rows
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((row) => row[1] === ref);
    if (parsed.length !== 1) throw new Error('Ambiguous remote ref');
    return oidSchema.parse(parsed[0][0]);
  }
  private async ancestor(base: string, head: string): Promise<boolean> {
    // rev-list is used instead of catching every transport failure as "not ancestor".
    if (base === head) return true;
    const descendants = (
      await this.run(['rev-list', '--ancestry-path', '--max-count=1', `${base}..${head}`])
    )
      .toString()
      .trim();
    return descendants.length > 0;
  }
  private event(id: string, type: GitEvent['type'], value: unknown): GitEvent {
    return { id: `git_${id}`, repositoryId: this.repository.repositoryId, type, value };
  }
  private async operation<T>(
    id: string,
    payload: unknown,
    work: (prior: GitOperation) => Promise<T>,
    event: (result: T) => GitEvent | undefined,
  ): Promise<T> {
    idSchema.parse(id);
    return this.journal.exclusive(this.repository.repositoryId, async () => {
      const prior = this.journal.begin({
        id,
        repositoryId: this.repository.repositoryId,
        payloadHash: digest([repositoryBinding(this.repository), payload]),
        state: 'planned',
      });
      if (prior.state === 'verified') return prior.result as T;
      if (prior.state === 'blocked')
        throw new Error('Operation blocked; retained evidence requires a new reviewed decision');
      this.journal.record(id, 'running');
      this.deadline = performance.now() + 60_000;
      try {
        const result = await work(prior);
        this.journal.record(id, 'verified', result, event(result));
        return result;
      } catch (error) {
        // Never claim a timed out external command had no effect. Reconcile same ID on retry.
        const retained = this.journal.begin(prior);
        // A journal acknowledgement may itself be lost after the terminal commit. Never
        // regress that durable verified receipt (which supersedes the intent payload).
        if (retained.state !== 'verified')
          this.journal.record(
            id,
            error instanceof GroupGitBlocked && !effectIntent(retained) ? 'blocked' : 'uncertain',
          );
        throw error;
      } finally {
        this.deadline = null;
      }
    });
  }
  async observe(request: ObserveRequest): Promise<ObserveResult> {
    request = structuredClone(request);
    oidSchema.parse(request.expectedTip);
    if (request.expectedPrevious !== null) oidSchema.parse(request.expectedPrevious);
    refSchema.parse(request.remoteRef);
    const observedRef = Object.hasOwn(this.repository.observedRefs, request.remoteRef)
      ? this.repository.observedRefs[request.remoteRef]
      : undefined;
    if (!observedRef) throw new Error('Ref is not allowlisted');
    await this.authorized('observe', request);
    let changed = false;
    return this.operation(
      request.operationId,
      ['observe', request],
      async (prior) => {
        await this.authorized('observe', request);
        const current = await this.localRef(observedRef);
        changed = current !== request.expectedTip || effectIntent(prior);
        if (current !== request.expectedTip) {
          if (effectIntent(prior))
            throw new Error(
              'Uncertain fetch outcome; inspection has not verified the effect, replay is disabled',
            );
          if (current !== request.expectedPrevious)
            throw new GroupGitBlocked('Observation expectation changed');
          if ((await this.remoteRef(request.remoteRef)) !== request.expectedTip)
            throw new GroupGitBlocked('Remote tip changed');
          const gate = await this.git.observeBloblessGate?.(
            this.repository.endpoint,
            request.expectedTip,
            this.repository.maxTransferBytes,
          );
          if (
            !this.gate(gate, {
              gate: 'blobless-byte-budget',
              expectedTip: request.expectedTip,
              maxBytes: this.repository.maxTransferBytes,
            })
          )
            throw new GroupGitBlocked('Bounded blobless transfer has not been verified');
          this.journal.record(request.operationId, 'running', {
            effectIntent: 'fetch',
            gateObservation: gate,
          });
          await this.authorized('observe', request);
          await this.run(
            [
              'fetch',
              '--atomic',
              '--no-tags',
              '--no-recurse-submodules',
              '--no-write-fetch-head',
              '--no-auto-maintenance',
              '--filter=blob:none',
              '--',
              this.repository.endpoint,
              `+${request.expectedTip}:${observedRef}`,
            ],
            {
              mode: 'blobless',
              maxBytes: this.repository.maxTransferBytes,
              expectedTip: request.expectedTip,
            },
          );
        }
        if ((await this.localRef(observedRef)) !== request.expectedTip)
          throw new Error('Fetch postcondition failed');
        const type = (await this.run(['cat-file', '-t', request.expectedTip])).toString().trim();
        if (type !== 'commit') throw new GroupGitBlocked('Observed tip is not a commit');
        const history = !request.expectedPrevious
          ? 'initial'
          : request.expectedPrevious === request.expectedTip
            ? 'same'
            : (await this.ancestor(request.expectedPrevious, request.expectedTip))
              ? 'advanced'
              : 'rewritten';
        return { oid: request.expectedTip, previousOid: request.expectedPrevious, history };
      },
      (result) =>
        !changed
          ? undefined
          : this.event(request.operationId, 'main-observed', { ref: request.remoteRef, ...result }),
    );
  }
  private async treeFiles(
    oid: string,
    source = false,
  ): Promise<{ path: string; oid: string; mode: string }[]> {
    const bytes = await this.run(
      ['ls-tree', '-r', '-z', '--full-tree', oid],
      undefined,
      undefined,
      source,
    );
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes))
      throw new GroupGitBlocked('Unsupported filename encoding');
    const rows = text.split('\0').filter(Boolean);
    if (rows.length > this.repository.maxFiles) throw new GroupGitBlocked('Tree file limit');
    return rows.map((row) => {
      const tab = row.indexOf('\t');
      const [mode, type, object] = row.slice(0, tab).split(' ');
      const path = row.slice(tab + 1);
      if (tab < 0 || !['blob', 'commit'].includes(type))
        throw new GroupGitBlocked('Unsupported tree entry');
      return { path, oid: oidSchema.parse(object), mode };
    });
  }
  private async approvedFiles(oid: string, request: ViewRequest): Promise<ViewFile[]> {
    const files: ViewFile[] = [];
    let total = 0;
    for (const item of await this.treeFiles(oid)) {
      if (this.repository.policy.visibility(item.path) !== 'content') continue;
      sharedPath(item.path);
      if (item.mode !== '100644' && item.mode !== '100755')
        throw new GroupGitBlocked('Symlink/submodule content requires a separate resource grant');
      let bytes: Buffer;
      // A missing promisor object cannot cause an implicit network read. Adapter reads only
      // this explicitly content-granted blob, enforcing the byte budget BEFORE transfer.
      const present = (
        await this.run(
          ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
          undefined,
          Buffer.from(`${item.oid}\n`),
        )
      )
        .toString()
        .trim();
      const entry = present.startsWith(`${item.oid} blob `) ? present : undefined;
      if (entry) {
        const size = Number(entry.split(' ')[2]);
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > this.repository.maxFileBytes ||
          total + size > this.repository.maxViewBytes
        )
          throw new GroupGitBlocked('Content byte limit');
        bytes = await this.run(['cat-file', 'blob', item.oid]);
      } else {
        if (!this.git.readApprovedBlob)
          throw new GroupGitBlocked('Content unavailable without explicit transfer');
        await this.authorized('view', request);
        bytes = await this.git.readApprovedBlob({
          repositoryId: this.repository.repositoryId,
          endpoint: this.repository.endpoint,
          oid: item.oid,
          path: item.path,
          grantRevision: request.grantRevision,
          timeoutMs: Math.max(
            1,
            Math.min(
              30_000,
              Math.ceil((this.deadline ?? performance.now() + 30_000) - performance.now()),
            ),
          ),
          maxBytes: Math.min(this.repository.maxFileBytes, this.repository.maxViewBytes - total),
        });
      }
      total += bytes.length;
      if (bytes.length > this.repository.maxFileBytes || total > this.repository.maxViewBytes)
        throw new GroupGitBlocked('Content byte limit');
      const gitHash = createHash(item.oid.length === 64 ? 'sha256' : 'sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (gitHash !== item.oid) throw new GroupGitBlocked('Blob identity mismatch');
      if (
        bytes.subarray(0, 200).toString().startsWith('version https://git-lfs.github.com/spec/v1')
      )
        throw new GroupGitBlocked('LFS requires separate explicit resource transfer');
      files.push({ path: item.path, mode: item.mode, bytes });
    }
    return files;
  }
  async materialize(request: ViewRequest): Promise<ViewExpectation> {
    request = structuredClone(request);
    idSchema.parse(request.viewId);
    oidSchema.parse(request.expectedMain);
    z.enum(['main', 'task']).parse(request.kind);
    await this.authorized('view', request);
    const result = await this.operation(
      request.operationId,
      ['view', request],
      async (prior) => {
        await this.authorized('view', request);
        // Recovery adopts an already created view only against the original pinned manifest,
        // even if observed main has since advanced.
        const retained = (prior.result as { expectation?: ViewExpectation } | undefined)
          ?.expectation;
        const existing = await this.views.inspect(request.viewId);
        if (existing) {
          if (!retained || digest(existing) !== digest(retained))
            throw new GroupGitBlocked('Existing view lacks an exact journal expectation');
          return existing;
        }
        if (effectIntent(prior))
          throw new Error('Uncertain copy outcome; no verified view receipt, replay is disabled');
        if (
          (await this.localRef(this.repository.observedRefs[this.repository.mainRef])) !==
          request.expectedMain
        )
          throw new GroupGitBlocked('Main expectation changed');
        const files = await this.approvedFiles(request.expectedMain, request);
        const expected: ViewExpectation = {
          id: request.viewId,
          repositoryId: this.repository.repositoryId,
          baseOid: request.expectedMain,
          manifestDigest: digest(
            [...files]
              .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
              .map((f) => [f.path, f.mode, digest(f.bytes.toString('base64'))]),
          ),
        };
        if (retained && digest(retained) !== digest(expected))
          throw new GroupGitBlocked('View manifest changed');
        this.journal.record(request.operationId, 'running', {
          effectIntent: 'view',
          expectation: expected,
        });
        await this.authorized('view', request);
        await this.views.create(expected, files);
        const actual = await this.views.inspect(request.viewId);
        if (!actual || digest(actual) !== digest(expected))
          throw new Error('View postcondition failed');
        return expected;
      },
      (result) =>
        this.event(
          request.operationId,
          request.kind === 'task' ? 'task-pinned' : 'main-view',
          result,
        ),
    );
    const actual = await this.views.inspect(request.viewId);
    if (!actual || digest(actual) !== digest(result))
      throw new Error('Retained immutable view changed');
    return result;
  }
  async publishProposal(request: ProposalRequest): Promise<{ ref: string; oid: string }> {
    request = structuredClone(request);
    idSchema.parse(request.proposalId);
    oidSchema.parse(request.sourceOid);
    if (request.expectedTarget !== null) oidSchema.parse(request.expectedTarget);
    const ref = `refs/heads/dock-proposals/${this.repository.repositoryId}/${request.proposalId}`;
    if (
      request.review?.approved !== true ||
      request.review.sourceOid !== request.sourceOid ||
      request.review.grantRevision !== request.grantRevision ||
      !request.review.reviewId ||
      !request.historyGrant?.revision ||
      request.historyGrant.sourceOid !== request.sourceOid ||
      request.historyGrant.targetOid !== request.expectedTarget
    )
      throw new Error('Explicit review and content/history authorization required');
    await this.authorized('proposal', request);
    return this.operation(
      request.operationId,
      ['proposal', request],
      async (prior) => {
        await this.authorized('proposal', request);
        // No fake "history safe" proof: inspect every reachable tree, including the target's
        // ancestors. A tracked private blob is still private after deletion from the tip.
        const sourceType = (
          await this.run(
            ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
            undefined,
            Buffer.from(`${request.sourceOid}\n`),
            true,
          )
        )
          .toString()
          .trim()
          .split(' ')[1];
        if (sourceType !== 'commit')
          throw new GroupGitBlocked('Proposal source must be an available commit');
        const commits = (
          await this.run(['rev-list', request.sourceOid], undefined, undefined, true)
        )
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean);
        if (commits.length > this.repository.maxFiles)
          throw new GroupGitBlocked('History scan limit');
        const objects = (
          await this.run(
            ['rev-list', '--objects', '--no-object-names', request.sourceOid],
            undefined,
            undefined,
            true,
          )
        )
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean);
        if (objects.length > this.repository.maxFiles)
          throw new GroupGitBlocked('History object limit');
        const objectInfo = (
          await this.run(
            ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
            undefined,
            Buffer.from(`${objects.map((object) => oidSchema.parse(object)).join('\n')}\n`),
            true,
          )
        )
          .toString()
          .trim()
          .split('\n');
        if (objectInfo.length !== objects.length)
          throw new GroupGitBlocked('History object inventory mismatch');
        const objectSizes = new Map<string, number>();
        let objectBytes = 0;
        for (let index = 0; index < objects.length; index++) {
          const info = objectInfo[index].split(' ');
          if (info[0] !== objects[index])
            throw new GroupGitBlocked('History object identity mismatch');
          if (info[1] === 'missing') throw new GroupGitBlocked('History object unavailable');
          const size = Number(info[2]);
          if (
            !['commit', 'tree', 'blob'].includes(info[1]) ||
            !Number.isSafeInteger(size) ||
            size < 0
          )
            throw new GroupGitBlocked('History byte limit');
          objectSizes.set(info[0], size);
          objectBytes += size + 256; // conservative object framing allowance; transport still enforces wire quota
          if (objectBytes > this.repository.maxTransferBytes)
            throw new GroupGitBlocked('History byte limit');
        }
        const blobs = new Set<string>();
        let bytes = 0;
        let entries = 0;
        for (const commit of commits) {
          for (const file of await this.treeFiles(oidSchema.parse(commit), true)) {
            if (++entries > this.repository.maxFiles)
              throw new GroupGitBlocked('History entry limit');
            sharedPath(file.path);
            if (
              this.repository.policy.visibility(file.path) !== 'content' ||
              !['100644', '100755'].includes(file.mode)
            )
              throw new GroupGitBlocked('History contains ungranted content');
            if (blobs.has(file.oid)) continue;
            blobs.add(file.oid);
            const size = objectSizes.get(file.oid) ?? NaN;
            bytes += size;
            if (
              !Number.isSafeInteger(size) ||
              size < 0 ||
              size > this.repository.maxFileBytes ||
              bytes > this.repository.maxTransferBytes
            )
              throw new GroupGitBlocked('History byte limit');
            const content = await this.run(
              ['cat-file', 'blob', file.oid],
              undefined,
              undefined,
              true,
            );
            if (
              content
                .subarray(0, 200)
                .toString()
                .startsWith('version https://git-lfs.github.com/spec/v1')
            )
              throw new GroupGitBlocked('LFS history requires a separate resource grant');
          }
        }
        const target = await this.remoteRef(ref, true);
        if (target === request.sourceOid && effectIntent(prior)) return { ref, oid: target };
        if (effectIntent(prior) && target !== request.sourceOid)
          throw new Error(
            'Uncertain publication outcome; inspection has not verified the effect, replay is disabled',
          );
        // Each operation owns a NEW unique proposal ref. Ordinary FF is NOT expected-target CAS.
        // Updating existing proposal refs is therefore refused, including expectedTarget != null.
        if (request.expectedTarget !== null || target !== null)
          throw new GroupGitBlocked(
            'Proposal ref already exists; expected-target update is unsupported',
          );
        await this.authorized('proposal', request);
        const gate = await this.git.observeCreateOnlyGate?.(this.repository.endpoint, ref);
        if (!this.gate(gate, { gate: 'create-only-proposal', ref }))
          throw new GroupGitBlocked('Create-only proposal protection has not been verified');
        this.journal.record(request.operationId, 'running', {
          effectIntent: 'proposal',
          gateObservation: gate,
        });
        await this.run(
          [
            'push',
            '--porcelain',
            '--no-verify',
            '--',
            this.repository.endpoint,
            `${request.sourceOid}:${ref}`,
          ],
          { mode: 'proposal', maxBytes: this.repository.maxTransferBytes },
          undefined,
          true,
        );
        if ((await this.remoteRef(ref, true)) !== request.sourceOid)
          throw new Error('Proposal postcondition changed');
        return { ref, oid: request.sourceOid };
      },
      (result) => this.event(request.operationId, 'proposal-published', result),
    );
  }
}
