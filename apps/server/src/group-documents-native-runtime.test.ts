import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { groupContextSchema } from '@dock/shared';
import {
  GROUP_DOCUMENT_LIMITS,
  groupDocumentBuildPolicy,
} from '@dock/shared/dist/group-documents.js';
import {
  createGroupDocumentsNativeRuntime,
  nativeDocumentResultNames,
  type GroupDocumentsNativeRuntime,
} from './group-documents-native-runtime.js';
import { GroupDocumentNativeResultIndex } from './group-documents-native-runtime-receipts.js';
import { GroupDockerEngine, type GroupContainerPlan } from './group-container.js';
import { GroupDocuments, groupDocumentVersion } from './group-documents.js';

const id = () => randomUUID();
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
function removeFixture(root: string) {
  const writable = (p: string) => {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const name of readdirSync(p)) writable(join(p, name));
    }
  };
  writable(root);
  rmSync(root, { recursive: true, force: true });
}
const helper = resolve('../../runtime/group-native/group-documents.py');
const image = 'sha256:' + 'e'.repeat(64);
const containerId = 'a'.repeat(64);
// Fixture transport executes the real public capture/export helper on uncredentialed temporary bytes.
// The build branch is a clearly labeled fixture PDF; no test claims a Linux/TeX native compile.
const harness = `import importlib.util,sys,json,pathlib,base64,hashlib
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('docs',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.WORKSPACE=pathlib.Path(sys.argv[2]);mode=sys.argv[3];request=json.load(sys.stdin)
if mode=='build':
 files={f['name']:base64.b64decode(f['base64']) for f in request['files']}
 if b'\\\\input{chapter}' in files[request['entry']] and 'chapter.tex' not in files:sys.exit(1)
 data=b'%PDF-1.7\\nfixture only\\n%%EOF'
 value={'state':'completed','sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'base64':base64.b64encode(data).decode()}
else:value={'capture':m.capture,'export':m.export}[mode](request)
print(json.dumps(value))`;

