import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { groupContextSchema, type GroupContext } from '@dock/shared';
import {
  GroupHostNativeDocuments,
  captureHostDocumentFiles,
  hostDocumentResultNames,
} from './group-documents-host-native.js';
import { GroupHostNativeJournal } from './group-host-native-journal.js';
import { GroupDocuments, groupDocumentVersion } from './group-documents.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeCompletion } from './group-native-host-runtime.js';
import type { GroupDocumentsAuthority } from './group-documents-native.js';
import { GroupFeatureDocuments } from './group-feature-documents.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(text = '[Report](report.tex)') {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'group-host-reports-')));
  const cwd = join(directory, 'host-workspaces', randomUUID());
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'host.sqlite'));
  const nativeJournal = new GroupHostNativeJournal(db);
  const context = groupContextSchema.parse({
    groupId: randomUUID(),
    memberId: randomUUID(),
    installationId: randomUUID(),
    sessionId: randomUUID(),
    provider: 'owner',
    nativeSessionId: randomUUID(),
    visibility: 'shared',
  });
  const nativeContext = groupContextSchema.parse({
    ...context,
    sessionId: randomUUID(),
    nativeSessionId: randomUUID(),
    provider: 'codex',
  });
  const handle = randomUUID();
  const record = nativeJournal.prepare(handle, {
    key: randomUUID(),
    text: 'Write the report',
    context,
    enrollmentHandle: randomUUID(),
    intent: 'work',
  });
  const result = {
    context: nativeContext,
    text,
    nativeToolItems: 1,
    source: {
      sessionId: nativeContext.sessionId,
      provider: nativeContext.provider,
      nativeSessionId: nativeContext.nativeSessionId,
      messageId: record.request.requestId,
    },
  };
  const completion: GroupHostNativeCompletion = {
    request: record.request,
    result,
    runId: randomUUID(),
    cwd,
  };
  const host = { directory, db, nativeJournal } as GroupHost;
  let active = true;
  const revalidateOwner = vi.fn(async (candidate: GroupContext) => {
    if (!active || JSON.stringify(candidate) !== JSON.stringify(context))
      throw Error('Denied owner');
  });
  const authority: GroupDocumentsAuthority = {
    revalidateOwner,
    resolve: async (selected) => {
      if (selected !== handle) throw Error('Denied slot');
      return {
        context,
        revalidate: async () => {
          if (!active) throw Error('Revoked');
        },
      };
    },
  };
  let adapter = new GroupHostNativeDocuments(host);
  adapter.documents(authority);
  cleanup.push(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    cwd,
    record,
    handle,
    completion,
    db,
    host,
    authority,
    revalidateOwner,
    get adapter() {
      return adapter;
    },
    revoke() {
      active = false;
    },
    project() {
      nativeJournal.record(record, {
        requestId: record.request.requestId,
        state: 'completed',
        message: 'Retained',
        result,
      });
    },
    async restart() {
      await adapter.close();
      adapter = new GroupHostNativeDocuments(host);
      adapter.documents(authority);
    },
  };
}

it('pins only exact Work-linked files and nested literal dependencies; later workspace bytes never replace capture', async () => {
  const f = fixture();
  mkdirSync(join(f.cwd, 'sections'));
  mkdirSync(join(f.cwd, 'figures'));
  writeFileSync(
    join(f.cwd, 'report.tex'),
    '\\documentclass{article}\n\\begin{document}\\input{sections/one}\\end{document}',
  );
  writeFileSync(
    join(f.cwd, 'sections/one.tex'),
    'Exact section \\includegraphics{../figures/plot.png}',
  );
  writeFileSync(join(f.cwd, 'figures/plot.png'), 'exact figure');
  writeFileSync(join(f.cwd, 'private.tex'), 'Private unrelated file');
  await f.adapter.captureCompleted(f.completion);
  await expect(f.adapter.describe(f.record.ids.resultId)).rejects.toThrow(/owning reply/);
  f.project();
  const manifest = await f.adapter.describe(f.record.ids.resultId);
  expect(manifest.files.map((file) => file.name)).toEqual([
    'figures/plot.png',
    'report.tex',
    'sections/one.tex',
  ]);
  expect(manifest.source.messageId).toBe(f.record.request.requestId);
  writeFileSync(join(f.cwd, 'report.tex'), 'Later content');
  const input = {
    key: randomUUID(),
    manifest,
    artifactIds: [manifest.files.find((file) => file.name === 'report.tex')!.artifactId],
    limits: { bytes: 8 * 1024 ** 2, timeoutMs: 5000 },
  };
  const exported = await f.adapter.export(input);
  expect(exported.files[0]!.bytes.toString()).toContain('sections/one');
  await f.restart();
  expect(await f.adapter.export(input)).toEqual(exported);
  await f.adapter.captureCompleted(f.completion);
  expect(await f.adapter.describe(manifest.resultId)).toEqual(manifest);
  await expect(f.adapter.export({ ...input, artifactIds: [randomUUID()] })).rejects.toThrow(
    /selection/,
  );
  await expect(
    f.adapter.export({ ...input, artifactIds: manifest.files.map((file) => file.artifactId) }),
  ).rejects.toThrow(/retry changed/);
  f.revoke();
  await expect(f.adapter.export(input)).rejects.toThrow(/Denied/);
});

