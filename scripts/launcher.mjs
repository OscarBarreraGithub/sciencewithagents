/** Private macOS app helper. It launches the existing server, not another task runtime. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { readFile, writeFile, mkdir, open, rename, unlink, chmod } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const ownScript = fileURLToPath(import.meta.url);
// Parent identity, not account/configuration: keep in sync with claude-session.ts.
// Verified against Claude Code 2.1.293 and https://code.claude.com/docs/en/env-vars.
function independentClaudeEnvironment(source) {
  const env = { ...source };
  for (const name of [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_PID',
    'CLAUDE_CODE_SSE_PORT',
  ])
    delete env[name];
  if (['claude-vscode', 'claude-desktop', 'claude-desktop-3p'].includes(env.CLAUDE_CODE_ENTRYPOINT))
    delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}
const explanations = {
  occupied:
    'Another app or a different sciencewithagents installation is using this address. Nothing was stopped. Ask your setup agent to resolve the conflict, then try again.',
  starting:
    'sciencewithagents is still starting. Wait a moment and open the app again. Your saved conversations have not been removed.',
  failed:
    'sciencewithagents could not start. Your saved work is retained. Ask your setup agent to inspect the private launcher log, then try again.',
  ownership:
    'The running process could not be confirmed as this app’s own server. Nothing was stopped. Ask your setup agent to check it.',
  configuration:
    'This launcher needs setup again. Ask your setup agent to rebuild it for the current sciencewithagents folder and Node installation.',
};

async function configAt(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (
    config.version !== 1 ||
    !['root', 'dataDir', 'nodePath'].every(
      (key) => typeof config[key] === 'string' && isAbsolute(config[key]),
    ) ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    (config.codexPath !== null &&
      (typeof config.codexPath !== 'string' || !isAbsolute(config.codexPath))) ||
    (config.cloudflaredPath !== undefined &&
      config.cloudflaredPath !== null &&
      (typeof config.cloudflaredPath !== 'string' ||
        !isAbsolute(config.cloudflaredPath) ||
        config.cloudflaredPath.includes('\0'))) ||
    (config.toolPaths !== undefined &&
      (!Array.isArray(config.toolPaths) ||
        config.toolPaths.length > 8 ||
        config.toolPaths.some(
          (path) =>
            typeof path !== 'string' ||
            !isAbsolute(path) ||
            path.includes('\0') ||
            path.includes(delimiter),
        ))) ||
    (config.claudePath !== undefined &&
      config.claudePath !== null &&
      (typeof config.claudePath !== 'string' ||
        !isAbsolute(config.claudePath) ||
        config.claudePath.includes('\0')))
  )
    throw new Error('configuration');
  return {
    ...config,
    instanceId: createHash('sha256').update(resolve(config.dataDir)).digest('hex'),
    stateDir: join(config.dataDir, 'launcher'),
    path: resolve(path),
  };
}

const transientProbeError = (error) => ['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error.code);

function probe(config) {
  return new Promise((done) => {
    let finished = false;
    const finish = (value) => {
      if (!finished) {
        finished = true;
        done(value);
      }
    };
    const req = request(
      { host: '127.0.0.1', port: config.port, path: '/api/host-info', method: 'GET' },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 8192) {
            finish('occupied');
            req.destroy();
          }
        });
        response.on('end', () => {
          try {
            const value = JSON.parse(body);
            const matches = value.instanceId === config.instanceId && value.protocolVersion === 1;
            finish(
              matches && response.statusCode === 200
                ? 'ready'
                : matches && response.statusCode === 503 && value.code === 'APP_NOT_READY'
                  ? 'starting'
                  : 'occupied',
            );
          } catch {
            finish('occupied');
          }
        });
        response.on('error', (error) =>
          finish(transientProbeError(error) ? 'starting' : 'occupied'),
        );
      },
    );
    req.setTimeout(800, () => {
      // A slow response does not establish another installation's identity.
      finish('starting');
      req.destroy();
    });
    req.on('error', (error) =>
      finish(
        error.code === 'ECONNREFUSED'
          ? 'absent'
          : transientProbeError(error)
            ? 'starting'
            : 'occupied',
      ),
    );
    req.end();
  });
}

async function fingerprint(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], {
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C' },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
async function readState(config) {
  try {
    return JSON.parse(await readFile(join(config.stateDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}
async function writeState(config, state) {
  const temporary = join(config.stateDir, `${state.nonce}.next`);
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, join(config.stateDir, 'owner.json'));
}
async function sameOwner(config, state, parentPid) {
  return Boolean(
    state &&
      state.instanceId === config.instanceId &&
      state.parentPid === parentPid &&
      state.parentFingerprint === (await fingerprint(parentPid)) &&
      state.supervisorFingerprint === (await fingerprint(state.supervisorPid)),
  );
}
async function claim(config, state) {
  const lockPath = join(config.stateDir, 'supervisor.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(state));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try {
        previous = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        return false;
      } // A new lock may still be completing its first write.
      if (
        !previous.supervisorFingerprint ||
        (await fingerprint(previous.supervisorPid)) === previous.supervisorFingerprint
      )
        return false;
      // Preserve the stale receipt; never remove an unrecognised live process or lock.
      await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
    }
  }
  return false;
}

async function supervise(config, parentPid) {
  const parentFingerprint = await fingerprint(parentPid);
  if (!parentFingerprint) return;
  const state = {
    version: 1,
    instanceId: config.instanceId,
    nonce: randomUUID(),
    parentPid,
    parentFingerprint,
    supervisorPid: process.pid,
    supervisorFingerprint: await fingerprint(process.pid),
    serverPid: null,
    status: 'starting',
  };
  if (!(await claim(config, state))) return;
  let server,
    exited,
    monitor,
    stopping = false;
  const clean = async () => {
    clearInterval(monitor);
    const current = await readState(config);
    if (current?.nonce === state.nonce) {
      await writeState(config, { ...state, status: 'stopped', serverPid: null });
    }
    try {
      const lock = JSON.parse(await readFile(join(config.stateDir, 'supervisor.lock'), 'utf8'));
      if (lock.nonce === state.nonce) await unlink(join(config.stateDir, 'supervisor.lock'));
    } catch {
      /* A replacement's lock is never removed. */
    }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
      }, 10_000);
      await exited;
      clearTimeout(timer);
    }
    await clean();
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  try {
    if ((await probe(config)) !== 'absent') return;
    if (stopping) return;
    const log = await open(join(config.stateDir, 'server.log'), 'a', 0o600);
    await chmod(join(config.stateDir, 'server.log'), 0o600);
    const env = {
      ...independentClaudeEnvironment(process.env),
      DOCK_DATA_DIR: config.dataDir,
      DOCK_PORT: String(config.port),
      DOCK_LAUNCHER_LIFETIME: '1',
      PATH: [
        dirname(config.nodePath),
        ...(config.codexPath ? [dirname(config.codexPath)] : []),
        ...(config.claudePath ? [dirname(config.claudePath)] : []),
        ...(config.toolPaths ?? []),
        ...(process.platform === 'darwin'
          ? ['/opt/homebrew/bin', '/usr/local/bin']
          : ['/usr/local/bin']),
        join(homedir(), '.local/bin'),
        process.env.PATH ?? '/usr/bin:/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(delimiter),
    };
    if (config.codexPath) env.DOCK_CODEX_BIN = config.codexPath;
    if (config.claudePath) env.DOCK_CLAUDE_BIN = config.claudePath;
    if (config.cloudflaredPath) env.DOCK_CLOUDFLARED_BIN = config.cloudflaredPath;
    try {
      if (stopping) return;
      server = spawn(config.nodePath, [join(config.root, 'apps/server/dist/main.js')], {
        cwd: config.root,
        env,
        stdio: ['pipe', log.fd, log.fd],
      });
      exited = new Promise((done) => {
        server.once('exit', done);
        server.once('error', done);
      });
      server.stdin.on('error', () => {});
      await new Promise((done, fail) => {
        server.once('spawn', done);
        server.once('error', fail);
      });
    } finally {
      await log.close();
    }
    state.serverPid = server.pid;
    state.status = 'running';
    await writeState(config, state);
    let checking = false;
    monitor = setInterval(() => {
      if (checking || stopping) return;
      checking = true;
      void fingerprint(parentPid)
        .then((current) => {
          if (current !== parentFingerprint) return stop();
        })
        .finally(() => {
          checking = false;
        });
    }, 1500);
    await exited;
  } finally {
    await stop();
  }
}

