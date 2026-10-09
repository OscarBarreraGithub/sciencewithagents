import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NativeClient } from './native-terminal-driver.js';

const mocked = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), pty: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocked.execFile, spawn: mocked.spawn }));
vi.mock('node-pty', () => ({ spawn: mocked.pty }));
vi.mock('node:fs', async (load) => ({
  ...(await load<typeof import('node:fs')>()),
  realpathSync: (path: string) => path,
  lstatSync: () => ({
    isSocket: () => true,
    uid: BigInt(process.getuid?.() ?? -1),
    dev: 1n,
    ino: 2n,
    birthtimeNs: 3n,
  }),
}));
import { NativeCliDriver } from './native-terminal-driver.js';
import type { NativeConnectionProfile } from './native-connections-config.js';

class Child extends EventEmitter {
  stdout = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  kill = vi.fn(() => {
    this.emit('exit', 1);
    return true;
  });
}
const profile: NativeConnectionProfile = {
  id: 'c1a8a2f0-d05b-46f2-b87d-a89fb2132aef',
  label: 'Disposable native fixture',
  kind: 'tmux',
  socket: '/private-fixture/native.sock',
};
const metadata = (pane: string, windowActive: number, paneActive: number) =>
  `42\t10\t$0\t11\t${pane}\t43\tNative session\t${windowActive}\t${paneActive}`;