function fixture(visibility: 'private' | 'shared' = 'private') {
  const root = mkdtempSync(join(tmpdir(), 'group-doc-native-'));
  chmodSync(root, 0o700);
  cleanup.push(() => removeFixture(root));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(
    join(workspace, 'report.tex'),
    '\\documentclass{article}\n\\begin{document}Hello \\input{chapter}\\end{document}',
  );
  writeFileSync(join(workspace, 'chapter.tex'), 'Exact selected chapter');
  writeFileSync(join(workspace, 'secret.txt'), 'ambient private bytes NEVER exported');
  const context = groupContextSchema.parse({
    groupId: id(),
    memberId: id(),
    installationId: id(),
    sessionId: id(),
    visibility,
    provider: 'owner',
    nativeSessionId: id(),
  });
  const nativeContext = groupContextSchema.parse({
    ...context,
    sessionId: id(),
    provider: 'codex',
    nativeSessionId: id(),
  });
  const resultId = id(),
    requestId = id(),
    handle = id(),
    runId = id(),
    volume = 'swa-group-' + id();
  const plan: GroupContainerPlan = {
    context: {
      groupId: context.groupId,
      memberId: context.memberId,
      installationId: context.installationId,
      contextId: nativeContext.sessionId,
      visibility,
    },
    image,
    workspace: null,
    reads: [],
    outbound: [],
    expiresAt: Date.now() + 120000,
    cpuCores: 1,
    memoryMb: 768,
  };
  const source =
    visibility === 'shared'
      ? {
          sessionId: nativeContext.sessionId,
          provider: 'codex' as const,
          nativeSessionId: nativeContext.nativeSessionId,
          messageId: id(),
        }
      : undefined;
  const receipt = {
    requestId,
    contextId: nativeContext.sessionId,
    state: 'completed',
    runId,
    nativeTurnId: 'exact-native-turn',
    text: '[Report](/workspace/report.tex)',
    nativeToolItems: 2,
    ...(source ? { source } : {}),
  };
  const hostPath = join(root, 'host.sqlite'),
    nativePath = join(root, 'native.sqlite');
  writeFileSync(hostPath, '', { mode: 0o600 });
  writeFileSync(nativePath, '', { mode: 0o600 });
  const host = new DatabaseSync(hostPath),
    native = new DatabaseSync(nativePath);
  host.exec(
    'CREATE TABLE ghn_requests(handle TEXT,key TEXT,request_id TEXT,input TEXT,ids TEXT);CREATE TABLE ghn_results(request_id TEXT,body TEXT,created_at TEXT)',
  );
  host
    .prepare('INSERT INTO ghn_requests VALUES(?,?,?,?,?)')
    .run(
      handle,
      id(),
      requestId,
      JSON.stringify({ requestId, context, enrollmentHandle: id() }),
      JSON.stringify({ resultId }),
    );
  native.exec(
    'CREATE TABLE gn_contexts(context_id TEXT,local_json TEXT);CREATE TABLE gn_native(context_id TEXT,provider TEXT,native_id TEXT);CREATE TABLE gn_messages(context_id TEXT,native_id TEXT,alias TEXT);CREATE TABLE gn_requests(request_id TEXT,context_id TEXT,prompt_hash TEXT);CREATE TABLE gn_request_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT,event_json TEXT);CREATE TABLE gn_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,context_id TEXT,kind TEXT,detail TEXT)',
  );
  native
    .prepare('INSERT INTO gn_contexts VALUES(?,?)')
    .run(nativeContext.sessionId, JSON.stringify({ context: nativeContext }));
  native
    .prepare('INSERT INTO gn_native VALUES(?,?,?)')
    .run(nativeContext.sessionId, 'codex', 'actual-native-thread');
  if (source)
    native
      .prepare('INSERT INTO gn_messages VALUES(?,?,?)')
      .run(nativeContext.sessionId, 'actual-native-message', source.messageId);
  native
    .prepare('INSERT INTO gn_requests VALUES(?,?,?)')
    .run(requestId, nativeContext.sessionId, sha('prompt'));
  native
    .prepare('INSERT INTO gn_request_events(request_id,event_json) VALUES(?,?)')
    .run(requestId, JSON.stringify(receipt));
  const recordNative = (kind: string, detail: unknown) =>
    native
      .prepare('INSERT INTO gn_events(context_id,kind,detail) VALUES(?,?,?)')
      .run(nativeContext.sessionId, kind, JSON.stringify(detail));
  recordNative('container-reserved', {
    name: 'swa-group-' + id(),
    volume,
    manifest: JSON.stringify(plan),
  });
  recordNative('container-created', { container: containerId, volume });
  cleanup.push(() => {
    host.close();
    native.close();
  });
  let active = true,
    failNext = false,
    unverified = false,
    spawns = 0,
    retired = 0;
  const plans: { plan: GroupContainerPlan; retained?: string }[] = [];
  const authority = {
    async revalidateOwner(c: typeof context) {
      expect(c).toEqual(context);
      if (!active) throw new Error('membership revoked');
    },
  };
  class FixtureEngine extends GroupDockerEngine {
    override async availability() {
      return {
        state: 'ready' as const,
        runtimeSignature: 'test-only transport',
        cpuCores: 1,
        memoryMb: 768,
        nativeDesktop: 'Linux guest only; macOS native app control is unavailable' as const,
      };
    }
    override async retireReservation() {
      retired++;
      if (unverified) throw new Error('stop unverified');
    }
  }
  const guest = (
    p = plan,
    admitted = () => {},
    record: (kind: string, detail: Record<string, string>) => void = () => {},
    retained?: string,
  ) => ({
    plan: p,
    volume: retained ?? 'swa-group-' + id(),
    id: containerId,
    async start() {
      admitted();
      record('container-reserved', {
        name: 'swa-group-' + id(),
        volume: this.volume,
        manifest: JSON.stringify(p),
      });
    },
    spawn(argv: readonly string[]) {
      admitted();
      spawns++;
      expect(argv.slice(0, 4)).toEqual([
        '/usr/bin/python3',
        '-I',
        '-B',
        '/opt/dock/group-documents.py',
      ]);
      if (failNext) {
        failNext = false;
        return spawn(process.execPath, [
          '-e',
          'process.stdin.resume();process.stdin.on("end",()=>process.exit(1))',
        ]);
      }
      return spawn('python3', ['-c', harness, helper, workspace, argv[4]!]);
    },
    async close() {
      if (unverified) throw new Error('stop unverified');
    },
  });
  const execution = {
    container: guest(
      plan,
      () => {},
      () => {},
      volume,
    ),
    gitExportProof: () => ({ contextId: nativeContext.sessionId, runId, containerId }),
  };
  let runtime: GroupDocumentsNativeRuntime;
  const start = () => {
    runtime = createGroupDocumentsNativeRuntime(
      {
        directory: join(root, 'runtime'),
        hostJournalPath: hostPath,
        nativeJournalPath: nativePath,
        image,
        authority,
      },
      {
        engine: new FixtureEngine(),
        container(p, _state, admitted, record, retained) {
          plans.push({ plan: p, ...(retained ? { retained } : {}) });
          return guest(p, admitted, record, retained);
        },
      },
    );
    return runtime;
  };
  start();
  cleanup.push(async () => {
    await runtime.close();
  });
  const project = () =>
    host.prepare('INSERT INTO ghn_results VALUES(?,?,?)').run(
      requestId,
      JSON.stringify({
        context: nativeContext,
        text: receipt.text,
        nativeToolItems: receipt.nativeToolItems,
        ...(source ? { source } : {}),
      }),
      new Date().toISOString(),
    );
  return {
    root,
    workspace,
    context,
    nativeContext,
    resultId,
    requestId,
    handle,
    runId,
    volume,
    plan,
    receipt,
    host,
    native,
    source,
    execution,
    project,
    start,
    get runtime() {
      return runtime;
    },
    plans,
    get spawns() {
      return spawns;
    },
    get retired() {
      return retired;
    },
    revoke() {
      active = false;
    },
    fail() {
      failNext = true;
    },
    unverified(v: boolean) {
      unverified = v;
    },
  };
}
const exportInput = (
  manifest: Awaited<ReturnType<GroupDocumentsNativeRuntime['describe']>>,
  key = id(),
  ids = manifest.files.map((f) => f.artifactId),
) => ({
  key,
  manifest,
  artifactIds: ids,
  limits: { bytes: GROUP_DOCUMENT_LIMITS.bytes, timeoutMs: GROUP_DOCUMENT_LIMITS.readingMs },
});

