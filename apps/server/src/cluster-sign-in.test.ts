import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { ClusterMonitor, type ClusterRun } from './cluster.js';
import { ClusterSignIns, signInPrompt, type SignInTerminal } from './cluster-sign-in.js';
import { proxyPath } from './hosts.js';

class FakeTerminal implements SignInTerminal {
  writes: string[] = [];
  killed = false;
  private data: (data: string) => void = () => {};
  private exit: (exit: { exitCode: number }) => void = () => {};
  onData(listener: (data: string) => void) {
    this.data = listener;
  }
  onExit(listener: (exit: { exitCode: number }) => void) {
    this.exit = listener;
  }
  write(data: string) {
    this.writes.push(data);
  }
  kill() {
    this.killed = true;
  }
  print(text: string) {
    this.data(text);
  }
  finish(exitCode: number) {
    this.exit({ exitCode });
  }
}

let root: string, store: Store;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swa-cluster-sign-in-'));
  store = new Store(join(root, 'dock.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture({
  master = false,
  controlPath = '/home/person/.ssh/sockets/cluster',
  timeoutMs = 60_000,
} = {}) {
  const state = { master, hold: null as Promise<void> | null };
  const queries: string[][] = [];
  const cluster = new ClusterMonitor(store, async (args): Promise<ClusterRun> => {
    if (args[0] === '-O') await state.hold;
    if (args[0] === '-O')
      return state.master
        ? { code: 0, stdout: '', stderr: 'Master running (pid=4)', timedOut: false }
        : {
            code: 255,
            stdout: '',
            stderr: 'Control socket connect: No such file or directory',
            timedOut: false,
          };
    if (args[0] === '-G')
      return { code: 0, stdout: `controlpath ${controlPath}\n`, stderr: '', timedOut: false };
    queries.push(args);
    return { code: 255, stdout: '', stderr: 'Permission denied', timedOut: false };
  });
  cluster.save({
    key: randomUUID(),
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
  });
  const terminals: { args: string[]; terminal: FakeTerminal }[] = [];
  const signIns = new ClusterSignIns(
    cluster,
    (args) => {
      const terminal = new FakeTerminal();
      terminals.push({ args, terminal });
      return terminal;
    },
    timeoutMs,
  );
  return { cluster, signIns, terminals, state, queries };
}

it('labels native prompts without account names', () => {
  expect(signInPrompt('(person@login.example) Password: ')).toEqual({
    kind: 'password',
    label: 'Password:',
  });
  expect(signInPrompt('banner\r\n(person@login.example) VerificationCode: ')).toEqual({
    kind: 'code',
    label: 'VerificationCode:',
  });
  expect(
    signInPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? '),
  ).toEqual({
    kind: 'host-key',
  });
  expect(signInPrompt('Last login: today')).toBeNull();
});

it('types each answer once into native SSH and never retains it', async () => {
  const { signIns, terminals, state, queries } = fixture();
  const started = await signIns.start({ key: randomUUID() });
  expect(started.state).toBe('starting');
  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.args).toEqual([
    '-M',
    '-N',
    '-f',
    '-o',
    'BatchMode=no',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=20',
    '--',
    'hpc',
  ]);
  // A second tap joins the same sign-in instead of opening another terminal.
  expect((await signIns.start({ key: randomUUID() })).id).toBe(started.id);
  const terminal = terminals[0]!.terminal;
  terminal.print('(person@login.example) Pass');
  expect(signIns.status().state).toBe('starting');
  terminal.print('word: ');
  const password = signIns.status();
  expect(password).toMatchObject({
    state: 'prompt',
    prompt: { id: 1, kind: 'password', label: 'Password:' },
  });
  expect(JSON.stringify(password)).not.toContain('person');
  const secret = 'correct horse battery';
  signIns.respond({ id: started.id, promptId: 1, response: secret });
  // A lost response retried by the browser cannot type the password into the next prompt.
  signIns.respond({ id: started.id, promptId: 1, response: secret });
  expect(terminal.writes).toEqual([`${secret}\r`]);
  terminal.print('\r\n(person@login.example) VerificationCode: ');
  expect(signIns.status().prompt).toEqual({ id: 2, kind: 'code', label: 'VerificationCode:' });
  expect(() => signIns.respond({ id: started.id, promptId: 2, response: '12\n34' })).toThrow();
  signIns.respond({ id: started.id, promptId: 2, response: '246810' });
  state.master = true;
  terminal.finish(0);
  await settle();
  await settle();
  expect(signIns.status()).toMatchObject({ state: 'connected', prompt: null });
  // The restored sign-in triggers an immediate reading rather than waiting out backoff.
  expect(queries.length).toBeGreaterThan(0);
  const saved = JSON.stringify(
    ['settings', 'events', 'operations'].map((table) =>
      store.db.prepare(`SELECT * FROM ${table}`).all(),
    ),
  );
  for (const value of [secret, '246810']) {
    expect(saved).not.toContain(value);
    expect(JSON.stringify(signIns.status())).not.toContain(value);
  }
  expect(
    store.db
      .prepare("SELECT data FROM events WHERE type='cluster.sign_in'")
      .all()
      .map((row) => JSON.parse(String(row.data))),
  ).toEqual([{ state: 'connected' }]);
});

