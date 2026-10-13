// Owned local Worker + compiled branch main. No Runtime, demo, provider or browser launch.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGroupsServices } from '../apps/server/dist/groups-services.js';
const repository = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(process.env.DOCK_DATA_DIR);
if (base !== resolve(repository, 'data/groups-only-browser/installation'))
  throw new Error('Use only the owned Groups-only browser fixture directory');
mkdirSync(base, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(base, 'run-'));
writeFileSync(join(base, 'active.json'), JSON.stringify({ root }), { mode: 0o600 });
const socket = createServer();
await new Promise((done) => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise((done) => socket.close(done));
const setup = randomBytes(32).toString('hex');
const worker = spawn(
  process.execPath,
  [
    join(repository, 'apps/group-service/node_modules/wrangler/bin/wrangler.js'),
    'dev',
    '--local',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--inspector-port',
    '0',
    '--persist-to',
    join(root, 'worker'),
    '--var',
    'HOSTING_MODE:local-test',
    '--var',
    `GROUP_SETUP_HASH:${createHash('sha256').update(`dock-group-setup-v1:${setup}`).digest('hex')}`,
    '--log-level',
    'error',
  ],
  {
    cwd: join(repository, 'apps/group-service'),
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      XDG_CONFIG_HOME: join(root, 'worker-config'),
      WRANGLER_LOG_PATH: join(root, 'worker.log'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
worker.stdout.resume();
worker.stderr.resume();
let app;
let services;
let closing;
async function stopChild(child, pipe = false) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((done) => child.once('exit', done));
  if (pipe) child.stdin.end();
  else child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      ended,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Owned fixture child did not close within five seconds'));
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function close() {
  return (closing ??= (async () => {
    const errors = [];
    for (const action of [
      () => stopChild(app, true),
      () => services?.close(),
      () => stopChild(worker),
    ]) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Owned browser fixture cleanup failed');
  })());
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => void close().then(() => process.exit(0)));
try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (worker.exitCode !== null) throw new Error('Owned Worker exited');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/create`, {
        method: 'POST',
        signal: AbortSignal.timeout(300),
      });
      if ([400, 403].includes(response.status)) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error('Owned Worker could not start');
  services = await createGroupsServices(root, {
    summarize: async () => {
      throw new Error('Provider calls prohibited in browser fixture');
    },
  });
  writeFileSync(
    join(services.host.directory, 'service.json'),
    JSON.stringify({
      version: 1,
      mode: 'local-test',
      endpoint: `http://127.0.0.1:${port}/`,
      endpointId: randomUUID(),
      setupCapability: setup,
    }),
    { mode: 0o600 },
  );
  if (!(await services.host.list()).groups.length) {
    const created = await services.host.create({
      key: randomUUID(),
      projectName: 'Groups-only preview',
      displayName: 'Researcher',
    });
    for (const text of [
      'Welcome to the shared conversation.',
      'Human reading and messages need no model call.',
      'Drafts stay local until you choose Send.',
    ])
      await services.host.send({ handle: created.shared.handle, key: randomUUID(), text });
  }
  await services.close();
  services = undefined;
  app = spawn(process.execPath, [join(repository, 'apps/server/dist/main.js')], {
    cwd: repository,
    env: { ...process.env, DOCK_DATA_DIR: root, DOCK_LAUNCHER_LIFETIME: '1' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  app.once('exit', (code) => void close().then(() => process.exit(code ?? 1)));
} catch (error) {
  await close();
  console.error(error.message);
  process.exitCode = 1;
}