it.each(['missing-python', 'missing-dependency'] as const)(
  'retains terminal %s capture and visible receipt guidance after repair and restart without recapture',
  async (failure) => {
    const f = fixture();
    writeFileSync(
      join(f.cwd, 'report.tex'),
      failure === 'missing-dependency' ? '\\input{missing}' : 'Exact report',
    );
    if (failure === 'missing-python') vi.stubEnv('PATH', '');
    try {
      await f.adapter.captureCompleted(f.completion);
    } finally {
      vi.unstubAllEnvs();
    }
    f.project();
    expect(f.adapter.documentCaptureState(f.record.ids.resultId)).toBe('unavailable');
    await expect(f.adapter.describe(f.record.ids.resultId)).rejects.toMatchObject({
      code: 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE',
      disposition: 'unavailable',
    });
    writeFileSync(join(f.cwd, 'missing.tex'), 'Later dependency');
    writeFileSync(join(f.cwd, 'report.tex'), 'Later report');
    await f.restart();
    await f.adapter.captureCompleted(f.completion);
    await expect(f.adapter.describe(f.record.ids.resultId)).rejects.toMatchObject({
      code: 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE',
    });
    const documents = new GroupFeatureDocuments(f.host, {
      documents: () => f.adapter,
      documentAvailable: (id) => f.adapter.documentAvailable(id),
      documentCaptureState: (id) => f.adapter.documentCaptureState(id),
    });
    try {
      expect(documents.receipt(f.host.nativeJournal.get(f.handle, f.record.request.key)!)).toEqual({
        documentAvailable: false,
        documentCaptureState: 'unavailable',
      });
    } finally {
      await documents.close();
    }
  },
);

it('only an active exact capture is pending; settling retains the captured bytes', async () => {
  const f = fixture();
  writeFileSync(join(f.cwd, 'report.tex'), 'Exact report');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.revalidateOwner.mockImplementationOnce(async () => held);
  const capture = f.adapter.captureCompleted(f.completion);
  expect(f.adapter.captureCompleted(f.completion)).toBe(capture);
  expect(f.adapter.documentCaptureState(f.record.ids.resultId)).toBe('pending');
  await expect(f.adapter.describe(f.record.ids.resultId)).rejects.toMatchObject({
    code: 'GROUP_DOCUMENT_CAPTURE_PENDING',
    disposition: 'pending',
  });
  release();
  await capture;
  f.project();
  expect(f.adapter.documentCaptureState(f.record.ids.resultId)).toBeUndefined();
  expect((await f.adapter.describe(f.record.ids.resultId)).files[0]?.name).toBe('report.tex');
});

it('a missed completed Work report stays terminal; an ordinary reply without a report has no capture notice', async () => {
  const missed = fixture();
  missed.project();
  expect(missed.adapter.documentCaptureState(missed.record.ids.resultId)).toBe('unavailable');
  const ordinary = fixture('Completed the requested change.');
  ordinary.project();
  expect(ordinary.adapter.documentCaptureState(ordinary.record.ids.resultId)).toBeUndefined();
});