it('reports refused sign-ins, host-key prompts and timeouts without retrying', async () => {
  const refused = fixture();
  const first = await refused.signIns.start({ key: randomUUID() });
  refused.terminals[0]!.terminal.print(
    'person@login.example: Permission denied (keyboard-interactive).\r\n',
  );
  refused.terminals[0]!.terminal.finish(255);
  await settle();
  expect(refused.signIns.status()).toMatchObject({
    state: 'failed',
    message: 'Sign-in was not accepted. Check your password and code, then try again.',
  });
  expect(() => refused.signIns.respond({ id: first.id, promptId: 1, response: 'x' })).not.toThrow();
  expect(refused.terminals[0]!.terminal.writes).toEqual([]);

  const hostKey = fixture();
  await hostKey.signIns.start({ key: randomUUID() });
  hostKey.terminals[0]!.terminal.print(
    'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
  );
  expect(hostKey.signIns.status().state).toBe('failed');
  expect(hostKey.terminals[0]!.terminal.killed).toBe(true);
  expect(hostKey.terminals[0]!.terminal.writes).toEqual([]);

  const slow = fixture({ timeoutMs: 5 });
  await slow.signIns.start({ key: randomUUID() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slow.signIns.status().state).toBe('expired');
  expect(slow.terminals[0]!.terminal.killed).toBe(true);
});

it('reuses a running sign-in and needs a shared control socket', async () => {
  const running = fixture({ master: true });
  expect((await running.signIns.start({ key: randomUUID() })).state).toBe('connected');
  expect(running.terminals).toHaveLength(0);
  const unshared = fixture({ controlPath: 'none' });
  await expect(unshared.signIns.start({ key: randomUUID() })).rejects.toThrow('ControlMaster');
  expect(unshared.terminals).toHaveLength(0);
  // Every owner cluster route the panel uses reaches a selected worker computer, except
  // opening a notebook, whose tunnel only that computer's own browser can reach.
  for (const path of ['/cluster', '/cluster/sign-in', '/cluster/notebooks'])
    expect(proxyPath('GET', path)).toBe(`/api${path}`);
  for (const path of [
    '/cluster/settings',
    '/cluster/refresh',
    '/cluster/sign-in',
    '/cluster/sign-in/respond',
    '/cluster/sign-in/cancel',
    '/cluster/notebooks/close',
  ])
    expect(proxyPath('POST', path)).toBe(`/api${path}`);
  expect(proxyPath('POST', '/cluster/notebooks/open')).toBeNull();
});

const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const settings = (alias: string) => ({
  key: randomUUID(),
  settings: { enabled: true, alias, label: 'Lab cluster', accountingDays: 3 },
});

it('coalesces concurrent starts into one terminal bound to the alias being signed in', async () => {
  const { cluster, signIns, terminals, state } = fixture();
  const held = gate();
  state.hold = held.promise;
  const first = signIns.start({ key: randomUUID() });
  const second = signIns.start({ key: randomUUID() });
  held.open();
  const [a, b] = await Promise.all([first, second]);
  expect(a.id).toBe(b.id);
  expect(terminals).toHaveLength(1);

  // Changing the alias while a prompt waits ends it; no answer reaches the old terminal.
  state.hold = null;
  const terminal = terminals[0]!.terminal;
  terminal.print('(person@login.example) Password: ');
  cluster.save(settings('other-cluster'));
  expect(signIns.status()).toMatchObject({ state: 'cancelled', prompt: null });
  expect(terminal.killed).toBe(true);
  expect(() => signIns.respond({ id: a.id!, promptId: 1, response: 'secret-one' })).toThrow();
  expect(terminal.writes).toEqual([]);

  // A start whose settings change during its preflight never opens a terminal.
  const later = gate();
  state.hold = later.promise;
  const pending = signIns.start({ key: randomUUID() });
  cluster.save(settings('third-cluster'));
  later.open();
  await expect(pending).rejects.toThrow('settings changed');
  expect(terminals).toHaveLength(1);
  state.hold = null;
  const next = await signIns.start({ key: randomUUID() });
  expect(terminals).toHaveLength(2);
  expect(terminals[1]!.args.at(-1)).toBe('third-cluster');
  expect(next.state).toBe('starting');
});

it('keeps a sign-in cancelled when its exit check finishes afterwards', async () => {
  const { signIns, terminals, state, queries } = fixture();
  const started = await signIns.start({ key: randomUUID() });
  const terminal = terminals[0]!.terminal;
  terminal.print('(person@login.example) Password: ');
  signIns.respond({ id: started.id!, promptId: 1, response: 'secret-two' });
  const held = gate();
  state.hold = held.promise;
  state.master = true;
  terminal.finish(0);
  signIns.cancel({ id: started.id! });
  held.open();
  await settle();
  await settle();
  expect(signIns.status()).toMatchObject({ state: 'cancelled', message: 'Sign-in cancelled.' });
  // No reading was triggered on behalf of the cancelled attempt.
  expect(queries).toHaveLength(0);
  const saved = JSON.stringify(
    ['settings', 'events', 'operations'].map((table) =>
      store.db.prepare(`SELECT * FROM ${table}`).all(),
    ),
  );
  expect(saved).not.toContain('secret-two');
  expect(JSON.stringify(signIns.status())).not.toContain('secret-two');
});
