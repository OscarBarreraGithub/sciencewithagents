import { join } from 'node:path';
import {
  digest,
  GroupGitBlocked,
  repositoryBinding,
  type GitCall,
  type GitGateObservation,
  type GitTransport,
  type GroupRepository,
  type HostGitBoundaryObservation,
  type HostGitBoundaryRequest,
  type ObserveRequest,
  type ViewRequest,
  type ProposalRequest,
} from './group-git.js';
import {
  durableFile,
  verifyResource,
  withGitShadow,
  type PinnedGitResource,
} from './group-git-host-files.js';
import {
  metadataClosure,
  gitObjectManifest,
  storeObjects,
  gitOid,
  gitRef,
  type GitObject,
  type GitObjectEndpoint,
  type ObjectBudget,
} from './group-git-endpoint.js';
import type { HostGitExecutor } from './group-git-executor.js';
import {
  GroupGitSnapshots,
  type SnapshotOptions,
  type SnapshotLedger,
  type CopySnapshot,
} from './group-git-snapshot.js';

const commands = new Set([
  'for-each-ref',
  'ls-remote',
  'cat-file',
  'rev-list',
  'ls-tree',
  'fetch',
  'push',
  'rev-parse',
  'ls-files',
  'status',
]);
function commandArguments(call: GitCall): string[] {
  const argv = [...call.argv];
  while (argv.length && argv[0].startsWith('-')) {
    const flag = argv.shift()!;
    if (flag === '--no-optional-locks' || flag === '--no-replace-objects') continue;
    if (
      flag === '-c' &&
      [
        'core.hooksPath=/dev/null',
        'core.fsmonitor=false',
        'protocol.ext.allow=never',
        'submodule.recurse=false',
        'fetch.recurseSubmodules=false',
        'status.renames=true',
      ].includes(argv.shift() ?? '')
    )
      continue;
    throw new GroupGitBlocked('Unexpected host Git control argument');
  }
  if (!commands.has(argv[0]) || argv.some((value) => /[\x00\r\n]/.test(value)))
    throw new GroupGitBlocked('Unexpected host Git command');
  return argv;
}
/** Production execution adapter. Boundary records describe an executed data-isolation
 * check; run repeats it and consumes an exact-call ticket, never trusts a client record.
 * The connector owns this instance and never exposes run(), registrations or paths. */