async function capturedFixture(visibility: 'private' | 'shared' = 'private') {
  const f = fixture(visibility);
  await f.runtime.captureCompletedRequest(f.requestId, f.execution);
  f.project();
  return { ...f, original: f, manifest: await f.runtime.describe(f.resultId) };
}

describe('concrete native result journal and guest document bridge', () => {
  it('admits new reports after 129 completed small captures/operations and retains exact historical retries', async () => {
    const f = fixture();
    const db = new DatabaseSync(join(f.root, 'runtime', 'native-documents.sqlite'));
    try {
      // Capacity-only historical rows; production result authority is still
      // proved by the real fixture journals/helper for the new report below.
      for (let n = 0; n < 129; n++) {
        const resultId = id();
        db.prepare('INSERT INTO nd_capture VALUES(?,?,?)').run(resultId, id(), sha('history'));
        db.prepare('INSERT INTO nd_results VALUES(?,?)').run(
          resultId,
          JSON.stringify({ manifest: { files: [{ bytes: 1 }] } }),
        );
        db.prepare("INSERT INTO nd_ops VALUES(?,'export',?,?,'completed',?,?)").run(
          id(),
          sha('history'),
          id(),
          '{}',
          Buffer.from('tiny retained result'),
        );
      }
      await f.runtime.captureCompletedRequest(f.requestId, f.execution);
      f.project();
      const manifest = await f.runtime.describe(f.resultId);
      const firstInput = exportInput(manifest);
      const first = await f.runtime.export(firstInput);
      expect(first.state).toBe('completed');
      expect((await f.runtime.export(exportInput(manifest))).state).toBe('completed');
      const spawns = f.spawns;
      expect(await f.runtime.export(firstInput)).toEqual(first);
      expect(f.spawns).toBe(spawns);
      expect(Number(db.prepare('SELECT COUNT(*) n FROM nd_capture').get()!.n)).toBe(130);
      expect(Number(db.prepare('SELECT COUNT(*) n FROM nd_ops').get()!.n)).toBe(131);
    } finally {
      db.close();
    }
  });
  it('reserves worst-case pending bytes before capture/export and preserves receipts on saturation', async () => {
    const f = await capturedFixture();
    const db = new DatabaseSync(join(f.root, 'runtime', 'native-documents.sqlite'));
    try {
      const historicalInput = exportInput(f.manifest);
      const historical = await f.runtime.export(historicalInput);
      expect(historical.state).toBe('completed');
      // Ten unresolved maximum PDFs reserve >500 MiB; another maximum PDF
      // reservation is refused even when their current payload bodies are empty.
      for (let n = 0; n < 10; n++)
        db.prepare("INSERT INTO nd_ops VALUES(?,'build',?,?,'unknown',NULL,NULL)").run(
          id(),
          sha('pending'),
          id(),
        );
      const before = f.original.spawns;
      // Extra pending captures make the shared 512 MiB envelope full.
      for (let n = 0; n < 2; n++)
        db.prepare('INSERT INTO nd_capture VALUES(?,?,?)').run(id(), id(), sha('pending'));
      await expect(f.runtime.export(exportInput(f.manifest))).rejects.toThrow('capacity');
      expect(f.original.spawns).toBe(before);
      expect(await f.runtime.export(historicalInput)).toEqual(historical);
      expect(f.original.spawns).toBe(before);
      expect(Number(db.prepare('SELECT COUNT(*) n FROM nd_ops').get()!.n)).toBe(11);
      const fresh = fixture();
      const full = new DatabaseSync(join(fresh.root, 'runtime', 'native-documents.sqlite'));
      try {
        for (let n = 0; n < 128; n++)
          full.prepare('INSERT INTO nd_capture VALUES(?,?,?)').run(id(), id(), sha('pending'));
        await expect(
          fresh.runtime.captureCompletedRequest(fresh.requestId, fresh.execution),
        ).rejects.toThrow('capacity');
        expect(fresh.spawns).toBe(0);
        expect(Number(full.prepare('SELECT COUNT(*) n FROM nd_capture').get()!.n)).toBe(128);
      } finally {
        full.close();
      }
    } finally {
      db.close();
    }
  });
  it('captures exact private completion, exports explicit handles and dispatches a fresh bounded builder (fixture PDF)', async () => {
    const f = await capturedFixture();
    expect(f.manifest.context.provider).toBe('owner');
    expect(f.manifest.nativeContext).toEqual(f.nativeContext);
    expect(f.manifest.files.map((x) => x.name)).toEqual(['chapter.tex', 'report.tex']);
    const exports = await f.runtime.export(exportInput(f.manifest));
    expect(exports.state).toBe('completed');
    if (exports.state !== 'completed') throw new Error('fixture');
    const entry = f.manifest.files.find((x) => x.name === 'report.tex')!;
    const input = {
      key: id(),
      grantId: id(),
      sourceReceiptId: f.manifest.receiptId,
      version: groupDocumentVersion(f.manifest),
      context: f.context,
      entry,
      files: f.manifest.files.map((meta) => ({
        ...meta,
        content: exports.files.find((x) => x.artifactId === meta.artifactId)!.bytes,
      })),
      policy: groupDocumentBuildPolicy,
    };
    const output = await f.runtime.build!(input);
    expect(output.state).toBe('completed');
    if (output.state === 'completed')
      expect(Buffer.from(output.pdf).subarray(0, 5).toString()).toBe('%PDF-');
    expect(f.plans[0]?.retained).toBe(f.volume);
    expect(f.plans[0]?.plan.context.contextId).toBe(f.nativeContext.sessionId);
    expect(f.plans[1]?.retained).toBeUndefined();
    expect(f.plans[1]?.plan.context.contextId).not.toBe(f.nativeContext.sessionId);
    for (const { plan } of f.plans) {
      expect(plan.workspace).toBeNull();
      expect(plan.reads).toEqual([]);
      expect(plan.outbound).toEqual([]);
      expect(plan.cpuCores).toBe(1);
      expect(plan.memoryMb).toBe(768);
    }
    const count = f.original.spawns;
    await f.runtime.build!(input);
    expect(f.original.spawns).toBe(count);
  });
  it('does not describe an unprojected completion or recapture a later working copy', async () => {
    const f = fixture();
    await f.runtime.captureCompletedRequest(f.requestId, f.execution);
    await expect(f.runtime.describe(f.resultId)).rejects.toThrow(/durable owning chat/);
    f.project();
    writeFileSync(join(f.workspace, 'report.tex'), 'changed working copy');
    const repeated = await f.runtime.captureCompletedRequest(f.requestId, f.execution);
    expect(repeated?.files.find((x) => x.name === 'report.tex')?.sha256).not.toBe(
      sha('changed working copy'),
    );
    const manifest = await f.runtime.describe(f.resultId),
      output = await f.runtime.export(exportInput(manifest));
    expect(output.state).toBe('completed');
    if (output.state === 'completed')
      expect(
        Buffer.from(
          output.files.find(
            (x) => x.artifactId === manifest.files.find((x) => x.name === 'report.tex')!.artifactId,
          )!.bytes,
        ).toString(),
      ).toContain('\\input{chapter}');
  });
  it('requires exact actual run/container proof and latest native request for capture', async () => {
    const f = fixture();
    await expect(
      f.runtime.captureCompletedResult(f.resultId, {
        ...f.execution,
        gitExportProof: () => ({ ...f.execution.gitExportProof(), runId: id() }),
      }),
    ).rejects.toThrow(/completion proof/);
    f.native
      .prepare('INSERT INTO gn_requests VALUES(?,?,?)')
      .run(id(), f.nativeContext.sessionId, sha('later'));
    await expect(f.runtime.captureCompletedResult(f.resultId, f.execution)).rejects.toThrow(
      /precede the next/,
    );
  });
  it('rejects mixed group, changed host projection, missing shared alias and private publication claims', async () => {
    const f = fixture('shared');
    f.project();
    const index = new GroupDocumentNativeResultIndex(
      join(f.root, 'host.sqlite'),
      join(f.root, 'native.sqlite'),
    );
    cleanup.push(() => index.close());
    expect(index.read(f.resultId).source).toEqual(f.source);
    f.native.exec('DELETE FROM gn_messages');
    expect(() => index.read(f.resultId)).toThrow(/shared native source/);
    f.native
      .prepare('INSERT INTO gn_messages VALUES(?,?,?)')
      .run(f.nativeContext.sessionId, 'message', f.source!.messageId);
    f.host.prepare('UPDATE ghn_results SET body=?').run(
      JSON.stringify({
        context: f.nativeContext,
        text: 'different',
        nativeToolItems: 2,
        source: f.source,
      }),
    );
    expect(() => index.read(f.resultId)).toThrow(/projection differs/);
    f.host.exec('DELETE FROM ghn_results');
    f.native
      .prepare('UPDATE gn_contexts SET local_json=?')
      .run(JSON.stringify({ context: { ...f.nativeContext, groupId: id() } }));
    expect(() => index.read(f.resultId, false)).toThrow(/owner\/context mismatch/);
    const p = fixture();
    p.native
      .prepare('UPDATE gn_request_events SET event_json=?')
      .run(JSON.stringify({ ...p.receipt, source: f.source }));
    await expect(p.runtime.captureCompletedResult(p.resultId, p.execution)).rejects.toThrow(
      /Private result/,
    );
  });
  it('refuses symlink and traversal inputs, and altered immutable snapshot bytes', async () => {
    expect(nativeDocumentResultNames('[x](https://example.org/a.tex)')).toEqual([]);
    expect(() => nativeDocumentResultNames('[x](/workspace/../outside.tex)')).toThrow();
    const f = fixture();
    rmSync(join(f.workspace, 'chapter.tex'));
    symlinkSync(join(f.workspace, 'secret.txt'), join(f.workspace, 'chapter.tex'));
    await expect(f.runtime.captureCompletedResult(f.resultId, f.execution)).rejects.toThrow(
      /receipt retained/,
    );
    const ok = await capturedFixture();
    const file = ok.manifest.files[0]!;
    const path = join(ok.workspace, '.dock-documents', ok.manifest.receiptId, file.name);
    chmodSync(path, 0o600);
    writeFileSync(path, 'tampered');
    const output = await ok.runtime.export(exportInput(ok.manifest));
    expect(output.state).toBe('unknown');
  });
  it('returns stable uncertain receipt, reconciles same namespace after restart and never changes selected payload', async () => {
    const f = await capturedFixture();
    const input = exportInput(f.manifest);
    f.original.fail();
    const first = await f.runtime.export(input);
    expect(first.state).toBe('unknown');
    await f.runtime.close();
    const next = f.original.start();
    const second = await next.export(input);
    expect(second.state).toBe('completed');
    expect(second.receiptId).toBe(first.receiptId);
    expect(f.original.retired).toBe(1);
    await expect(
      next.export({ ...input, artifactIds: [f.manifest.files[0]!.artifactId] }),
    ).rejects.toThrow(/same request changed/);
    const count = f.original.spawns;
    await next.export(input);
    expect(f.original.spawns).toBe(count);
    f.original.revoke();
    await expect(next.export(input)).rejects.toThrow(/revoked/);
  });
  it('keeps stop-uncertain namespace evidence and blocks retries until exact reconciliation', async () => {
    const f = await capturedFixture(),
      input = exportInput(f.manifest);
    f.original.fail();
    f.original.unverified(true);
    const first = await f.runtime.export(input);
    expect(first.state).toBe('unknown');
    const count = f.original.spawns;
    const second = await f.runtime.export(input);
    expect(second.state).toBe('unknown');
    expect(second.receiptId).toBe(first.receiptId);
    expect(f.original.spawns).toBe(count);
    f.original.unverified(false);
    expect((await f.runtime.export(input)).state).toBe('completed');
  });
  it('denies build bytes outside exact native receipt, requires exact completed export set and fails on missing dependency', async () => {
    const f = await capturedFixture(),
      entry = f.manifest.files.find((x) => x.name === 'report.tex')!;
    const e = await f.runtime.export(exportInput(f.manifest, id(), [entry.artifactId]));
    if (e.state !== 'completed') throw new Error('fixture');
    const input = {
      key: id(),
      grantId: id(),
      sourceReceiptId: f.manifest.receiptId,
      version: groupDocumentVersion(f.manifest),
      context: f.context,
      entry,
      files: [{ ...entry, content: e.files[0]!.bytes }],
      policy: groupDocumentBuildPolicy,
    };
    expect((await f.runtime.build!(input)).state).toBe('unknown');
    await expect(
      f.runtime.build!({
        ...input,
        key: id(),
        files: [{ ...entry, content: Buffer.from('unverified') }],
      }),
    ).rejects.toThrow(/exact native receipt/);
    await expect(
      f.runtime.build!({
        ...input,
        key: id(),
        context: groupContextSchema.parse({ ...f.context, groupId: id() }),
      }),
    ).rejects.toThrow(/scope\/policy/);
    await expect(
      f.runtime.build!({
        ...input,
        key: id(),
        policy: {
          ...groupDocumentBuildPolicy,
          shellEscape: true,
        } as unknown as typeof groupDocumentBuildPolicy,
      }),
    ).rejects.toThrow(/scope\/policy/);
  });
  it('deduplicates concurrent capture/export, refuses a live second factory and detects cached byte damage', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.runtime.captureCompletedRequest(f.requestId, f.execution),
      f.runtime.captureCompletedRequest(f.requestId, f.execution),
    ]);
    expect(first).toEqual(second);
    expect(f.spawns).toBe(1);
    f.project();
    const manifest = await f.runtime.describe(f.resultId),
      input = exportInput(manifest);
    const outputs = await Promise.all([f.runtime.export(input), f.runtime.export(input)]);
    expect(outputs[0]).toEqual(outputs[1]);
    expect(f.spawns).toBe(2);
    expect(() => f.start()).toThrow(/already owned/);
    const db = new DatabaseSync(join(f.root, 'runtime', 'native-documents.sqlite'));
    try {
      db.prepare('UPDATE nd_ops SET body=? WHERE key=?').run(Buffer.from('[]'), input.key);
    } finally {
      db.close();
    }
    expect((await f.runtime.export(input)).state).toBe('unknown');
    expect(f.spawns).toBe(2);
  });
  it('connects the concrete provider to scoped grants, PDF and existing Reading with other-group/private/revoke denial', async () => {
    const f = await capturedFixture();
    const other = id();
    const authority = {
      ...{
        revalidateOwner: async () => {
          await Promise.resolve();
        },
      },
      async resolve(h: string) {
        if (h !== f.handle && h !== other) throw new Error('denied');
        return {
          context:
            h === other ? groupContextSchema.parse({ ...f.context, groupId: id() }) : f.context,
          async revalidate() {},
        };
      },
    };
    const docs = new GroupDocuments(
      join(f.root, 'documents.sqlite'),
      join(f.root, 'reading'),
      authority,
      f.runtime,
    );
    cleanup.push(() => docs.close());
    const offer = await docs.offer(f.handle, f.resultId);
    await expect(docs.offer(other, f.resultId)).rejects.toThrow(/unavailable/);
    const grant = await docs.grant(f.handle, {
      key: id(),
      offer: offer.handle,
      entry: offer.files.find((x) => x.name === 'report.tex')!.handle,
      dependencies: [offer.files.find((x) => x.name === 'chapter.tex')!.handle],
    });
    await docs.build(f.handle, grant.grantId, grant.version, { key: id() });
    expect(
      Buffer.from(await docs.pdf(f.handle, grant.grantId, grant.version))
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    const reading = await docs.reading(f.handle, grant.grantId, grant.version);
    expect(JSON.stringify(reading)).toContain('Exact selected chapter');
    await expect(docs.pdf(other, grant.grantId, grant.version)).rejects.toThrow(/unavailable/);
    await docs.revoke(f.handle, grant.grantId, { key: id() }, grant.version);
    await expect(docs.reading(f.handle, grant.grantId, grant.version)).rejects.toThrow(
      /unavailable/,
    );
  });
});
