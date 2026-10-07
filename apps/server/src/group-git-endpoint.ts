import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { mkdir, open, link, rm } from 'node:fs/promises';
import { z } from 'zod';
import { digest, GroupGitBlocked, sharedPath } from './group-git.js';
import {
  withGitShadow,
  verifyResource,
  durableFile,
  type PinnedGitResource,
} from './group-git-host-files.js';
import type { HostGitExecutor } from './group-git-executor.js';

export const gitOid = z.string().regex(/^[a-f0-9]{40}$/);
export const gitRef = z
  .string()
  .regex(/^refs\/(?:heads|dock-observed)\/[a-zA-Z0-9_/-]+$/)
  .refine(
    (value) =>
      !value.includes('//') &&
      value.split('/').every((v) => v && v !== '.' && v !== '..') &&
      value.length <= 240,
  );
export interface ObjectBudget {
  remaining: number;
  objects: number;
  maxObjects: number;
  deadline: number;
  maxObjectBytes?: number;
}
export interface GitObject {
  oid: string;
  type: 'commit' | 'tree' | 'blob';
  bytes: Buffer;
}
export interface GitObjectEndpoint {
  readonly identity: string;
  /** Object/body metering alone cannot certify network wire accounting. */
  observationMechanism(): Promise<string | null>;
  ref(name: string, budget: ObjectBudget): Promise<string | null>;
  object(oid: string, budget: ObjectBudget, expectedType?: GitObject['type']): Promise<GitObject>;
  /** Null means no independently enforced atomic create-only endpoint guarantee. */
  createOnlyMechanism(ref: string, budget: ObjectBudget): Promise<string | null>;
  create(
    ref: string,
    oid: string,
    objects: readonly GitObject[],
    budget: ObjectBudget,
  ): Promise<void>;
}
export function objectFrame(object: GitObject): Buffer {
  return Buffer.concat([Buffer.from(`${object.type} ${object.bytes.length}\0`), object.bytes]);
}
export function gitObjectManifest(objects: readonly GitObject[]): string {
  return digest(
    [...objects]
      .sort((a, b) => a.oid.localeCompare(b.oid))
      .map((o) => [
        o.oid,
        o.type,
        o.bytes.length,
        createHash('sha256').update(objectFrame(o)).digest('hex'),
      ]),
  );
}
export function verifyGitObject(object: GitObject): void {
  gitOid.parse(object.oid);
  if (createHash('sha1').update(objectFrame(object)).digest('hex') !== object.oid)
    throw new GroupGitBlocked('Endpoint object hash mismatch');
}
export function charge(budget: ObjectBudget, bytes: number, object = false): void {
  if (
    Date.now() > budget.deadline ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > budget.remaining ||
    (object && ++budget.objects > budget.maxObjects)
  )
    throw new GroupGitBlocked('Endpoint transfer/object/deadline limit');
  budget.remaining -= bytes;
}
/** The exact immutable metadata closure is traversed and hash-verified before transfer.
 * Tree names are parsed as data; blobs are not read while observing. SHA-256 is refused. */
export async function metadataClosure(
  endpoint: GitObjectEndpoint,
  tip: string,
  budget: ObjectBudget,
): Promise<GitObject[]> {
  const queue = [gitOid.parse(tip)];
  const seen = new Set<string>();
  const result: GitObject[] = [];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > budget.maxObjects) throw new GroupGitBlocked('Endpoint metadata object limit');
    const object = await endpoint.object(oid, budget);
    verifyGitObject(object);
    if (!['commit', 'tree'].includes(object.type))
      throw new GroupGitBlocked('Blobless metadata closure contains a blob');
    result.push(object);
    if (object.type === 'commit') {
      const header = object.bytes
        .subarray(0, object.bytes.indexOf(Buffer.from('\n\n')))
        .toString('utf8');
      const trees = header.split('\n').filter((line) => line.startsWith('tree '));
      if (trees.length !== 1) throw new GroupGitBlocked('Malformed commit metadata');
      queue.push(gitOid.parse(trees[0].slice(5)));
      for (const line of header.split('\n'))
        if (line.startsWith('parent ')) queue.push(gitOid.parse(line.slice(7)));
    } else {
      let offset = 0;
      let entries = 0;
      while (offset < object.bytes.length) {
        const space = object.bytes.indexOf(32, offset);
        const nul = object.bytes.indexOf(0, space + 1);
        if (
          space < offset ||
          nul < space ||
          nul + 21 > object.bytes.length ||
          ++entries > budget.maxObjects
        )
          throw new GroupGitBlocked('Malformed/oversized tree metadata');
        const mode = object.bytes.subarray(offset, space).toString();
        const name = object.bytes.subarray(space + 1, nul);
        if (!Buffer.from(name.toString('utf8')).equals(name))
          throw new GroupGitBlocked('Unsupported tree name encoding');
        sharedPath(name.toString('utf8'));
        const child = object.bytes.subarray(nul + 1, nul + 21).toString('hex');
        if (mode === '40000' || mode === '040000') queue.push(child);
        else if (!['100644', '100755', '120000', '160000'].includes(mode))
          throw new GroupGitBlocked('Unsupported tree mode');
        offset = nul + 21;
      }
    }
  }
  return result;
}
export async function storeObjects(
  root: string,
  objects: readonly GitObject[],
  revalidate: () => Promise<void> = async () => {},
): Promise<void> {
  for (const object of objects) {
    await revalidate();
    verifyGitObject(object);
    await durableFile(
      join(root, 'objects', object.oid.slice(0, 2), object.oid.slice(2)),
      deflateSync(objectFrame(object)),
    );
  }
}