it('refuses symlink, parent escape, missing dependency and file limits without replacing failed capture on restart', async () => {
  const f = fixture();
  writeFileSync(join(f.directory, 'secret.tex'), 'Private host secret');
  symlinkSync(join(f.directory, 'secret.tex'), join(f.cwd, 'report.tex'));
  await f.adapter.captureCompleted(f.completion);
  expect(f.adapter.documentAvailable(f.record.ids.resultId)).toBe(false);
  rmSync(join(f.cwd, 'report.tex'));
  writeFileSync(join(f.cwd, 'report.tex'), 'Later benign file');
  await f.restart();
  await f.adapter.captureCompleted(f.completion);
  await expect(f.adapter.describe(f.record.ids.resultId)).rejects.toThrow(/no captured report/);
  writeFileSync(join(f.cwd, 'report.tex'), '\\input{../../secret}');
  expect(() => captureHostDocumentFiles(f.cwd, ['report.tex'])).toThrow();
  writeFileSync(join(f.cwd, 'report.tex'), '\\input{missing}');
  expect(() => captureHostDocumentFiles(f.cwd, ['report.tex'])).toThrow();
  writeFileSync(join(f.cwd, 'report.tex'), 'X'.repeat(8 * 1024 ** 2 + 1));
  expect(() => captureHostDocumentFiles(f.cwd, ['report.tex'])).toThrow();
  symlinkSync(f.directory, join(f.cwd, 'elsewhere'));
  expect(() => captureHostDocumentFiles(f.cwd, ['elsewhere/secret.tex'])).toThrow();
});

it('exact result/native session and owner workspace bindings cannot be replaced or broadened', async () => {
  const f = fixture();
  writeFileSync(join(f.cwd, 'report.tex'), 'Exact report');
  await f.adapter.captureCompleted({
    ...f.completion,
    request: {
      ...f.completion.request,
      context: groupContextSchema.parse({
        ...f.completion.request.context,
        sessionId: randomUUID(),
      }),
    },
  });
  expect(f.adapter.documentAvailable(f.record.ids.resultId)).toBe(false);
  await f.adapter.captureCompleted(f.completion);
  f.project();
  const manifest = await f.adapter.describe(f.record.ids.resultId);
  await expect(
    f.adapter.export({
      key: randomUUID(),
      manifest: {
        ...manifest,
        nativeContext: { ...manifest.nativeContext, nativeSessionId: randomUUID() },
      },
      artifactIds: manifest.files.map((file) => file.artifactId),
      limits: { bytes: 8 * 1024 ** 2, timeoutMs: 5000 },
    }),
  ).rejects.toThrow(/selection/);
  expect(
    hostDocumentResultNames(
      `[Exact](${join(f.cwd, 'report.tex')}) [Host](${join(f.directory, 'secret.tex')}) [Remote](https://example.test/report.pdf)`,
      f.cwd,
    ),
  ).toEqual(['report.tex']);
  const privateWork = fixture();
  writeFileSync(join(privateWork.cwd, 'report.tex'), 'private');
  await privateWork.adapter.captureCompleted({
    ...privateWork.completion,
    request: { ...privateWork.completion.request, intent: 'ask' },
  });
  expect(privateWork.adapter.documentAvailable(privateWork.record.ids.resultId)).toBe(false);
});

it('reuses explicit scoped grants with immutable source/PDF and reports unavailable host compilation', async () => {
  const f = fixture('[Report](report.tex) [PDF](report.pdf)');
  writeFileSync(
    join(f.cwd, 'report.tex'),
    '\\documentclass{article}\\begin{document}Exact\\end{document}',
  );
  writeFileSync(join(f.cwd, 'report.pdf'), '%PDF-1.4\nfixture only');
  await f.adapter.captureCompleted(f.completion);
  f.project();
  const documents = new GroupDocuments(
    join(f.directory, 'documents.sqlite'),
    join(f.directory, 'reading'),
    f.authority,
    f.adapter,
  );
  try {
    const offer = await documents.offer(f.handle, f.record.ids.resultId);
    const entry = offer.files.find((file) => file.kind === 'tex')!;
    const granted = await documents.grant(f.handle, {
      key: randomUUID(),
      offer: offer.handle,
      entry: entry.handle,
      dependencies: [],
    });
    await expect(
      documents.build(f.handle, granted.grantId, granted.version, { key: randomUUID() }),
    ).rejects.toThrow(/confined|unavailable/);
    const pdf = await documents.grant(f.handle, {
      key: randomUUID(),
      offer: offer.handle,
      entry: offer.files.find((file) => file.kind === 'pdf')!.handle,
      dependencies: [],
    });
    expect((await documents.pdf(f.handle, pdf.grantId, pdf.version)).toString()).toContain('%PDF');
    await expect(documents.offer(randomUUID(), f.record.ids.resultId)).rejects.toThrow(
      /unavailable/,
    );
    expect(groupDocumentVersion(await f.adapter.describe(f.record.ids.resultId))).toBe(
      granted.version,
    );
  } finally {
    await documents.close();
  }
});
