import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { notebookLaunchScript } from './notebook-launch-page.js';

/** Executes the actual emitted browser script with a deterministic clock and fetch boundary. */
function launchFixture(
  statuses: number[],
  claim = { ok: true, path: '/notebooks/50593230/lab' },
  stalledClaim = false,
) {
  let now = 0;
  const message = { textContent: '' },
    retry = { hidden: true, onclick: () => {} };
  const paths: string[] = [],
    navigated: string[] = [],
    history: string[] = [];
  const timeouts: (() => void)[] = [];
  const context = {
    document: { getElementById: (id: string) => (id === 'message' ? message : retry) },
    location: { hash: '#one-use-fixture', replace: (path: string) => navigated.push(path) },
    history: {
      replaceState: (_value: unknown, _title: string, path: string) => history.push(path),
    },
    AbortController,
    Date: { now: () => now },
    setTimeout: (action: () => void, ms: number) => {
      if (ms === 15000) timeouts.push(action);
      if (ms <= 2000)
        queueMicrotask(() => {
          now += ms;
          action();
        });
      return 1;
    },
    clearTimeout: () => {},
    fetch: async (
      path: string,
      options?: { credentials?: string; body?: string; signal?: AbortSignal },
    ) => {
      paths.push(path);
      if (path === '/_gateway/claim') {
        expect(JSON.parse(options!.body!)).toEqual({ secret: 'one-use-fixture' });
        if (stalledClaim)
          await new Promise((_resolve, reject) =>
            options!.signal!.addEventListener('abort', () => reject(new Error('offline'))),
          );
        return { ok: claim.ok, json: async () => ({ path: claim.path }) };
      }
      expect(options?.credentials).toBe('same-origin');
      return { status: statuses.length > 1 ? statuses.shift()! : statuses[0] };
    },
  };
  runInNewContext(notebookLaunchScript, context);
  const finished = async () => {
    // All waits are microtasks; no real90-second sleep or server/browser lifecycle.
    for (let i = 0; i < 300; i++) await Promise.resolve();
  };
  return {
    message,
    retry,
    paths,
    navigated,
    history,
    finished,
    expireClaim: () => timeouts[0]?.(),
  };
}
it('ends the opening screen when the one-use claim loses its network response', async () => {
  const fixture = launchFixture([200], undefined, true);
  await fixture.finished();
  fixture.expireClaim();
  await fixture.finished();
  expect(fixture.navigated).toEqual([]);
  expect(fixture.paths).toEqual(['/_gateway/claim']);
  expect(fixture.message.textContent).toContain('connection failed');
  expect(fixture.retry.hidden).toBe(true);
});
it('holds the launch page through delayed upstream502/503 and then opens only its claimed Lab path', async () => {
  const fixture = launchFixture([502, 503, 200]);
  expect(fixture.history).toEqual(['/launch']);
  await fixture.finished();
  expect(fixture.paths).toEqual([
    '/_gateway/claim',
    ...Array(3).fill('/notebooks/50593230/api/status'),
  ]);
  expect(fixture.navigated).toEqual(['/notebooks/50593230/lab']);
  expect(fixture.retry.hidden).toBe(true);
});
it('stops immediately on session revocation instead of retrying the notebook or redirecting', async () => {
  for (const status of [401, 403]) {
    const fixture = launchFixture([502, status, 200]);
    await fixture.finished();
    expect(fixture.paths).toHaveLength(3);
    expect(fixture.navigated).toEqual([]);
    expect(fixture.message.textContent).toContain('closed or expired');
    expect(fixture.retry.hidden).toBe(true);
  }
});
it('offers an explicit retry after the90-second startup deadline without reusing the one-use handoff', async () => {
  const statuses = [503],
    fixture = launchFixture(statuses);
  await fixture.finished();
  expect(fixture.navigated).toEqual([]);
  expect(fixture.message.textContent).toContain('90 seconds');
  expect(fixture.retry.hidden).toBe(false);
  expect(fixture.paths).toHaveLength(46);
  statuses[0] = 200;
  fixture.retry.onclick();
  await fixture.finished();
  expect(fixture.navigated).toEqual(['/notebooks/50593230/lab']);
  expect(fixture.paths.filter((path) => path === '/_gateway/claim')).toHaveLength(1);
});
it('rejects a failed claim or a path outside the validated notebook prefix before polling', async () => {
  for (const claim of [
    { ok: false, path: '/notebooks/50593230/lab' },
    { ok: true, path: 'https://dock.example.test/api' },
  ]) {
    const fixture = launchFixture([200], claim);
    await fixture.finished();
    expect(fixture.paths).toEqual(['/_gateway/claim']);
    expect(fixture.navigated).toEqual([]);
    expect(fixture.message.textContent).toContain('link expired');
  }
});
