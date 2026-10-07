import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { LocalJobs, youtubeUrl } from './local-jobs.js';
import { localResourcesSchema } from '@dock/shared';

let root: string, store: Store, jobs: LocalJobs;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-local-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(async () => {
  await jobs?.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const request = () => ({
  key: randomUUID(),
  url: 'https://youtu.be/abcdefghijk',
  resources: localResourcesSchema.parse({}),
});
function fixture(hold = false, fail = false) {
  const model = join(root, 'model.bin');
  writeFileSync(model, 'fixture');
  const calls: { binary: string; args: string[]; controls: string[] }[] = [];
  let finish: () => void = () => {};
  jobs = new LocalJobs(store, root, {
    model,
    tools: {
      downloader: '/test/downloader',
      ffmpeg: '/test/ffmpeg',
      whisper: '/test/whisper',
      curl: '/test/curl',
    },
    process: (binary, args, cwd) => {
      if (fail) throw new Error('private process details must not reach a manager');
      const call = { binary, args, controls: [] as string[] };
      calls.push(call);
      if (binary === '/test/downloader') writeFileSync(join(cwd, 'audio.webm'), 'fixture audio');
      if (binary === '/test/ffmpeg') writeFileSync(join(cwd, 'converted.wav'), 'fixture wav');
      let resolve!: () => void;
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const complete = () => {
        if (binary === '/test/whisper')
          writeFileSync(join(cwd, 'transcript.txt'), 'A local transcript.');
        resolve();
      };
      if (binary === '/test/whisper' && hold) finish = complete;
      else queueMicrotask(complete);
      return {
        done,
        control: async (action) => {
          call.controls.push(action);
          if (action === 'cancel') resolve();
        },
        close: async () => {
          call.controls.push('close');
          resolve();
        },
      };
    },
  });
  return { calls, finish: () => finish() };
}
it('normalizes one public YouTube video and refuses browser-selected hosts, paths and playlists', () => {
  jobs = new LocalJobs(store, root);
  expect(youtubeUrl('https://youtu.be/abcdefghijk?t=40')).toBe(
    'https://www.youtube.com/watch?v=abcdefghijk',
  );
  for (const url of [
    'http://youtube.com/watch?v=abcdefghijk',
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://user:pass@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:8443/watch?v=abcdefghijk',
    'https://127.0.0.1/private',
    'https://youtube.com/playlist?list=x',
    'file:///tmp/a',
  ])
    expect(() => youtubeUrl(url)).toThrow();
  expect(() => jobs.create({ ...request(), binary: '/bin/sh' })).toThrow();
});
it('retains an idempotent local job, fixed argument stages, transcript and one manager report', async () => {
  const { calls } = fixture();
  const project = store.register(root, 'Transcription', '');
  const manager = store.agent(project.managerId);
  const input = request();
  const job = jobs.create(input, manager);
  expect(jobs.create(input, manager).id).toBe(job.id);
  expect(jobs.all()).toHaveLength(1);
  expect(() => jobs.create({ ...input, url: 'https://youtu.be/zzzzzzzzzzz' }, manager)).toThrow(
    'retry key',
  );
  await jobs.start(job.id);
  await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('completed'));
  expect(calls.map((c) => c.binary)).toEqual(['/test/downloader', '/test/ffmpeg', '/test/whisper']);
  expect(calls[0]!.args).toContain('--ignore-config');
  expect(calls[0]!.args).toContain('--no-plugin-dirs');
  expect(calls[2]!.args).toContain('-ng');
  expect((await jobs.read({ jobId: job.id }, manager)).text).toBe('A local transcript.');
  expect(store.runs()).toHaveLength(1);
  expect(store.runs()[0]!.kind).toBe('report');
  const other = store.register(join(root, 'other'), 'Other', '');
  await expect(jobs.read({ jobId: job.id }, store.agent(other.managerId))).rejects.toThrow(
    'another project',
  );
});
it('preempts only owned background local compute, retains memory and resumes the same process', async () => {
  const f = fixture(true);
  const job = jobs.create({ ...request(), resources: { priority: 'background' } });
  expect(jobs.hasYieldableBackground()).toBe(false);
  await jobs.start(job.id);
  await vi.waitFor(() => expect(jobs.get(job.id).phase).toBe('transcribing'));
  expect(jobs.hasYieldableBackground()).toBe(true);
  await jobs.yieldBackground();
  expect(jobs.hasYieldableBackground()).toBe(false);
  expect(jobs.get(job.id)).toMatchObject({ status: 'paused', autoPaused: true });
  expect(jobs.reservations()[0]).toMatchObject({ cpuCores: 0, memoryMb: 1024 });
  await jobs.start(job.id);
  expect(jobs.get(job.id).status).toBe('running');
  expect(f.calls[2]!.controls).toEqual(['pause', 'resume']);
  expect(f.calls).toHaveLength(3);
  f.finish();
  await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('completed'));
});
it('reorders queued manager jobs and yields existing owned compute without changing its resource reservation', async () => {
  const f = fixture(true);
  const project = store.register(root, 'Managed compute', '');
  const manager = store.agent(project.managerId);
  const managed = jobs.create({ ...request(), resources: { priority: 'normal' } }, manager);
  const direct = jobs.create({ ...request(), projectId: project.id });
  expect(jobs.candidates()[0]!.id).toBe(direct.id);
  await jobs.start(managed.id);
  await vi.waitFor(() => expect(jobs.get(managed.id).phase).toBe('transcribing'));
  const reservation = jobs.reservations()[0];
  store.setSetting(`quark:project:${project.id}`, { priority: 'background' });
  expect(jobs.reservations()[0]).toEqual(reservation);
  expect(
    jobs.status(project.id).jobs.find((job) => job.id === managed.id)?.resources.priority,
  ).toBe('background');
  expect(jobs.priority(jobs.get(direct.id))).toBe('interactive');
  await jobs.yieldBackground();
  expect(jobs.get(managed.id)).toMatchObject({ status: 'paused', autoPaused: true });
  expect(jobs.get(managed.id).resources.priority).toBe('normal'); // Keep the inherited choice.
  expect(jobs.reservations()[0]).toMatchObject({ cpuCores: 0, memoryMb: 1024 });
  expect(jobs.candidates().map((job) => job.id)).toEqual([direct.id, managed.id]);
  store.setSetting(`quark:project:${project.id}`, { priority: null });
  expect(jobs.priority(jobs.get(managed.id))).toBe('normal');
  await jobs.start(managed.id);
  expect(f.calls[2]!.controls).toEqual(['pause', 'resume']);
  f.finish();
  await vi.waitFor(() => expect(jobs.get(managed.id).status).toBe('completed'));
});
it('reports one sanitized failure to the requesting manager and retains the request receipt', async () => {
  fixture(false, true);
  const project = store.register(root, 'Transcription', '');
  const manager = store.agent(project.managerId),
    input = request();
  const job = jobs.create(input, manager);
  await jobs.start(job.id);
  await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('failed'));
  expect(jobs.create(input, manager).id).toBe(job.id);
  expect(store.runs()).toHaveLength(1);
  expect(store.runs()[0]).toMatchObject({ agentId: manager.id, kind: 'report' });
  expect(JSON.stringify(store.runs())).toContain('failed during downloading');
  expect(JSON.stringify(store.runs())).not.toContain('private process details');
});
it('reports cancellation once across a retried control receipt and stops the owned process', async () => {
  const f = fixture(true);
  const project = store.register(root, 'Transcription', '');
  const manager = store.agent(project.managerId);
  const job = jobs.create(request(), manager);
  await jobs.start(job.id);
  await vi.waitFor(() => expect(jobs.get(job.id).phase).toBe('transcribing'));
  const input = { key: randomUUID(), jobId: job.id, action: 'cancel' };
  await jobs.control(input);
  await jobs.control(input);
  expect(jobs.get(job.id).status).toBe('cancelled');
  expect(f.calls[2]!.controls).toEqual(['close']);
  expect(store.runs()).toHaveLength(1);
  expect(store.runs()[0]).toMatchObject({ agentId: manager.id, kind: 'report' });
  expect(JSON.stringify(store.runs())).toContain('cancelled during transcribing');
});
it('cancels its own process and restores interrupted jobs without starting another process', async () => {
  const f = fixture(true);
  const job = jobs.create(request());
  await jobs.start(job.id);
  await vi.waitFor(() => expect(jobs.get(job.id).phase).toBe('transcribing'));
  await jobs.close();
  expect(jobs.get(job.id).status).toBe('interrupted');
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  jobs = new LocalJobs(store, root);
  jobs.recover();
  expect(jobs.get(job.id).status).toBe('interrupted');
  expect(jobs.candidates()).toHaveLength(0);
  const retry = { key: randomUUID(), jobId: job.id, action: 'retry' };
  await jobs.control(retry);
  await jobs.control(retry);
  expect(jobs.get(job.id)).toMatchObject({ status: 'queued', attempt: 2 });
  expect(f.calls).toHaveLength(3);
});
it('does not consume the running-time limit while a background process is paused', async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  try {
    const f = fixture(true),
      job = jobs.create({ ...request(), resources: { priority: 'background' } });
    await jobs.start(job.id);
    await vi.waitFor(() => expect(jobs.get(job.id).phase).toBe('transcribing'));
    await jobs.yieldBackground();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 5000);
    expect(jobs.get(job.id).status).toBe('paused');
    expect(f.calls[2]!.controls).toEqual(['pause']);
    await jobs.start(job.id);
    f.finish();
    await vi.waitFor(() => expect(jobs.get(job.id).status).toBe('completed'));
  } finally {
    vi.useRealTimers();
  }
});
