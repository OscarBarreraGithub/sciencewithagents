import { Agent, request } from 'node:https';
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Duplex } from 'node:stream';
import { z } from 'zod';
import { GroupGitBlocked } from './group-git.js';
import {
  charge,
  gitOid,
  gitRef,
  verifyGitObject,
  type GitObject,
  type GitObjectEndpoint,
  type ObjectBudget,
} from './group-git-endpoint.js';
import { packet, packets, pack, unpack } from './group-git-pack.js';

export const githubBindingSchema = z.strictObject({
  accountId: z.string().regex(/^\d+$/),
  repositoryNodeId: z.string().min(1).max(256),
  repositoryNumericId: z.string().regex(/^\d+$/),
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
});
export type GitHubBinding = z.infer<typeof githubBindingSchema>;
export interface GitHubIdentity {
  /** Existing native identity, resolved inside protected host code for every request. Never persisted. */
  resolve(): Promise<{ token: string; accountId: string }>;
}
export function githubRepository(url: string): { fullName: string; url: string } {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(parsed.pathname)
  )
    throw new GroupGitBlocked('Ordinary canonical github.com owner/repo.git HTTPS URL required');
  const fullName = parsed.pathname.slice(1, -4);
  if (fullName.split('/').some((p) => p === '.' || p === '..'))
    throw new GroupGitBlocked('Invalid GitHub repository');
  return { fullName, url: `https://github.com/${fullName}.git` };
}
export interface GitHubWireRequest {
  url: URL;
  method: 'GET' | 'POST';
  authorization: string;
  contentType?: string;
  body?: Buffer;
  accept: string;
}
export type GitHubWire = (
  input: GitHubWireRequest,
  budget: ObjectBudget,
) => Promise<{ status: number; body: Buffer; contentType: string }>;
/** Ciphertext accounting at the raw TCP stream, including TLS handshake, HTTP headers,
 * transfer framing, request and response. TCP/IP link headers are outside this quota.
 * The optional dial/CA port is protected-host dependency injection for disposable TLS tests;
 * repository URLs and TLS server identity stay fixed, and production uses ordinary DNS/TLS. */
export function createGitHubWire(
  options: { dial?: (host: string) => Socket; ca?: string } = {},
): GitHubWire {
  return async (input, budget) => {
    if (
      !['github.com', 'api.github.com'].includes(input.url.hostname) ||
      input.url.protocol !== 'https:' ||
      input.url.port ||
      input.url.username ||
      input.url.password
    )
      throw new GroupGitBlocked('GitHub wire origin denied');
    charge(budget, 0);
    const agent = new Agent({ keepAlive: false });
    const raw =
      options.dial?.(input.url.hostname) ?? tcpConnect({ host: input.url.hostname, port: 443 });
    const bridge = new Duplex({
      read() {
        raw.resume();
      },
      write(chunk: Buffer, _encoding, callback) {
        try {
          charge(budget, chunk.length);
          raw.write(chunk, callback);
        } catch (error) {
          callback(error as Error);
        }
      },
      destroy(error, callback) {
        raw.destroy();
        callback(error);
      },
    });
    raw.on('data', (chunk: Buffer) => {
      try {
        charge(budget, chunk.length);
        if (!bridge.push(chunk)) raw.pause();
      } catch (error) {
        bridge.destroy(error as Error);
      }
    });
    raw.on('end', () => bridge.push(null));
    raw.on('error', (error) => bridge.destroy(error));
    raw.on('close', () => {
      if (!bridge.readableEnded) bridge.destroy(new Error('GitHub stream closed'));
    });
    const tls = tlsConnect({
      socket: bridge,
      servername: input.url.hostname,
      rejectUnauthorized: true,
      ca: options.ca,
    });
    agent.createConnection = () => tls;
    return new Promise((resolve, reject) => {
      const stop = () => {
        agent.destroy();
        tls.destroy();
        bridge.destroy();
        raw.destroy();
      };
      const timer = setTimeout(
        () => {
          stop();
          reject(new GroupGitBlocked('GitHub transfer deadline'));
        },
        Math.max(1, Math.min(30000, budget.deadline - Date.now())),
      );
      const req = request(
        input.url,
        {
          agent,
          method: input.method,
          maxHeaderSize: 8192,
          headers: {
            Authorization: input.authorization,
            Accept: input.accept,
            'Accept-Encoding': 'identity',
            'User-Agent': 'sciencewithagents-group-git',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(input.contentType ? { 'Content-Type': input.contentType } : {}),
            ...(input.body ? { 'Content-Length': String(input.body.length) } : {}),
          },
        },
        (res) => {
          if (
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') ||
            (res.statusCode! >= 300 && res.statusCode! < 400)
          ) {
            clearTimeout(timer);
            stop();
            reject(new GroupGitBlocked('GitHub redirects or encoding refused'));
            return;
          }
          let size = 0;
          const parts: Buffer[] = [];
          res.on('data', (part: Buffer) => {
            size += part.length;
            if (size > 64 * 1024 * 1024) {
              res.destroy(new GroupGitBlocked('GitHub response limit'));
              return;
            }
            parts.push(part);
          });
          res.on('error', () => {
            clearTimeout(timer);
            stop();
            reject(new Error('GitHub response interrupted'));
          });
          res.on('end', () => {
            clearTimeout(timer);
            stop();
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(parts),
              contentType: String(res.headers['content-type'] ?? '').split(';')[0],
            });
          });
        },
      );
      req.on('error', () => {
        clearTimeout(timer);
        stop();
        reject(new Error('GitHub network/auth/TLS unavailable'));
      });
      req.end(input.body);
    });
  };
}
const defaults = createGitHubWire();
const zero = '0'.repeat(40);
interface Advertisement {
  refs: Map<string, string>;
  capabilities: Set<string>;
}
function advertisement(bytes: Buffer, service: string): Advertisement {
  const rows = packets(bytes);
  if (rows[0]?.toString() !== `# service=${service}\n` || rows[1] !== null || rows.at(-1) !== null)
    throw new GroupGitBlocked('GitHub smart service advertisement required');
  const refs = new Map<string, string>();
  let capabilities = new Set<string>();
  for (const [index, row] of rows.slice(2, -1).entries()) {
    if (!row) throw new GroupGitBlocked('Malformed GitHub advertisement');
    const [entry, caps] = row.toString().trimEnd().split('\0');
    if (index === 0) capabilities = new Set((caps ?? '').split(' '));
    else if (caps) throw new GroupGitBlocked('Malformed GitHub capabilities');
    const space = entry.indexOf(' ');
    const oid = gitOid.parse(entry.slice(0, space));
    const ref = entry.slice(space + 1);
    if (!ref || refs.has(ref)) throw new GroupGitBlocked('Malformed/duplicate GitHub ref');
    if (oid !== zero) refs.set(ref, oid);
  }
  return { refs, capabilities };
}
/** Actual GitHub-supported smart HTTP v0/v1. No custom object server. Original commit
 * headers/signatures survive because raw Git packs, not normalized REST commit JSON, are used. */