/** Configured local resource endpoint. The host owns the bare resource and all proposal
 * writers must use this endpoint. Atomic link(2) enforces create-only even under races;
 * no receive hook, upload-pack, agent configuration or native network process executes. */
export class LocalGitObjectEndpoint implements GitObjectEndpoint {
  constructor(
    readonly identity: string,
    private readonly resource: PinnedGitResource,
    private readonly executor: HostGitExecutor,
    private readonly repositoryId: string,
    private readonly hostRoot: string,
    private readonly maxInputBytes: number,
    private readonly proposalOwnership: 'host-exclusive' | 'read-only' = 'read-only',
    private readonly revalidate: () => Promise<void> = async () => {},
  ) {}
  async observationMechanism(): Promise<string> {
    await this.revalidate();
    await verifyResource(this.resource);
    return 'local explicit object frames; no network transfer; bounded hash-verified metadata closure';
  }
  async #run(argv: string[], maxBytes: number): Promise<Buffer> {
    await this.revalidate();
    return withGitShadow(this.resource, this.hostRoot, this.maxInputBytes, async (shadow) => {
      await this.revalidate();
      return this.executor.run(
        this.repositoryId,
        shadow,
        ['--no-replace-objects', `--git-dir=${shadow}`, ...argv],
        undefined,
        30000,
        maxBytes,
      );
    });
  }
  async ref(name: string, budget: ObjectBudget): Promise<string | null> {
    await this.revalidate();
    gitRef.parse(name);
    await verifyResource(this.resource);
    const rows = (
      await this.#run(
        ['for-each-ref', '--format=%(objectname) %(refname)', name],
        Math.min(budget.remaining, 65536),
      )
    )
      .toString()
      .trim()
      .split('\n');
    const found = rows.find((line) => line.endsWith(` ${name}`));
    const oid = found ? gitOid.parse(found.split(' ')[0]) : null;
    charge(budget, Buffer.byteLength(oid ?? ''));
    return oid;
  }
  async object(oid: string, budget: ObjectBudget): Promise<GitObject> {
    await this.revalidate();
    gitOid.parse(oid);
    // Batch the size/type inspection in one safe Git process, before allocating/reading bytes.
    const info = await withGitShadow(
      this.resource,
      this.hostRoot,
      this.maxInputBytes,
      async (shadow) => {
        await this.revalidate();
        return this.executor.run(
          this.repositoryId,
          shadow,
          [
            '--no-replace-objects',
            `--git-dir=${shadow}`,
            'cat-file',
            '--batch-check=%(objectname) %(objecttype) %(objectsize)',
          ],
          Buffer.from(`${oid}\n`),
          30000,
          4096,
        );
      },
    );
    const fields = info.toString().trim().split(' ');
    const type = z.enum(['commit', 'tree', 'blob']).parse(fields[1]);
    const size = Number(fields[2]);
    if (budget.maxObjectBytes !== undefined && size > budget.maxObjectBytes)
      throw new GroupGitBlocked('Selected object size limit');
    charge(budget, size + Buffer.byteLength(`${type} ${size}\0`), true);
    const bytes = await this.#run(['cat-file', type, oid], size + 1);
    charge(budget, 0);
    if (bytes.length !== size) throw new GroupGitBlocked('Endpoint object size changed');
    const object = { oid, type, bytes };
    verifyGitObject(object);
    return object;
  }
  async createOnlyMechanism(ref: string): Promise<string | null> {
    await this.revalidate();
    gitRef.parse(ref);
    await verifyResource(this.resource);
    return this.resource.bare &&
      this.proposalOwnership === 'host-exclusive' &&
      ref.startsWith(`refs/heads/dock-proposals/${this.repositoryId}/`)
      ? 'host-exclusive local bare resource, atomic no-replace link(2)'
      : null;
  }
  async create(
    ref: string,
    oid: string,
    objects: readonly GitObject[],
    budget: ObjectBudget,
  ): Promise<void> {
    await this.revalidate();
    if (!(await this.createOnlyMechanism(ref)))
      throw new GroupGitBlocked('Endpoint cannot enforce atomic create-only proposals');
    gitOid.parse(oid);
    for (const object of objects) charge(budget, objectFrame(object).length, true);
    await storeObjects(this.resource.gitDirectory, objects, this.revalidate);
    await verifyResource(this.resource);
    await this.revalidate();
    const target = join(this.resource.gitDirectory, ref);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Existing directories must stay canonical; no overwrite or symlink following.
    const { realpath } = await import('node:fs/promises');
    if ((await realpath(dirname(target))) !== dirname(target))
      throw new GroupGitBlocked('Endpoint ref path changed');
    const temporary = join(this.resource.gitDirectory, `.proposal-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${oid}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.revalidate();
      await link(temporary, target);
      const parent = await open(dirname(target), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Real configured HTTPS read transport for the bounded immutable-object protocol.
 * Exact origin/path, TLS validation, no redirects, no cookies, no native Git credential
 * helpers. This is not GitHub smart HTTP. Server proposal CAS is deliberately unsupported
 * until its authenticated deployed atomic create-only guarantee can be independently verified. */
export class HttpsGitObjectEndpoint implements GitObjectEndpoint {
  readonly #base: URL;
  constructor(
    readonly identity: string,
    baseUrl: string,
    private readonly credential: () => Promise<string>,
    private readonly revalidate: () => Promise<void> = async () => {},
  ) {
    this.#base = new URL(baseUrl);
    if (
      this.#base.protocol !== 'https:' ||
      this.#base.username ||
      this.#base.password ||
      this.#base.search ||
      this.#base.hash ||
      !this.#base.pathname.endsWith('/group-git/v1/')
    )
      throw new GroupGitBlocked(
        'HTTPS endpoint requires an exact /group-git/v1/ object-protocol URL; native GitHub smart HTTP is unsupported',
      );
  }
  async #get(relative: string, budget: ObjectBudget): Promise<Buffer> {
    await this.revalidate();
    const url = new URL(relative, this.#base);
    if (url.origin !== this.#base.origin || !url.pathname.startsWith(this.#base.pathname))
      throw new GroupGitBlocked('Endpoint origin/path changed');
    const credential = await this.credential();
    if (!credential || /[\r\n]/.test(credential))
      throw new GroupGitBlocked('Endpoint credential unavailable');
    return new Promise<Buffer>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          maxHeaderSize: 8192,
          headers: { Authorization: `Bearer ${credential}`, 'Accept-Encoding': 'identity' },
          timeout: Math.max(1, Math.min(30000, budget.deadline - Date.now())),
        },
        (res) => {
          if (
            res.statusCode !== 200 ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
          ) {
            res.destroy();
            reject(new Error('Endpoint unavailable or unsupported response; redirect refused'));
            return;
          }
          const length = Number(res.headers['content-length']);
          if (Number.isFinite(length) && length > budget.remaining) {
            res.destroy();
            reject(new GroupGitBlocked('Endpoint transfer limit'));
            return;
          }
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => {
            try {
              charge(budget, part.length);
              parts.push(part);
            } catch (error) {
              res.destroy();
              reject(error);
            }
          });
          res.on('error', () => reject(new Error('Endpoint response interrupted')));
          res.on('end', () => resolve(Buffer.concat(parts)));
        },
      );
      req.on('timeout', () => req.destroy(new Error('Endpoint deadline')));
      req.on('error', () =>
        reject(new Error('Endpoint offline or TLS/authentication unavailable')),
      );
      req.end();
    });
  }
  async ref(name: string, budget: ObjectBudget): Promise<string | null> {
    gitRef.parse(name);
    const response = await this.#get(`refs?name=${encodeURIComponent(name)}`, budget);
    return z.object({ oid: gitOid.nullable() }).strict().parse(JSON.parse(response.toString())).oid;
  }
  async object(oid: string, budget: ObjectBudget): Promise<GitObject> {
    gitOid.parse(oid);
    if (++budget.objects > budget.maxObjects) throw new GroupGitBlocked('Endpoint object limit');
    const bytes = await this.#get(`objects/${oid}`, budget);
    const nul = bytes.indexOf(0);
    if (nul < 0 || nul > 80) throw new GroupGitBlocked('Malformed endpoint object');
    const [kind, size] = bytes.subarray(0, nul).toString().split(' ');
    const type = z.enum(['commit', 'tree', 'blob']).parse(kind);
    const object = { oid, type, bytes: bytes.subarray(nul + 1) };
    if (Number(size) !== object.bytes.length)
      throw new GroupGitBlocked('Endpoint object size mismatch');
    verifyGitObject(object);
    return object;
  }
  async createOnlyMechanism(): Promise<null> {
    return null;
  }
  async observationMechanism(): Promise<null> {
    return null;
  }
  async create(): Promise<never> {
    throw new GroupGitBlocked(
      'HTTPS proposal publication requires independently verified deployed atomic create-only enforcement; unavailable',
    );
  }
}
