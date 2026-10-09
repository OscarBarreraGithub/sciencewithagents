import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
  symlinkSync,
  unlinkSync,
  renameSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { repoRoot } from './paths.js';
import { ownerAuthorization } from './local-access.js';

const exec = promisify(execFile);
const helper = join(repoRoot, 'scripts/launcher.mjs');
const builder = join(repoRoot, 'scripts/create-launcher.mjs');
const fixtures: {
  root: string;
  config: string;
  parent: ChildProcess;
  port: number;
  server?: ReturnType<typeof createServer>;
}[] = [];
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 60; count++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('The owned fixture did not reach its expected state.');
}
async function unusedPort() {
  const reservation = createTcpServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  return port;
}
async function fixture(realServer = false) {
  const root = mkdtempSync(join(tmpdir(), 'dock-launcher-test-'));
  const data = join(root, 'data'),
    config = join(data, 'launcher/config.json');
  mkdirSync(join(root, 'apps/server/dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'assets/branding'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'assets/branding/sciencewithagents.icns'),
    join(root, 'assets/branding/sciencewithagents.icns'),
  );
  copyFileSync(helper, join(root, 'scripts/launcher.mjs'));
  if (realServer) {
    copyFileSync(
      join(repoRoot, 'scripts/group-service-registry.mjs'),
      join(root, 'scripts/group-service-registry.mjs'),
    );
    cpSync(join(repoRoot, 'apps/server/dist'), join(root, 'apps/server/dist'), { recursive: true });
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'));
    symlinkSync(join(repoRoot, 'apps/server/node_modules'), join(root, 'apps/server/node_modules'));
  } else
    copyFileSync(
      join(repoRoot, 'apps/server/src/fixtures/launcher-server.mjs'),
      join(root, 'apps/server/dist/main.js'),
    );
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const port = await unusedPort();
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((done, fail) => {
    parent.once('spawn', () => done());
    parent.once('error', fail);
  });
  const value = { root, config, parent, port };
  fixtures.push(value);
  await exec(
    process.execPath,
    [builder, '--root', root, '--data', data, '--port', String(port), '--skip-compile'],
    { timeout: 10_000 },
  );
  return value;
}
async function command(
  value: Awaited<ReturnType<typeof fixture>>,
  operation: 'launch' | 'stop',
  env = process.env,
) {
  return (
    await exec(
      process.execPath,
      [
        helper,
        operation,
        '--config',
        value.config,
        '--parent',
        String(value.parent.pid),
        '--no-open',
      ],
      { timeout: 20_000, env },
    )
  ).stdout;
}
async function absent(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/host-info`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    if (value.parent.exitCode === null && value.parent.signalCode === null) {
      await command(value, 'stop').catch(() => {});
      value.parent.kill('SIGTERM');
    }
    await value.server?.close();
    await eventually(() => absent(value.port));
    rmSync(value.root, { recursive: true });
  }
});

describe('manual app launcher ownership', () => {
  it.each(['claude-vscode', 'claude-desktop', 'claude-desktop-3p', 'sdk-explicit'])(
    'starts an independent server from %s while preserving explicit native configuration',
    async (entrypoint) => {
      const value = await fixture();
      const markers = {
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'parent-fixture-session',
        CLAUDE_CODE_SESSION_ATTENDED: '1',
        CLAUDE_PID: '12345',
        CLAUDE_CODE_SSE_PORT: '12346',
      };
      const retained = {
        CLAUDE_CONFIG_DIR: '/fixture/explicit-profile',
        ANTHROPIC_MODEL: 'explicit-native-model',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CLAUDE_CODE_SHELL_PREFIX: 'fixture-hook-wrapper',
        CLAUDE_CODE_IDE_HOST_OVERRIDE: 'explicit-editor-host.invalid',
        ANTHROPIC_API_KEY: 'synthetic-fixture-key',
        ANTHROPIC_BASE_URL: 'https://fixture-routing.invalid',
        CLAUDE_CODE_USE_BEDROCK: '1',
        HTTPS_PROXY: 'https://fixture-proxy.invalid',
        DOCK_FIXTURE_CUSTOM: 'retained',
      };
      expect(
        await command(value, 'launch', {
          ...process.env,
          ...markers,
          ...retained,
          CLAUDE_CODE_ENTRYPOINT: entrypoint,
          DOCK_LAUNCHER_FIXTURE_ENV: '1',
        }),
      ).toBe('owned');
      const saved = JSON.parse(
        readFileSync(join(value.root, 'data/provider-environment.json'), 'utf8'),
      );
      expect(saved.independent).toEqual({
        ...Object.fromEntries(Object.keys(markers).map((name) => [name, null])),
        ...retained,
        CLAUDE_CODE_ENTRYPOINT: entrypoint === 'sdk-explicit' ? entrypoint : null,
      });
      expect(await command(value, 'stop')).toBe('stopped');
      await eventually(() => absent(value.port));
      expect(readFileSync(join(value.root, 'data/graceful-stop'), 'utf8')).toBe('yes');
    },
  );
  it('rebuilds a stopped moved launcher, retains its previous configuration and starts from the new folder', async () => {
    const value = await fixture();
    const oldRoot = value.root;
    const original = readFileSync(value.config, 'utf8');
    writeFileSync(join(oldRoot, 'data/retained.txt'), 'Saved work');
    renameSync(oldRoot, `${oldRoot}-moved`);
    value.root = `${oldRoot}-moved`;
    value.config = join(value.root, 'data/launcher/config.json');
    await exec(process.execPath, [
      builder,
      '--root',
      value.root,
      '--data',
      realpathSync(join(value.root, 'data')),
      '--port',
      String(value.port),
      '--skip-compile',
    ]);
    const config = JSON.parse(readFileSync(value.config, 'utf8'));
    expect(config.root).toBe(realpathSync(value.root));
    expect(config.dataDir).toBe(realpathSync(join(value.root, 'data')));
    expect(readFileSync(join(value.root, 'data/retained.txt'), 'utf8')).toBe('Saved work');
    const archive = readdirSync(dirname(value.config)).find((name) =>
      name.startsWith('before-move-'),
    )!;
    expect(JSON.parse(readFileSync(join(dirname(value.config), archive), 'utf8')).config).toEqual(
      JSON.parse(original),
    );
    expect(statSync(join(dirname(value.config), archive)).mode & 0o777).toBe(0o600);
    expect(await command(value, 'launch')).toBe('owned');
    expect(await command(value, 'stop')).toBe('stopped');
    await eventually(() => absent(value.port));
  });

  it.each(['existing source', 'live owner', 'live server', 'mismatched marker'])(
    'refuses a moved launcher with %s without replacing configuration or removing saved work',
    async (reason) => {
      const value = await fixture();
      const oldRoot = value.root;
      renameSync(oldRoot, `${oldRoot}-moved`);
      value.root = `${oldRoot}-moved`;
      value.config = join(value.root, 'data/launcher/config.json');
      const state = dirname(value.config);
      if (reason === 'existing source') mkdirSync(oldRoot);
      if (reason === 'live owner')
        writeFileSync(join(state, 'owner.json'), JSON.stringify({ parentPid: value.parent.pid }));
      if (reason === 'live server')
        writeFileSync(join(value.root, 'data/server.lock'), String(value.parent.pid));
      if (reason === 'mismatched marker') {
        const marker = JSON.parse(readFileSync(join(state, 'generated.json'), 'utf8'));
        writeFileSync(
          join(state, 'generated.json'),
          JSON.stringify({ ...marker, instanceId: 'wrong-installation' }),
        );
      }
      const config = readFileSync(value.config, 'utf8');
      const marker = readFileSync(join(state, 'generated.json'), 'utf8');
      try {
        await expect(
          exec(process.execPath, [
            builder,
            '--root',
            value.root,
            '--data',
            realpathSync(join(value.root, 'data')),
            '--skip-compile',
          ]),
        ).rejects.toThrow('Nothing was replaced');
        expect(readFileSync(value.config, 'utf8')).toBe(config);
        expect(readFileSync(join(state, 'generated.json'), 'utf8')).toBe(marker);
        expect(readdirSync(state).filter((name) => name.startsWith('before-move-'))).toEqual([]);
        expect(await absent(value.port)).toBe(true);
      } finally {
        if (reason === 'existing source') rmSync(oldRoot, { recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'compiles a native workspace link without accepting URL commands or starting the app',
    async () => {
      const value = await fixture();
      await exec(
        process.execPath,
        [
          builder,
          '--root',
          value.root,
          '--data',
          join(value.root, 'data'),
          '--port',
          String(value.port),
        ],
        { timeout: 30_000 },
      );
      const launcher = join(value.root, 'data/launcher');
      const info = join(launcher, 'sciencewithagents.app/Contents/Info.plist');
      expect(
        (
          await exec('/usr/libexec/PlistBuddy', [
            '-c',
            'Print :CFBundleURLTypes:0:CFBundleURLSchemes:0',
            info,
          ])
        ).stdout.trim(),
      ).toBe('sciencewithagents');
      const icon = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', info]);
      expect(icon.stdout.trim()).toBe('sciencewithagents.icns');
      await expect(
        exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconName', info]),
      ).rejects.toThrow();
      expect(
        readFileSync(
          join(launcher, 'sciencewithagents.app/Contents/Resources/sciencewithagents.icns'),
        ),
      ).toEqual(readFileSync(join(repoRoot, 'assets/branding/sciencewithagents.icns')));
      await exec('/usr/bin/codesign', [
        '--verify',
        '--strict',
        join(launcher, 'sciencewithagents.app'),
      ]);
      const source = readFileSync(join(launcher, 'Launcher.applescript'), 'utf8');
      expect(source).toContain('appURL is "sciencewithagents://open"');
      expect(source).not.toContain('do shell script appURL');
      expect(await absent(value.port)).toBe(true);
    },
  );

  it('keeps stable Node and Codex entries usable after their old installation targets are removed', async () => {
    const value = await fixture();
    const bin = join(value.root, 'upgrade-bin');
    mkdirSync(bin);
    const quote = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'";
    const nodeOne = join(value.root, 'node-one'),
      nodeTwo = join(value.root, 'node-two');
    for (const path of [nodeOne, nodeTwo])
      writeFileSync(path, '#!/bin/sh\nexec ' + quote(process.execPath) + ' "$@"\n', {
        mode: 0o700,
      });
    const codexOne = join(value.root, 'codex-one'),
      codexTwo = join(value.root, 'codex-two');
    for (const path of [codexOne, codexTwo])
      writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const node = join(bin, 'node'),
      codex = join(bin, 'codex');
    symlinkSync(nodeOne, node);
    symlinkSync(codexOne, codex);
    await exec(
      process.execPath,
      [
        builder,
        '--root',
        value.root,
        '--data',
        join(value.root, 'data'),
        '--port',
        String(value.port),
        '--node',
        node,
        '--codex',
        codex,
        '--skip-compile',
      ],
      { timeout: 10_000 },
    );
    const config = JSON.parse(readFileSync(value.config, 'utf8'));
    expect(config.nodePath).toBe(node);
    expect(config.codexPath).toBe(codex);
    unlinkSync(node);
    symlinkSync(nodeTwo, node);
    unlinkSync(nodeOne);
    unlinkSync(codex);
    symlinkSync(codexTwo, codex);
    unlinkSync(codexOne);
    expect(await command(value, 'launch', { ...process.env, PATH: '/usr/bin:/bin' })).toBe('owned');
    expect(await command(value, 'stop')).toBe('stopped');
  });

  it('discovers a stable Node alias and preserves host tools for a Finder-style environment', async () => {
    const value = await fixture();
    const bin = join(value.root, 'host-tools');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    for (const tool of ['gh', 'cloudflared'])
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin };
    delete env.DOCK_CODEX_BIN;
    delete env.DOCK_CLAUDE_BIN;
    delete env.DOCK_CLOUDFLARED_BIN;
    delete env.DOCK_GH_BIN;
    await exec(
      process.execPath,
      [
        builder,
        '--root',
        value.root,
        '--data',
        join(value.root, 'data'),
        '--port',
        String(value.port),
        '--skip-compile',
      ],
      { env, timeout: 10_000 },
    );
    const config = JSON.parse(readFileSync(value.config, 'utf8'));
    expect(config.nodePath).toBe(join(bin, 'node'));
    expect(config.cloudflaredPath).toBe(join(bin, 'cloudflared'));
    expect(config.toolPaths).toContain(bin);
    expect(await command(value, 'launch', { ...process.env, PATH: '/usr/bin:/bin' })).toBe('owned');
    const observed = JSON.parse(
      readFileSync(join(value.root, 'data/provider-environment.json'), 'utf8'),
    );
    expect(observed.cloudflaredPath).toBe(join(bin, 'cloudflared'));
    expect(observed.path.split(':')).toContain(bin);
    // Resolve the actual helper by name in precisely the server's environment.
    await exec('gh', ['--version'], { env: { PATH: observed.path }, timeout: 5000 });
    expect(await command(value, 'stop')).toBe('stopped');
  });

  it('invalid Node/Codex selections cannot overwrite a working launcher', async () => {
    const value = await fixture();
    const before = readFileSync(value.config, 'utf8');
    for (const selected of [
      ['--node', '/missing/node'],
      ['--codex', '/missing/codex'],
      ['--node', '--skip-compile'],
      ['--codex', 'relative/codex'],
    ]) {
      await expect(
        exec(
          process.execPath,
          [
            builder,
            '--root',
            value.root,
            '--data',
            join(value.root, 'data'),
            ...selected,
            '--skip-compile',
          ],
          { timeout: 10_000 },
        ),
      ).rejects.toThrow();
      expect(readFileSync(value.config, 'utf8')).toBe(before);
    }
  });

  it('preserves an auto-updating Claude entry and propagates it through a stripped GUI PATH', async () => {
    const value = await fixture();
    const bin = join(value.root, 'local-bin');
    mkdirSync(bin);
    const first = join(value.root, 'claude-version-one');
    const updated = join(value.root, 'claude-version-two');
    writeFileSync(first, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(updated, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const entry = join(bin, 'claude');
    symlinkSync(first, entry);
    const setupEnv: NodeJS.ProcessEnv = { ...process.env, PATH: bin };
    delete setupEnv.DOCK_CLAUDE_BIN;
    await exec(
      process.execPath,
      [
        builder,
        '--root',
        value.root,
        '--data',
        join(value.root, 'data'),
        '--port',
        String(value.port),
        '--codex',
        process.execPath,
        '--skip-compile',
      ],
      { env: setupEnv, timeout: 10_000 },
    );
    const config = JSON.parse(readFileSync(value.config, 'utf8'));
    expect(config.claudePath).toBe(entry);
    expect(config.claudePath).not.toBe(first);
    unlinkSync(entry);
    symlinkSync(updated, entry);
    expect(readFileSync(config.claudePath, 'utf8')).toContain('exit 1');
    expect(
      await command(value, 'launch', {
        ...process.env,
        PATH: '/usr/bin:/bin',
        DOCK_CLAUDE_BIN: '/an-unselected-provider',
      }),
    ).toBe('owned');
    const observed = JSON.parse(
      readFileSync(join(value.root, 'data/provider-environment.json'), 'utf8'),
    );
    expect(observed.claudePath).toBe(entry);
    expect(observed.codexPath).toBe(config.codexPath);
    expect(observed.path.split(':')).toContain(bin);
    expect(observed.path.split(':')).toContain(dirname(config.nodePath));
    expect(observed.path).toContain('/usr/bin:/bin');
    expect(await command(value, 'stop')).toBe('stopped');
  });

  it('accepts host-only Claude environment/flag overrides and refuses invalid selections before rewriting config', async () => {
    const value = await fixture();
    const entry = join(value.root, 'chosen-claude');
    writeFileSync(entry, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const args = [
      builder,
      '--root',
      value.root,
      '--data',
      join(value.root, 'data'),
      '--port',
      String(value.port),
      '--skip-compile',
    ];
    await exec(process.execPath, args, {
      env: { ...process.env, PATH: '/usr/bin:/bin', DOCK_CLAUDE_BIN: entry },
    });
    expect(JSON.parse(readFileSync(value.config, 'utf8')).claudePath).toBe(entry);
    await exec(process.execPath, [...args, '--claude', entry], {
      env: { ...process.env, DOCK_CLAUDE_BIN: '/missing/environment-selection' },
    });
    const before = readFileSync(value.config, 'utf8');
    const nonExecutable = join(value.root, 'not-executable');
    writeFileSync(nonExecutable, 'not a command', { mode: 0o600 });
    for (const bad of [join(value.root, 'missing'), value.root, nonExecutable, './relative']) {
      await expect(exec(process.execPath, [...args, '--claude', bad])).rejects.toThrow();
      expect(readFileSync(value.config, 'utf8')).toBe(before);
    }
    await expect(exec(process.execPath, [...args, '--claude'])).rejects.toThrow();
    expect(readFileSync(value.config, 'utf8')).toBe(before);
  });

  it.each(['missing', 'null', 'not installed'] as const)(
    'keeps Codex launch available with %s optional Claude configuration',
    async (mode) => {
      const value = await fixture();
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin' };
      delete env.DOCK_CLAUDE_BIN;
      if (mode === 'not installed') {
        const empty = join(value.root, 'empty-bin');
        mkdirSync(empty);
        await exec(
          process.execPath,
          [
            builder,
            '--root',
            value.root,
            '--data',
            join(value.root, 'data'),
            '--port',
            String(value.port),
            '--codex',
            process.execPath,
            '--skip-compile',
          ],
          { env: { ...env, PATH: empty } },
        );
      } else {
        const config = JSON.parse(readFileSync(value.config, 'utf8'));
        config.codexPath = process.execPath;
        if (mode === 'missing') delete config.claudePath;
        else config.claudePath = null;
        writeFileSync(value.config, JSON.stringify(config));
      }
      expect(JSON.parse(readFileSync(value.config, 'utf8')).claudePath ?? null).toBe(null);
      expect(await command(value, 'launch', env)).toBe('owned');
      const observed = JSON.parse(
        readFileSync(join(value.root, 'data/provider-environment.json'), 'utf8'),
      );
      expect(observed.claudePath).toBe(null);
      expect(observed.codexPath).toBeTruthy();
      expect(await command(value, 'stop')).toBe('stopped');
    },
  );

  it('rejects malformed optional Claude config before starting a server', async () => {
    const value = await fixture();
    const config = JSON.parse(readFileSync(value.config, 'utf8'));
    for (const claudePath of [false, 42, {}, 'relative/claude', '/bad\0path']) {
      writeFileSync(value.config, JSON.stringify({ ...config, claudePath }));
      expect(await command(value, 'launch')).toContain('This launcher needs setup again');
      expect(existsSync(join(value.root, 'data/starts'))).toBe(false);
    }
    writeFileSync(value.config, JSON.stringify(config));
  });

  it('starts one server for concurrent clicks, recognizes it, and gracefully stops its own server', async () => {
    const value = await fixture();
    const result = await Promise.all([command(value, 'launch'), command(value, 'launch')]);
    expect(result).toEqual(['owned', 'owned']);
    expect(readFileSync(join(value.root, 'data/starts'), 'utf8')).toBe('started\n');
    expect(await command(value, 'launch')).toBe('owned');
    expect(await command(value, 'stop')).toBe('stopped');
    expect(readFileSync(join(value.root, 'data/graceful-stop'), 'utf8')).toBe('yes');
    await eventually(() => absent(value.port));
  });

  it.each(['delay', 'reset'] as const)(
    'retries a %s during owned startup without spawning another server',
    async (mode) => {
      const value = await fixture();
      expect(
        await command(value, 'launch', {
          ...process.env,
          DOCK_LAUNCHER_FIXTURE_PROBE: mode,
        }),
      ).toBe('owned');
      const state = JSON.parse(readFileSync(join(value.root, 'data/launcher/owner.json'), 'utf8'));
      expect(state).toMatchObject({ status: 'running', parentPid: value.parent.pid });
      expect(readFileSync(join(value.root, 'data/starts'), 'utf8')).toBe('started\n');
      expect(await command(value, 'launch')).toBe('owned');
      expect(await command(value, 'stop')).toBe('stopped');
      expect(readFileSync(join(value.root, 'data/graceful-stop'), 'utf8')).toBe('yes');
      await eventually(() => absent(value.port));
    },
  );

  it.each([
    ['delay', 'wrong identity'],
    ['reset', 'wrong identity'],
    ['delay', 'malformed body'],
    ['reset', 'malformed body'],
  ] as const)('still refuses %s followed by %s', async (mode, invalid) => {
    const value = await fixture();
    let first = true;
    const body =
      invalid === 'wrong identity'
        ? JSON.stringify({ protocolVersion: 1, instanceId: 'another-installation' })
        : 'Not a JSON identity';
    value.server = createServer((request, response) => {
      if (first) {
        first = false;
        if (mode === 'reset') request.socket.destroy();
        else setTimeout(() => response.end(body), 1200);
      } else response.end(body);
    });
    await new Promise<void>((done) => value.server!.listen(value.port, '127.0.0.1', done));
    expect(await command(value, 'launch')).toContain(
      'Another app or a different sciencewithagents',
    );
    expect(existsSync(join(value.root, 'data/starts'))).toBe(false);
    expect(existsSync(join(value.root, 'data/launcher/owner.json'))).toBe(false);
    expect(await command(value, 'stop')).toBe('stopped');
    expect(await absent(value.port)).toBe(false);
  });

  it('does not open or stop an unrelated service on the selected local port', async () => {
    const value = await fixture();
    value.server = createServer((_request, response) => response.end('Another local app'));
    await new Promise<void>((done) => value.server!.listen(value.port, '127.0.0.1', done));
    expect(await command(value, 'launch')).toContain(
      'Another app or a different sciencewithagents',
    );
    expect(await command(value, 'stop')).toBe('stopped');
    expect(await absent(value.port)).toBe(false);
    expect(existsSync(join(value.root, 'data/starts'))).toBe(false);
  });

  it('reuses a matching already-running installation without acquiring stop authority', async () => {
    const value = await fixture();
    const { createHash } = await import('node:crypto');
    value.server = createServer((_request, response) =>
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          instanceId: createHash('sha256').update(resolve(value.root, 'data')).digest('hex'),
        }),
      ),
    );
    await new Promise<void>((done) => value.server!.listen(value.port, '127.0.0.1', done));
    expect(await command(value, 'launch')).toBe('existing');
    expect(await command(value, 'stop')).toBe('stopped');
    expect(await absent(value.port)).toBe(false);
  });

  it('waits for its matching installation to finish starting without treating it as an unrelated service', async () => {
    const value = await fixture();
    const { createHash } = await import('node:crypto');
    let ready = false;
    value.server = createServer((_request, response) => {
      response.statusCode = ready ? 200 : 503;
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          instanceId: createHash('sha256').update(resolve(value.root, 'data')).digest('hex'),
          ...(!ready ? { code: 'APP_NOT_READY' } : {}),
        }),
      );
      ready = true;
    });
    await new Promise<void>((done) => value.server!.listen(value.port, '127.0.0.1', done));
    expect(await command(value, 'launch')).toBe('existing');
    expect(existsSync(join(value.root, 'data/starts'))).toBe(false);
    expect(await command(value, 'stop')).toBe('stopped');
    expect(await absent(value.port)).toBe(false);
  });

  it('stops when the app process disappears and recovers a stale supervisor after a hard crash', async () => {
    const value = await fixture();
    expect(await command(value, 'launch')).toBe('owned');
    const statePath = join(value.root, 'data/launcher/owner.json');
    const first = JSON.parse(readFileSync(statePath, 'utf8'));
    // Exact disposable supervisor recorded by our own successful launch, never a process-name kill.
    process.kill(first.supervisorPid, 'SIGKILL');
    await eventually(() => absent(value.port)); // main's opt-in lifetime pipe closes gracefully.
    expect(readFileSync(join(value.root, 'data/graceful-stop'), 'utf8')).toBe('yes');
    expect(await command(value, 'launch')).toBe('owned');
    expect(readFileSync(join(value.root, 'data/starts'), 'utf8')).toBe('started\nstarted\n');
    value.parent.kill('SIGTERM');
    await eventually(() => absent(value.port));
    await eventually(() => JSON.parse(readFileSync(statePath, 'utf8')).status === 'stopped');
  });

  it('launches the real compiled empty app and stops it without creating an agent or model turn', async () => {
    const value = await fixture(true);
    expect(await command(value, 'launch')).toBe('owned');
    const origin = `http://127.0.0.1:${value.port}`;
    expect((await fetch(`${origin}/api/snapshot`)).status).toBe(401);
    const read = async (path: string) =>
      (
        await fetch(origin + path, {
          headers: {
            Authorization: (await ownerAuthorization(
              join(value.root, 'data'),
              value.port,
              'GET',
              path,
            ))!,
          },
        })
      ).json();
    const snapshot = await read('/api/snapshot');
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.projects).toEqual([]);
    const pacing = await read('/api/pulsar');
    expect(pacing.policy.enabled).toBe(false);
    expect(pacing.jobs).toEqual([]);
    expect(await command(value, 'stop')).toBe('stopped');
    await eventually(() => absent(value.port));
    expect(existsSync(join(value.root, 'data/server.lock'))).toBe(false);
  });

  it.runIf(process.platform === 'darwin')(
    'compiles an unsigned local app without launching it and refuses unknown output collisions',
    async () => {
      const value = await fixture();
      const built = await exec(
        process.execPath,
        [
          builder,
          '--root',
          value.root,
          '--data',
          join(value.root, 'data'),
          '--port',
          String(value.port),
        ],
        { timeout: 40_000 },
      );
      expect(built.stdout).toContain('No app, server, browser or login item was started');
      expect(
        existsSync(join(value.root, 'data/launcher/sciencewithagents.app/Contents/MacOS/applet')),
      ).toBe(true);
      const source = readFileSync(join(value.root, 'data/launcher/Launcher.applescript'), 'utf8');
      expect(source).toContain('Closing the browser alone keeps sciencewithagents running');
      expect(source).toContain('Stop and Quit');
      expect(await absent(value.port)).toBe(true);
      const unknown = join(value.root, 'another-data/launcher');
      mkdirSync(unknown, { recursive: true });
      writeFileSync(join(unknown, 'config.json'), 'owner-file-keep');
      await expect(
        exec(process.execPath, [
          builder,
          '--root',
          value.root,
          '--data',
          join(value.root, 'another-data'),
          '--skip-compile',
        ]),
      ).rejects.toThrow();
      expect(readFileSync(join(unknown, 'config.json'), 'utf8')).toBe('owner-file-keep');
    },
  );

  it.runIf(process.platform === 'darwin')(
    'starts the actual stay-open app bundle with owned fixture data and no browser',
    async () => {
      const value = await fixture();
      await exec(
        process.execPath,
        [
          builder,
          '--root',
          value.root,
          '--data',
          join(value.root, 'data'),
          '--port',
          String(value.port),
          '--no-open',
        ],
        { timeout: 40_000 },
      );
      const appPath = join(value.root, 'data/launcher/sciencewithagents.app');
      await exec('/usr/bin/open', ['-n', appPath], { timeout: 5000 });
      let appPid: number | null = null;
      try {
        await eventually(async () => {
          const statePath = join(value.root, 'data/launcher/owner.json');
          if (!existsSync(statePath)) return false;
          const state = JSON.parse(readFileSync(statePath, 'utf8'));
          appPid = state.parentPid;
          return state.status === 'running' && !(await absent(value.port));
        });
        const state = JSON.parse(
          readFileSync(join(value.root, 'data/launcher/owner.json'), 'utf8'),
        );
        expect(state.parentPid).not.toBe(value.parent.pid);
        expect(state.parentFingerprint).toContain('sciencewithagents.app/Contents/MacOS/applet');
        expect(readFileSync(join(value.root, 'data/starts'), 'utf8')).toBe('started\n');
        // Graceful owned-server stop uses this exact app identity, never a generic app/process name.
        const stopped = await exec(
          process.execPath,
          [helper, 'stop', '--config', value.config, '--parent', String(appPid)],
          { timeout: 20_000 },
        );
        expect(stopped.stdout).toBe('stopped');
        await eventually(() => absent(value.port));
      } finally {
        if (appPid) {
          const actual = await exec('/bin/ps', ['-p', String(appPid), '-o', 'command=']).catch(
            () => null,
          );
          if (
            actual?.stdout.includes('sciencewithagents.app/Contents/MacOS/applet') &&
            actual.stdout.includes('dock-launcher-test-')
          ) {
            process.kill(appPid, 'SIGTERM');
          }
        }
      }
    },
  );
});