export class HostGitTransport implements GitTransport {
  readonly #tickets = new Map<string, HostGitBoundaryRequest>();
  readonly #metadata = new Map<
    string,
    { objects: GitObject[]; evidence: string; maxBytes: number }
  >();
  #snapshotDigest: string | null = null;
  #transferBudget: ObjectBudget | null = null;
  #operation: {
    action: 'observe' | 'view' | 'proposal';
    request: ObserveRequest | ViewRequest | ProposalRequest;
  } | null = null;
  constructor(
    readonly repository: GroupRepository,
    readonly endpoint: GitObjectEndpoint,
    private readonly active: PinnedGitResource,
    private readonly observation: PinnedGitResource,
    private readonly executor: HostGitExecutor,
    private readonly hostRoot: string,
    private readonly maxInputBytes: number,
    private readonly proposalManifestDigest?: string,
  ) {
    if (
      repository.endpoint !== endpoint.identity ||
      active.root !== repository.root ||
      observation.root !== repository.observation.root ||
      active.root === observation.root
    )
      throw new GroupGitBlocked('Git host registration mismatch');
  }
  async operation<T>(
    action: 'observe' | 'view' | 'proposal',
    request: ObserveRequest | ViewRequest | ProposalRequest,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.#operation) throw new GroupGitBlocked('Git host operation already active');
    this.#operation = { action, request: structuredClone(request) };
    this.#transferBudget = {
      remaining: this.repository.maxTransferBytes,
      objects: 0,
      maxObjects: this.repository.maxFiles,
      deadline: Date.now() + 30000,
    };
    try {
      await this.#authorize();
      return await work();
    } finally {
      this.#operation = null;
      this.#transferBudget = null;
      this.#tickets.clear();
      this.#metadata.clear();
    }
  }
  async #authorize(): Promise<void> {
    const operation = this.#operation;
    if (
      !operation ||
      operation.request.grantRevision !== this.repository.policy.revision ||
      !(await this.repository.authorize(
        operation.action,
        operation.request.grantRevision,
        structuredClone(operation.request),
      ))
    )
      throw new GroupGitBlocked(
        'Current host membership/resource/grant/executor authorization required',
      );
  }
  async observeHostGitBoundary(
    request: HostGitBoundaryRequest,
  ): Promise<HostGitBoundaryObservation | null> {
    await this.#authorize();
    const resource =
      request.root === this.active.root
        ? this.active
        : request.root === this.observation.root
          ? this.observation
          : null;
    const configured =
      request.root === this.active.root ? this.repository.active : this.repository.observation;
    if (
      !resource ||
      request.scope !== 'production' ||
      request.hostCallerId !== this.repository.hostCallerId ||
      request.boundaryRevision !== this.repository.boundaryRevision ||
      request.repositoryId !== this.repository.repositoryId ||
      request.endpoint !== this.repository.endpoint ||
      request.resourceIdentity !== configured.resourceIdentity ||
      request.configIdentity !== configured.configIdentity ||
      request.grantRevision !== this.repository.policy.revision ||
      (request.mappingDigest !== this.bindingDigest() &&
        request.mappingDigest !== this.#snapshotDigest)
    )
      return null;
    await verifyResource(resource);
    this.#tickets.set(request.callDigest, structuredClone(request));
    return {
      ...request,
      evidenceId: digest([resource.rootIdentity, resource.gitIdentity, request.callDigest]),
      mechanism:
        'canonical pinned resource; config-free bounded data shadow; sanitized builtin executor',
    };
  }
  async #transfer<T>(maxBytes: number, work: (budget: ObjectBudget) => Promise<T>): Promise<T> {
    if (!this.#transferBudget) throw new GroupGitBlocked('No active transfer budget');
    const parent = this.#transferBudget;
    const initial = Math.min(maxBytes, parent.remaining);
    const child = { ...parent, remaining: initial };
    try {
      return await work(child);
    } finally {
      parent.remaining -= initial - child.remaining;
      parent.objects = child.objects;
    }
  }
  async ref(name: string): Promise<string | null> {
    await this.#authorize();
    return this.#transfer(Math.min(this.repository.maxTransferBytes, 256 * 1024), (budget) =>
      this.endpoint.ref(name, budget),
    );
  }
  async activeHead(): Promise<string> {
    return gitOid.parse(
      (await this.#metadataRun(this.active, ['rev-parse', '--verify', 'HEAD'], undefined, 1024))
        .toString()
        .trim(),
    );
  }
  async capture(options: SnapshotOptions, ledger: SnapshotLedger): Promise<CopySnapshot> {
    if (
      this.#snapshotDigest ||
      options.root !== this.active.root ||
      options.repositoryId !== this.repository.repositoryId ||
      options.policy.revision !== this.repository.policy.revision
    )
      throw new GroupGitBlocked('Snapshot host mapping mismatch');
    this.#snapshotDigest = digest([
      options.hostGit,
      options.repositoryId,
      options.copyId,
      options.epoch,
      options.root,
      options.baseOid,
      options.observedMainOid,
      options.policy.revision,
      options.maxFiles,
      options.maxFileBytes,
      options.maxTotalBytes,
      options.maxOutputBytes,
    ]);
    try {
      return await new GroupGitSnapshots(this, ledger).capture(options);
    } finally {
      this.#snapshotDigest = null;
    }
  }
  async observeBloblessGate(
    endpoint: string,
    expectedTip: string,
    maxBytes: number,
  ): Promise<GitGateObservation | null> {
    await this.#authorize();
    if (endpoint !== this.endpoint.identity || maxBytes !== this.repository.maxTransferBytes)
      return null;
    const mechanism = await this.endpoint.observationMechanism();
    if (!mechanism)
      throw new GroupGitBlocked(
        'HTTPS observation requires verified transport wire-byte enforcement; configured object reader only proves response-body bounds',
      );
    const objects = await this.#transfer(maxBytes, (budget) =>
      metadataClosure(this.endpoint, expectedTip, budget),
    );
    const evidence = digest(objects.map((value) => [value.oid, value.type, value.bytes.length]));
    this.#metadata.set(expectedTip, { objects, evidence, maxBytes });
    return {
      scope: 'production',
      endpoint,
      gate: 'blobless-byte-budget',
      expectedTip,
      maxBytes,
      evidenceId: evidence,
      mechanism,
    };
  }
  async observeCreateOnlyGate(endpoint: string, ref: string): Promise<GitGateObservation | null> {
    await this.#authorize();
    if (endpoint !== this.endpoint.identity) return null;
    if (this.proposalManifestDigest)
      await this.#exportObjects(
        (this.#operation?.request as ProposalRequest).sourceOid,
        this.repository.maxTransferBytes,
      );
    const mechanism = await this.#transfer(this.repository.maxTransferBytes, (budget) =>
      this.endpoint.createOnlyMechanism(ref, budget),
    );
    if (!mechanism) return null;
    return {
      scope: 'production',
      endpoint,
      gate: 'create-only-proposal',
      ref,
      evidenceId: digest([endpoint, ref, mechanism]),
      mechanism,
    };
  }
  async readApprovedBlob(
    request: Parameters<NonNullable<GitTransport['readApprovedBlob']>>[0],
  ): Promise<Buffer> {
    await this.#authorize();
    const operation = this.#operation;
    if (
      operation?.action !== 'view' ||
      request.repositoryId !== this.repository.repositoryId ||
      request.endpoint !== this.endpoint.identity ||
      request.grantRevision !== this.repository.policy.revision ||
      this.repository.policy.visibility(request.path) !== 'content'
    )
      throw new GroupGitBlocked('Blob resource/content grant denied');
    // Verify the requested path/OID in the pinned main version, not merely an OID in an
    // unrelated history. The core also hashes every returned blob and rejects LFS content.
    const expected = (operation.request as ViewRequest).expectedMain;
    const rows = (
      await this.#metadataRun(
        this.observation,
        ['ls-tree', '-r', '-z', '--full-tree', expected],
        undefined,
        this.repository.maxOutputBytes,
      )
    )
      .toString()
      .split('\0');
    if (
      !rows.some(
        (row) =>
          row === `100644 blob ${request.oid}\t${request.path}` ||
          row === `100755 blob ${request.oid}\t${request.path}`,
      )
    )
      throw new GroupGitBlocked('Blob path/version identity denied');
    await this.#authorize();
    await verifyResource(this.observation);
    const object = await this.#transfer(
      Math.min(this.repository.maxTransferBytes, 128 * 1024 + 2 * request.maxBytes),
      (budget) => {
        budget.maxObjectBytes = request.maxBytes;
        return this.endpoint.object(request.oid, budget, 'blob');
      },
    );
    if (object.type !== 'blob' || object.bytes.length > request.maxBytes)
      throw new GroupGitBlocked('Blob transfer/type limit');
    return object.bytes;
  }
  async #metadataRun(
    resource: PinnedGitResource,
    argv: string[],
    stdin: Buffer | undefined,
    maxBytes: number,
    timeout = 30000,
  ): Promise<Buffer> {
    await this.#authorize();
    return withGitShadow(resource, this.hostRoot, this.maxInputBytes, async (shadow) => {
      await this.#authorize();
      return this.executor.run(
        this.repository.repositoryId,
        shadow,
        [
          '--no-optional-locks',
          '--no-replace-objects',
          `--git-dir=${shadow}`,
          ...(resource.bare ? [] : [`--work-tree=${resource.root}`, '-c', 'core.bare=false']),
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.attributesFile=/dev/null',
          '-c',
          'diff.external=',
          '-c',
          'core.pager=',
          '-c',
          'status.renames=true',
          ...argv,
        ],
        stdin,
        timeout,
        maxBytes,
      );
    });
  }
  async run(call: GitCall): Promise<Buffer> {
    await this.#authorize();
    const key = digest(call);
    const ticket = this.#tickets.get(key);
    this.#tickets.delete(key);
    if (!ticket || ticket.root !== call.cwd)
      throw new GroupGitBlocked('Host Git call has no exact boundary ticket');
    const resource =
      call.cwd === this.active.root
        ? this.active
        : call.cwd === this.observation.root
          ? this.observation
          : null;
    if (!resource) throw new GroupGitBlocked('Unregistered Git resource');
    await verifyResource(resource);
    const argv = commandArguments(call);
    const command = argv[0];
    if (command === 'ls-remote') {
      if (
        argv.length !== 5 ||
        argv[1] !== '--refs' ||
        argv[2] !== '--' ||
        argv[3] !== this.endpoint.identity
      )
        throw new GroupGitBlocked('Remote ref scope mismatch');
      const ref = gitRef.parse(argv[4]);
      const oid = await this.ref(ref);
      return Buffer.from(oid ? `${oid}\t${ref}\n` : '');
    }
    if (command === 'fetch') {
      if (
        resource !== this.observation ||
        call.transfer?.mode !== 'blobless' ||
        argv.length !== 10 ||
        argv.slice(1, 8).join(' ') !==
          '--atomic --no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance --filter=blob:none --' ||
        argv[8] !== this.endpoint.identity
      )
        throw new GroupGitBlocked('Fetch scope mismatch');
      const [source, target] = argv[9].split(':');
      const tip = gitOid.parse(source.slice(1));
      gitRef.parse(target);
      const cached = this.#metadata.get(tip);
      if (
        !cached ||
        cached.maxBytes !== call.transfer.maxBytes ||
        tip !== call.transfer.expectedTip ||
        !Object.values(this.repository.observedRefs).includes(target)
      )
        throw new GroupGitBlocked('Fetch lacks exact verified metadata budget');
      // Authorization is repeated after verifier/object reads and immediately before mutation.
      await this.#authorize();
      await verifyResource(this.observation);
      await storeObjects(this.observation.root, cached.objects, () => this.#authorize());
      await this.#authorize();
      await durableFile(join(this.observation.root, target), `${tip}\n`);
      return Buffer.alloc(0);
    }
    if (command === 'push') {
      if (
        resource !== this.active ||
        call.transfer?.mode !== 'proposal' ||
        argv.length !== 6 ||
        argv.slice(1, 4).join(' ') !== '--porcelain --no-verify --' ||
        argv[4] !== this.endpoint.identity
      )
        throw new GroupGitBlocked('Proposal scope mismatch');
      const [oid, ref] = argv[5].split(':');
      gitOid.parse(oid);
      gitRef.parse(ref);
      const proposal = this.#operation?.request as ProposalRequest;
      if (
        this.#operation?.action !== 'proposal' ||
        proposal.sourceOid !== oid ||
        ref !== `refs/heads/dock-proposals/${this.repository.repositoryId}/${proposal.proposalId}`
      )
        throw new GroupGitBlocked('Proposal request mismatch');
      const objects = await this.#exportObjects(oid, call.transfer.maxBytes);
      await this.#authorize();
      await this.#transfer(call.transfer.maxBytes, (budget) =>
        this.endpoint.create(ref, oid, objects, budget),
      );
      return Buffer.from('Created proposal\n');
    }
    if (call.transfer) throw new GroupGitBlocked('Unexpected transfer mode');
    // Core emits only these fixed builtin forms. Forbid controls capable of selecting
    // another repository, helpers, textconv, external diff, pathspec files or object replacements.
    if (
      argv
        .slice(1)
        .some(
          (value) =>
            value === '-c' ||
            /^(?:--(?:git-dir|work-tree|exec-path|config|textconv|filters|pathspec-from-file)|-C)/.test(
              value,
            ),
        )
    )
      throw new GroupGitBlocked('Unsafe metadata argument');
    return this.#metadataRun(resource, argv, call.stdin, call.maxOutputBytes, call.timeoutMs);
  }
  async #exportObjects(sourceOid: string, maxBytes: number): Promise<GitObject[]> {
    const inventory = await this.#metadataRun(
      this.active,
      ['rev-list', '--objects', '--no-object-names', sourceOid],
      undefined,
      this.repository.maxOutputBytes,
    );
    const objects: GitObject[] = [];
    const sourceEndpoint = new (await import('./group-git-endpoint.js')).LocalGitObjectEndpoint(
      'source',
      this.active,
      this.executor,
      this.repository.repositoryId,
      this.hostRoot,
      this.maxInputBytes,
      'read-only',
      () => this.#authorize(),
    );
    const budget: ObjectBudget = {
      remaining: maxBytes,
      objects: 0,
      maxObjects: this.repository.maxFiles,
      deadline: Date.now() + 30000,
    };
    for (const id of inventory.toString().trim().split('\n').filter(Boolean))
      objects.push(await sourceEndpoint.object(id, budget));
    if (this.proposalManifestDigest && gitObjectManifest(objects) !== this.proposalManifestDigest)
      throw new GroupGitBlocked('Native exported object closure manifest mismatch');
    return objects;
  }
  bindingDigest(): string {
    return digest(repositoryBinding(this.repository));
  }
}