let lines: string, version: string, child: Child, driver: NativeCliDriver;
let loaded: () => void;
const clients: NativeClient[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  lines = [metadata('%0', 0, 1), metadata('%1', 1, 0), metadata('%2', 1, 1)].join('\n');
  version = 'tmux 3.6a';
  loaded = () => {};
  child = new Child();
  driver = new NativeCliDriver();
  mocked.spawn.mockReturnValue(child);
  mocked.pty.mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  });
  mocked.execFile.mockImplementation((program: string, args: string[], _options, callback) => {
    let result = '';
    if (args.includes('-V')) result = version;
    else if (args.includes('list-panes')) result = lines;
    else if (args.includes('load-buffer')) loaded();
    else if (program === 'cat' && args[0] === '/proc/42/stat')
      result = `42 (native) ${Array(20).fill('1').join(' ')}`;
    else if (program === 'cat') result = 'eab85088-8caa-4bb2-a1a2-1c087a74c2a5';
    else if (program === 'lsof') result = 'p42\n';
    else if (args.includes('--version')) result = 'herdr 0.9.3';
    else if (args.includes('schema')) result = '{"schemas":{}}';
    else if (args.includes('list'))
      result = JSON.stringify({
        result: {
          type: 'pane_list',
          panes: [{ pane_id: 'p1', terminal_id: 't1', agent_status: 'idle' }],
        },
      });
    queueMicrotask(() => callback(null, result));
    return { stdin: Object.assign(new EventEmitter(), { end: vi.fn() }) };
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
it('issues one active target per tmux session and attaches by session without selecting another window or pane', async () => {
  const discovery = await driver.discover(profile);
  expect(discovery.targets).toHaveLength(1);
  const target = discovery.targets[0]!;
  expect(target.proof.pane).toBe('%2');
  expect(target.view.label).toBe('Native session');
  const format = mocked.execFile.mock.calls.find((call) => call[1].includes('list-panes'))![1];
  expect(format.at(-1)).toContain('#{window_active}\t#{pane_active}');
  clients.push(await driver.open(profile, target.proof, 'observe', false));
  const args = mocked.pty.mock.calls[0]![1];
  expect(args).toEqual([
    '-N',
    '-S',
    profile.socket,
    'attach-session',
    '-r',
    '-f',
    'ignore-size',
    '-t',
    '$0',
  ]);
  expect(args).not.toContain('%2');
  expect(args).not.toContain('-d');
});
it('makes tmux older than 3.2 visibly unsupported for both observation and control', async () => {
  version = 'tmux 3.1c';
  const discovery = await driver.discover(profile);
  expect(discovery.state).toBe('unsupported');
  expect(discovery.message).toContain('resizing');
  expect(discovery.targets).toEqual([]);
  expect(mocked.pty).not.toHaveBeenCalled();
});
it('refuses a saved prompt when the session active pane changes before handoff', async () => {
  const target = (await driver.discover(profile)).targets[0]!;
  const client = await driver.open(profile, target.proof, 'control', false);
  clients.push(client);
  loaded = () => {
    lines = metadata('%3', 1, 1);
  };
  await expect(driver.submit(profile, target.proof, client, 'exact owner text')).rejects.toThrow(
    'changed',
  );
  expect(mocked.execFile.mock.calls.some((call) => call[1].includes('if-shell'))).toBe(false);
  expect(mocked.execFile.mock.calls.some((call) => call[1].includes('delete-buffer'))).toBe(true);
});
it('guards the native paste against active-pane changes atomically in the exact session context', async () => {
  const target = (await driver.discover(profile)).targets[0]!;
  const client = await driver.open(profile, target.proof, 'control', false);
  clients.push(client);
  expect(await driver.submit(profile, target.proof, client, 'exact owner text')).toBe('delivered');
  const args = mocked.execFile.mock.calls.find((call) =>
    call[1].includes('if-shell'),
  )![1] as string[];
  expect(args.slice(3, 7)).toEqual(['if-shell', '-F', '-t', '$0']);
  expect(args[7]).toContain('#{==:#{pane_id},%2}');
  expect(args[7]).toContain('#{==:#{session_id},$0}');
  expect(args[8]).toMatch(/paste-buffer .* -t %2 ; send-keys -t %2 Enter/);
});
const frame = (seq: number, full: boolean, text: string) =>
  JSON.stringify({
    type: 'terminal.frame',
    seq,
    encoding: 'ansi',
    width: 80,
    height: 24,
    full,
    bytes: Buffer.from(text).toString('base64'),
  }) + '\n';
async function opening() {
  const herdr = { ...profile, kind: 'herdr' as const };
  const proof = (await driver.discover(herdr)).targets[0]!.proof;
  const result = driver.open(herdr, proof, 'observe', false);
  await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalledOnce());
  return { result };
}
it('preserves the full Herdr startup screen followed by busy partial updates until the first subscriber', async () => {
  const { result } = await opening();
  child.stdout.emit(
    'data',
    Buffer.from(frame(1, true, '\x1b[2Jfull-screen') + frame(2, false, '-update-one')),
  );
  const client = await result;
  clients.push(client);
  child.stdout.emit('data', Buffer.from(frame(3, false, '-update-two')));
  const output = vi.fn();
  client.onOutput(output);
  expect(output).toHaveBeenCalledExactlyOnceWith('\x1b[2Jfull-screen-update-one-update-two');
  const later = vi.fn();
  client.onOutput(later);
  expect(later).not.toHaveBeenCalled();
  child.stdout.emit('data', Buffer.from(frame(4, false, '-live')));
  expect(output).toHaveBeenLastCalledWith('-live');
  expect(later).toHaveBeenCalledExactlyOnceWith('-live');
});
it('replaces startup output with a newer full Herdr frame before subscription', async () => {
  const { result } = await opening();
  child.stdout.emit(
    'data',
    Buffer.from(frame(1, true, 'old') + frame(2, false, '-old-update') + frame(3, true, 'new')),
  );
  const client = await result;
  clients.push(client);
  const output = vi.fn();
  client.onOutput(output);
  expect(output).toHaveBeenCalledExactlyOnceWith('new');
});
it.each([
  ['missing initial full screen', [frame(1, false, 'partial')]],
  ['missing partial update', [frame(1, true, 'full'), frame(3, false, 'gap')]],
  [
    'startup output overflow',
    [frame(1, true, 'a'.repeat(900_000)), frame(2, false, 'b'.repeat(200_000))],
  ],
])('refuses broken Herdr startup: %s without retaining a replay screen', async (_label, frames) => {
  const { result } = await opening();
  const refusal = expect(result).rejects.toThrow('startup screen');
  for (const value of frames) child.stdout.emit('data', Buffer.from(value));
  await refusal;
  expect(child.kill).toHaveBeenCalledOnce();
});
