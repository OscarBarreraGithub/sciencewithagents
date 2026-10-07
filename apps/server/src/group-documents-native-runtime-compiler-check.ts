/** Root-operated public-image acceptance fixture. Never registered as a browser route or
 * production export. No provider/model/account launch. Invoke only after exact image review. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { GROUP_DOCUMENT_LIMITS as limits } from '@dock/shared/dist/group-documents.js';
import {
  GroupContainer,
  GroupDockerEngine,
  groupContainerSourceDigest,
  type GroupContainerPlan,
} from './group-container.js';
import {
  runGroupDocumentGuest,
  GroupDocumentGuestDenied,
} from './group-documents-native-runtime-process.js';
import { buildGroupDocumentReading } from './group-documents-reading.js';
const sha = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const source = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Public compiler fixture. \input{chapter}
\ifnum\pdfshellescape=0\else\errmessage{Shell escape enabled}\fi
\begin{equation}\label{eq:sum}
\begin{aligned}
S &= a+b \\
  &\quad +c.
\end{aligned}
\end{equation}
\end{document}`;
export async function checkGroupDocumentCompilerImage(image: string, directory: string) {
  z.string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(image);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid!()
  )
    throw new Error('Private fixture directory required.');
  const engine = new GroupDockerEngine();
  if ((await engine.availability(image)).state !== 'ready')
    throw new Error('Exact reviewed public image unavailable.');
  const evidence = join(directory, 'compiler-receipts.jsonl'),
    volumes: string[] = [];
  const record = (kind: string, detail: Record<string, string>) =>
    appendFileSync(
      evidence,
      JSON.stringify({ kind, detail, image, sourceDigest: groupContainerSourceDigest() }) + '\n',
      { mode: 0o600 },
    );
  async function compile(entry: string, contents: Record<string, string>, ambient = false) {
    const operation = randomUUID(),
      state = join(directory, operation);
    mkdirSync(state, { mode: 0o700 });
    const plan: GroupContainerPlan = {
      context: {
        groupId: randomUUID(),
        memberId: randomUUID(),
        installationId: randomUUID(),
        contextId: randomUUID(),
        visibility: 'private',
      },
      image,
      workspace: null,
      reads: [],
      outbound: [],
      expiresAt: Date.now() + limits.buildMs,
      cpuCores: 1,
      memoryMb: 768,
    };
    const guest = new GroupContainer(
      engine,
      plan,
      () => {
        if (Date.now() >= plan.expiresAt) throw new Error('Fixture expired.');
      },
      state,
      record,
    );
    record('compiler-fixture-intent', { operation, entry });
    try {
      await guest.start();
      volumes.push(guest.volume);
      if (ambient)
        await guest.nativeJson([
          '/usr/bin/python3',
          '-I',
          '-B',
          '-c',
          "from pathlib import Path; import json; Path('/home/agent/workspace/ambient.tex').write_text('Ambient bytes must not compile'); print(json.dumps({'state':'fixture-ready'}))",
        ]);
      return await runGroupDocumentGuest(
        guest,
        'build',
        {
          entry,
          files: Object.entries(contents).map(([name, text]) => {
            const bytes = Buffer.from(text);
            return {
              name,
              bytes: bytes.length,
              sha256: sha(bytes),
              base64: bytes.toString('base64'),
            };
          }),
        },
        limits.buildMs,
        Math.ceil((limits.pdfBytes * 4) / 3) + 65536,
      );
    } finally {
      await guest.close();
      record('compiler-fixture-stopped', { operation, volume: guest.volume });
    }
  }
  const parsed = z
    .strictObject({
      state: z.literal('completed'),
      sha256: z.string(),
      bytes: z.number().int().min(5).max(limits.pdfBytes),
      base64: z.string(),
    })
    .parse(
      await compile('report.tex', {
        'report.tex': source,
        'chapter.tex': 'Exact approved dependency.',
      }),
    );
  const pdf = Buffer.from(parsed.base64, 'base64');
  if (
    sha(pdf) !== parsed.sha256 ||
    pdf.length !== parsed.bytes ||
    pdf.subarray(0, 5).toString() !== '%PDF-'
  )
    throw new Error('Actual PDF failed attestation.');
  writeFileSync(join(directory, 'report.tex'), source, { mode: 0o600 });
  writeFileSync(join(directory, 'chapter.tex'), 'Exact approved dependency.', { mode: 0o600 });
  writeFileSync(join(directory, 'report.pdf'), pdf, { mode: 0o600 });
  let deniedDependency = false,
    deniedAmbient = false;
  try {
    await compile('report.tex', { 'report.tex': source });
  } catch (error) {
    if (!(error instanceof GroupDocumentGuestDenied) || error.reason !== 'compiler') throw error;
    deniedDependency = true;
  }
  try {
    await compile(
      'escape.tex',
      {
        'escape.tex': String.raw`\documentclass{article}\begin{document}\input{/home/agent/workspace/ambient.tex}\end{document}`,
      },
      true,
    );
  } catch (error) {
    if (!(error instanceof GroupDocumentGuestDenied) || error.reason !== 'compiler') throw error;
    deniedAmbient = true;
  }
  if (!deniedDependency || !deniedAmbient)
    throw new Error('Compiler accepted an ungranted dependency.');
  const assets = join(directory, 'assets');
  mkdirSync(assets, { mode: 0o700 });
  const reading = await buildGroupDocumentReading(join(directory, 'report.tex'), directory, assets);
  if (!JSON.stringify(reading).includes('Exact approved dependency'))
    throw new Error('Existing Reading omitted the approved dependency.');
  writeFileSync(join(directory, 'reading.json'), JSON.stringify(reading), { mode: 0o600 });
  const result = {
    image,
    sourceDigest: groupContainerSourceDigest(),
    sha256: parsed.sha256,
    bytes: pdf.length,
    deniedDependency,
    deniedAmbient,
    volumes,
    scope: 'public compiler fixture; real native result acceptance still required',
  };
  record('compiler-fixture-verified', { result: JSON.stringify(result) });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || !process.argv[3])
    throw new Error(
      'Usage: group-documents-native-runtime-compiler-check.ts sha256:<reviewed-image> <private-ignored-data-directory>',
    );
  console.log(
    JSON.stringify(
      await checkGroupDocumentCompilerImage(process.argv[2], resolve(process.argv[3])),
    ),
  );
}