async function launch(config, parentPid, noOpen) {
  const first = await probe(config);
  if (first === 'occupied') throw new Error('occupied');
  if (first !== 'ready') {
    const previousNonce = (await readState(config))?.nonce;
    if (first === 'absent') {
      const child = spawn(
        config.nodePath,
        [ownScript, 'supervise', '--config', config.path, '--parent', String(parentPid)],
        { detached: true, stdio: 'ignore', cwd: config.root },
      );
      await new Promise((done, fail) => {
        child.once('spawn', done);
        child.once('error', fail);
      });
      child.unref();
    }
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await pause(500);
      const status = await probe(config);
      if (status === 'ready') {
        ready = true;
        break;
      }
      if (status === 'occupied') throw new Error('occupied');
      const state = await readState(config);
      if (state?.status === 'stopped' && state.nonce !== previousNonce) throw new Error('failed');
    }
    if (!ready) throw new Error('starting');
  }
  if (!noOpen) {
    const { prepareBrowserHandoff } = await import(
      pathToFileURL(join(config.root, 'apps/server/dist/local-browser-handoff.js')).href
    );
    const target = await prepareBrowserHandoff(config.dataDir, config.port);
    await exec('/usr/bin/open', [target ?? `http://127.0.0.1:${config.port}`], { timeout: 5000 });
  }
  return (await sameOwner(config, await readState(config), parentPid)) ? 'owned' : 'existing';
}

async function stopOwned(config, parentPid) {
  const state = await readState(config);
  if (!state || state.status === 'stopped') return 'stopped';
  if (state.parentPid !== parentPid) return 'existing';
  if (!(await sameOwner(config, state, parentPid))) throw new Error('ownership');
  process.kill(state.supervisorPid, 'SIGTERM');
  for (let count = 0; count < 60; count++) {
    if ((await fingerprint(state.supervisorPid)) !== state.supervisorFingerprint) return 'stopped';
    await pause(250);
  }
  throw new Error('starting');
}

const args = process.argv.slice(2),
  command = args[0];
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
try {
  const config = await configAt(option('--config'));
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const parentPid = Number(option('--parent') ?? process.ppid);
  if (!Number.isSafeInteger(parentPid) || parentPid < 2) throw new Error('configuration');
  if (command === 'supervise') await supervise(config, parentPid);
  else if (command === 'launch')
    process.stdout.write(await launch(config, parentPid, args.includes('--no-open')));
  else if (command === 'stop') process.stdout.write(await stopOwned(config, parentPid));
  else throw new Error('configuration');
} catch (error) {
  // AppleScript receives only this fixed vocabulary, never raw stderr or credentials.
  if (command !== 'supervise')
    process.stdout.write(`error:${explanations[error.message] ?? explanations.failed}`);
  else process.exitCode = 1;
}