export class GitHubGitEndpoint implements GitObjectEndpoint {
  readonly #repo: ReturnType<typeof githubRepository>;
  readonly #objects = new Map<string, GitObject>();
  readonly #types = new Map<string, GitObject['type']>();
  #create: { ref: string } | null = null;
  constructor(
    readonly identity: string,
    url: string,
    readonly binding: GitHubBinding,
    private readonly nativeIdentity: GitHubIdentity,
    private readonly revalidate: () => Promise<void>,
    private readonly wire: GitHubWire = defaults,
  ) {
    this.#repo = githubRepository(url);
    githubBindingSchema.parse(binding);
    if (binding.fullName.toLowerCase() !== this.#repo.fullName.toLowerCase())
      throw new GroupGitBlocked('GitHub repository binding mismatch');
  }
  async #credentials(budget: ObjectBudget): Promise<string> {
    await this.revalidate();
    const native = await this.nativeIdentity.resolve();
    if (
      native.accountId !== this.binding.accountId ||
      !native.token ||
      /[\r\n\0]/.test(native.token)
    )
      throw new GroupGitBlocked('GitHub native account binding denied');
    const get = async (path: string) => {
      const response = await this.wire(
        {
          url: new URL(`https://api.github.com${path}`),
          method: 'GET',
          authorization: `Bearer ${native.token}`,
          accept: 'application/vnd.github+json',
        },
        budget,
      );
      if (response.status !== 200)
        throw new GroupGitBlocked('GitHub identity/repository unavailable');
      try {
        return JSON.parse(response.body.toString());
      } catch {
        throw new GroupGitBlocked('GitHub identity metadata invalid');
      }
    };
    const user = z.object({ id: z.number().int().positive().safe() }).parse(await get('/user'));
    const repo = z
      .object({
        id: z.number().int().positive().safe(),
        node_id: z.string(),
        full_name: z.string(),
      })
      .parse(await get(`/repos/${this.#repo.fullName}`));
    if (
      String(user.id) !== this.binding.accountId ||
      String(repo.id) !== this.binding.repositoryNumericId ||
      repo.node_id !== this.binding.repositoryNodeId ||
      repo.full_name.toLowerCase() !== this.binding.fullName.toLowerCase()
    )
      throw new GroupGitBlocked('GitHub canonical account/repository identity changed');
    await this.revalidate();
    return native.token;
  }
  async #request(service: string, budget: ObjectBudget, body?: Buffer): Promise<Buffer> {
    const token = await this.#credentials(budget);
    const response = await this.wire(
      {
        url: new URL(`${this.#repo.url}/${body ? service : `info/refs?service=${service}`}`),
        method: body ? 'POST' : 'GET',
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
        accept: `application/x-${service}-${body ? 'result' : 'advertisement'}`,
        contentType: body ? `application/x-${service}-request` : undefined,
        body,
      },
      budget,
    );
    if (
      response.status !== 200 ||
      response.contentType !== `application/x-${service}-${body ? 'result' : 'advertisement'}`
    )
      throw new GroupGitBlocked('GitHub smart HTTP service unavailable');
    await this.revalidate();
    return response.body;
  }
  async observationMechanism(): Promise<string> {
    await this.revalidate();
    return 'GitHub smart HTTPS filter blob:none; raw TCP ciphertext request/response quota, complete hash-verified bounded metadata pack';
  }
  async ref(name: string, budget: ObjectBudget): Promise<string | null> {
    gitRef.parse(name);
    const ad = advertisement(await this.#request('git-upload-pack', budget), 'git-upload-pack');
    const oid = ad.refs.get(name) ?? null;
    if (oid) this.#types.set(oid, 'commit');
    return oid;
  }
  async object(
    oid: string,
    budget: ObjectBudget,
    expectedType?: GitObject['type'],
  ): Promise<GitObject> {
    gitOid.parse(oid);
    await this.revalidate();
    const saved = this.#objects.get(oid);
    if (saved) return saved;
    const type = expectedType ?? this.#types.get(oid) ?? 'commit';
    const ad = advertisement(await this.#request('git-upload-pack', budget), 'git-upload-pack');
    if (!ad.capabilities.has('side-band-64k') || !ad.capabilities.has('filter'))
      throw new GroupGitBlocked('GitHub bounded partial fetch capability unavailable');
    const body = Buffer.concat([
      packet(`want ${oid} side-band-64k ofs-delta filter\n`),
      ...(type === 'blob' ? [] : [packet('filter blob:none\n')]),
      Buffer.from('0000'),
      packet('done\n'),
    ]);
    const rows = packets(await this.#request('git-upload-pack', budget, body));
    if (rows[0]?.toString() !== 'NAK\n') throw new GroupGitBlocked('Unexpected GitHub negotiation');
    const chunks: Buffer[] = [];
    for (const row of rows.slice(1)) {
      if (!row) continue;
      if (row[0] === 1) chunks.push(row.subarray(1));
      else if (row[0] !== 2) throw new GroupGitBlocked('GitHub pack transfer refused');
    }
    const objects = unpack(
      Buffer.concat(chunks),
      Math.min(budget.remaining, budget.maxObjectBytes ?? budget.remaining),
      budget.maxObjects - budget.objects,
    );
    for (const object of objects) {
      if (
        (type !== 'blob' && object.type === 'blob') ||
        (type === 'blob' && (object.oid !== oid || object.type !== 'blob'))
      )
        throw new GroupGitBlocked('GitHub returned unselected content');
      charge(budget, object.bytes.length, true);
      verifyGitObject(object);
      this.#objects.set(object.oid, object);
      if (object.type === 'tree') {
        let offset = 0;
        while (offset < object.bytes.length) {
          const space = object.bytes.indexOf(32, offset),
            nul = object.bytes.indexOf(0, space + 1);
          if (space < offset || nul < space || nul + 21 > object.bytes.length)
            throw new GroupGitBlocked('Malformed GitHub tree');
          const mode = object.bytes.subarray(offset, space).toString(),
            child = object.bytes.subarray(nul + 1, nul + 21).toString('hex');
          this.#types.set(child, mode === '40000' || mode === '040000' ? 'tree' : 'blob');
          offset = nul + 21;
        }
      }
    }
    const object = this.#objects.get(oid);
    if (!object || object.type !== type)
      throw new GroupGitBlocked('GitHub selected object unavailable');
    return object;
  }
  async createOnlyMechanism(ref: string, budget: ObjectBudget): Promise<string | null> {
    gitRef.parse(ref);
    await this.revalidate();
    const ad = advertisement(await this.#request('git-receive-pack', budget), 'git-receive-pack');
    if (ad.refs.has(ref) || !ad.capabilities.has('report-status')) return null;
    this.#create = { ref };
    return 'Git receive-pack create command with exactly zero old SHA; never update/delete/force';
  }
  async create(
    ref: string,
    oid: string,
    objects: readonly GitObject[],
    budget: ObjectBudget,
  ): Promise<void> {
    gitRef.parse(ref);
    gitOid.parse(oid);
    if (this.#create?.ref !== ref || !ref.startsWith('refs/heads/dock-proposals/'))
      throw new GroupGitBlocked('GitHub fresh proposal gate required');
    const ad = advertisement(await this.#request('git-receive-pack', budget), 'git-receive-pack');
    if (ad.refs.has(ref) || !ad.capabilities.has('report-status'))
      throw new GroupGitBlocked('GitHub create-only target/capability denied');
    for (const object of objects) verifyGitObject(object);
    const body = Buffer.concat([
      packet(`${zero} ${oid} ${ref}\0report-status\n`),
      Buffer.from('0000'),
      pack(objects),
    ]);
    await this.revalidate();
    const status = packets(await this.#request('git-receive-pack', budget, body))
      .filter((r): r is Buffer => r !== null)
      .map((r) => r.toString());
    if (status.length !== 2 || status[0] !== 'unpack ok\n' || status[1] !== `ok ${ref}\n`)
      throw new Error('GitHub proposal outcome unverified; inspect same ID');
    this.#create = null;
  }
}
