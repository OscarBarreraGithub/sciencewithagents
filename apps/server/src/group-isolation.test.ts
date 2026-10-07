import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect as requireSocket, type Server } from 'node:net';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  authorizeGroupBroker,
  GroupIsolation,
  GroupIsolationBlocked,
  type GroupIsolationGrant,
} from './group-isolation.js';

const supported = process.platform === 'darwin' && process.arch === 'arm64';
const macIt = supported ? it : it.skip;
const node = realpathSync.native(process.execPath);
// Enumerate the installed Node's dylib closure; never grant the entire Homebrew tree.
function runtimeFiles(
  file: string,
  paths = new Set<string>(),
  aliases = new Set<string>(),
): string[] {
  aliases.add(file);
  const canonical = realpathSync.native(file);
  if (paths.has(canonical)) return [...aliases, ...paths];
  paths.add(canonical);
  const output = execFileSync('/usr/bin/otool', ['-L', canonical], { encoding: 'utf8' });
  for (const line of output.split('\n').slice(1)) {
    let path = line.trim().split(' ')[0]!;
    if (path.startsWith('@loader_path/')) path = resolve(dirname(canonical), path.slice(13));
    if (path.startsWith('@rpath/')) {
      const name = path.slice(7);
      path =
        [join(dirname(canonical), name), resolve(dirname(node), '../lib', name)].find(existsSync) ??
        path;
    }
    if (path.startsWith('/') && !path.startsWith('/usr/lib/') && !path.startsWith('/System/'))
      runtimeFiles(path, paths, aliases);
  }
  return [...aliases, ...paths];
}
const libs = supported ? runtimeFiles(node) : [];
let root: string, grant: GroupIsolationGrant;
let contexts: GroupIsolation[] = [];
let servers: Server[] = [];
const admitted = () => true;
function prepare(overrides: Partial<GroupIsolationGrant> = {}) {
  const boundary = GroupIsolation.prepare({ ...grant, ...overrides });
  contexts.push(boundary);
  return boundary;
}
async function run(boundary: GroupIsolation, source: string, timeout?: number) {
  const result = await boundary.executeCanary(node, ['-e', source], admitted, timeout);
  expect(result.stderr).not.toContain('Library not loaded');
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}
beforeEach(() => {
  mkdirSync('data/tests', { recursive: true });
  root = realpathSync.native(mkdtempSync('data/tests/group-isolation-'));
  for (const name of [
    'workspace',
    'state',
    'read-resource',
    'host-data',
    'personal-home',
    'unrelated-chat',
  ])
    mkdirSync(join(root, name));
  writeFileSync(join(root, 'read-resource/granted.txt'), 'granted');
  writeFileSync(join(root, 'host-data/agent-client.json'), 'FAKE host client canary');
  writeFileSync(join(root, 'personal-home/history.txt'), 'FAKE personal history canary');
  writeFileSync(
    join(root, 'personal-home/config.json'),
    'FAKE inherited MCP/browser configuration',
  );
  writeFileSync(join(root, 'unrelated-chat/private.txt'), 'FAKE unrelated private chat canary');
  grant = {
    identity: {
      installationId: randomUUID(),
      groupId: randomUUID(),
      memberId: randomUUID(),
      contextId: randomUUID(),
      visibility: 'shared',
    },
    revision: 1,
    expiresAt: Date.now() + 60_000,
    workspace: join(root, 'workspace'),
    stateBase: join(root, 'state'),
    readResources: [join(root, 'read-resource')],
    executables: [node, '/bin/sh', '/bin/bash', '/bin/cat'],
    runtimeFiles: libs,
    forbiddenPaths: [
      join(root, 'host-data'),
      join(root, 'personal-home'),
      join(root, 'unrelated-chat'),
    ],
    requireNestedSandbox: false, // Independently test outer confinement; never a provider fallback.
  };
});
afterEach(async () => {
  for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
  servers = [];
  try {
    for (const context of contexts) context.close();
  } finally {
    contexts = [];
    rmSync(root, { recursive: true, force: true });
  }
});

macIt('runs real shell, Node24 and builtin SQLite without ambient runtime config', async () => {
  const boundary = prepare();
  expect(await boundary.checkCompatibility(admitted)).toMatchObject({
    shell: true,
    nestedSandbox: 'not-requested',
    providerIntegration: 'unverified',
  });
  expect(
    await run(
      boundary,
      `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); console.log(db.prepare('select 1 as value').get().value); db.close();`,
    ),
  ).toBe('1');
  expect(
    (
      await boundary.executeCanary(
        '/bin/bash',
        ['--noprofile', '--norc', '-c', 'printf bash-ok'],
        admitted,
      )
    ).stdout,
  ).toBe('bash-ok');
});

macIt(
  'visibly blocks the installed permissive-inner nesting probe before running the requested payload',
  async () => {
    const boundary = prepare({ requireNestedSandbox: true });
    await expect(
      boundary.executeCanary(
        node,
        ['-e', 'require("node:fs").writeFileSync("must-not-run","x")'],
        admitted,
      ),
    ).rejects.toThrow(/Nested sandbox unsupported.*71.*sandbox_apply/s);
    expect(existsSync(join(grant.workspace, 'must-not-run'))).toBe(false);
  },
);

macIt(
  'blocks a real OS startup refusal before payload and preserves the no-fallback boundary',
  async () => {
    const boundary = prepare({ executables: [node] });
    // Fault injection only: still invokes the actual OS sandbox, which refuses shell exec.
    // This is not a configurable launch option or a mocked sandbox success/failure.
    Object.defineProperty(boundary, 'profile', { value: '(version 1)(deny default)' });
    await expect(
      boundary.executeCanary(
        node,
        ['-e', 'require("node:fs").writeFileSync("must-not-run","x")'],
        admitted,
      ),
    ).rejects.toThrow(/OS sandbox startup failed/);
    expect(existsSync(join(grant.workspace, 'must-not-run'))).toBe(false);
  },
);

macIt(
  'allows granted reads and writes; denies host data, native history, unrelated chats and outside writes',
  async () => {
    writeFileSync(join(root, 'outside.txt'), 'outside-read-canary');
    const boundary = prepare();
    const denied = [
      'host-data/agent-client.json',
      'personal-home/history.txt',
      'personal-home/config.json',
      'unrelated-chat/private.txt',
      'outside.txt',
    ].map((path) => join(root, path));
    const result = JSON.parse(
      await run(
        boundary,
        `
    const fs=require('node:fs'); const denied=${JSON.stringify(denied)};
    const deny=(fn)=>{try{fn();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};
    fs.writeFileSync('allowed.txt','written');
    console.log(JSON.stringify({granted:fs.readFileSync(${JSON.stringify(join(root, 'read-resource/granted.txt'))},'utf8'),
      reads:denied.map(p=>deny(()=>fs.readFileSync(p))), writes:denied.map(p=>deny(()=>fs.writeFileSync(p,'escape'))),
      readOnly:deny(()=>fs.writeFileSync(${JSON.stringify(join(root, 'read-resource/granted.txt'))},'escape')),
      outside:deny(()=>fs.writeFileSync(${JSON.stringify(join(root, 'outside.txt'))},'escape'))}));`,
      ),
    );
    expect(result).toEqual({
      granted: 'granted',
      reads: [true, true, true, true, true],
      writes: [true, true, true, true, true],
      readOnly: true,
      outside: true,
    });
    expect(readFileSync(join(root, 'workspace/allowed.txt'), 'utf8')).toBe('written');
    expect(readFileSync(join(root, 'host-data/agent-client.json'), 'utf8')).toBe(
      'FAKE host client canary',
    );
  },
);

macIt(
  'inherits denials through symlink aliases, shell children and grandchildren and refuses the permissive-inner probe',
  async () => {
    const boundary = prepare();
    const target = join(root, 'unrelated-chat/private.txt');
    // Introduce an escape after admission to exercise actual OS resolution, not only preflight.
    symlinkSync(target, join(root, 'workspace/alias'));
    const result = JSON.parse(
      await run(
        boundary,
        `
    const fs=require('node:fs'),cp=require('node:child_process');
    let alias=false; try{fs.readFileSync('alias')}catch(e){alias=['EPERM','EACCES'].includes(e.code)};
    const child=cp.spawnSync('/bin/sh',['-c','/bin/cat "$1"','canary',${JSON.stringify(target)}],{encoding:'utf8'});
    const nested=cp.spawnSync('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)','/bin/bash','--noprofile','--norc','-c','/bin/cat "$1"','canary',${JSON.stringify(target)}],{encoding:'utf8'});
    const grandchild=cp.spawnSync(${JSON.stringify(node)},['-e',${JSON.stringify(`const cp=require('node:child_process'); const r=cp.spawnSync('/bin/cat',[${JSON.stringify(target)}]); process.exit(r.status===0?0:9);`)}]);
    console.log(JSON.stringify({alias,child:child.status,nested:nested.status,grandchild:grandchild.status}));`,
      ),
    );
    expect(result.alias).toBe(true);
    expect(result.child).not.toBe(0);
    expect(result.nested).not.toBe(0);
    expect(result.grandchild).toBe(9);
  },
);

macIt(
  'scrubs inherited config, MCP, browser, proxies and sockets and isolates native homes and temp',
  async () => {
    const boundary = prepare();
    const names = [
      'NODE_OPTIONS',
      'BASH_ENV',
      'ENV',
      'MCP_CONFIG',
      'HTTP_PROXY',
      'DOCK_AGENT_CLIENT',
      'CHROME_REMOTE_DEBUGGING_ADDRESS',
      'SSH_AUTH_SOCK',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'OPENSSL_CONF',
    ];
    const previous = names.map((key) => process.env[key]);
    try {
      for (const name of names) process.env[name] = 'ambient-escape-canary';
      const env = JSON.parse(
        await run(
          boundary,
          `const fs=require('node:fs'); fs.writeFileSync(process.env.TMPDIR+'/temp.txt','temp'); fs.writeFileSync(process.env.HOME+'/state.txt','own'); console.log(JSON.stringify(process.env))`,
        ),
      );
      for (const name of names.slice(0, 8)) expect(env[name]).toBeUndefined();
      expect(env.HOME).toBe(boundary.home);
      expect(env.CODEX_HOME).toBe(join(boundary.home, 'codex'));
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(boundary.home, 'claude'));
      expect(env.OPENSSL_CONF).toBe('/dev/null');
      expect(readFileSync(join(boundary.temp, 'temp.txt'), 'utf8')).toBe('temp');
    } finally {
      names.forEach((name, i) => {
        if (previous[i] === undefined) delete process.env[name];
        else process.env[name] = previous[i];
      });
    }
  },
);

async function listen(path: string | number) {
  const server = createServer((socket) => socket.end('broker-canary'));
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    if (typeof path === 'string') server.listen(path, done);
    else server.listen(path, '127.0.0.1', done);
  });
  return server;
}
macIt(
  'allows only the scoped Unix broker, denies other Unix/TCP sockets and listeners and blocks unapproved browser launch',
  async () => {
    const socket = join(root, 'broker.sock');
    await listen(relative(process.cwd(), socket));
    chmodSync(socket, 0o600);
    await listen(relative(process.cwd(), join(root, 'unrelated.sock')));
    const tcp = await listen(0);
    const port = (tcp.address() as { port: number }).port;
    const boundary = prepare({
      broker: { socket, identity: grant.identity, revision: grant.revision },
    });
    const result = JSON.parse(
      await run(
        boundary,
        `
    const net=require('node:net');
    const connect=(options)=>new Promise(resolve=>{const s=net.connect(options); s.on('error',e=>resolve(e.code)); s.on('data',d=>resolve(d.toString())); s.setTimeout(500,()=>{s.destroy();resolve('timeout')});});
    const bind=()=>new Promise(resolve=>{const s=net.createServer();s.on('error',e=>resolve(e.code));s.listen(0,'127.0.0.1',()=>s.close(()=>resolve('allowed')))});
    (async()=>console.log(JSON.stringify({broker:await connect('../broker.sock'),unix:await connect('../unrelated.sock'),
      tcp:await connect({host:'127.0.0.1',port:${port}}),listen:await bind()})))();`,
      ),
    );
    expect(result.broker).toBe('broker-canary');
    expect(['EPERM', 'EACCES']).toContain(result.unix);
    expect(['EPERM', 'EACCES']).toContain(result.tcp);
    expect(['EPERM', 'EACCES']).toContain(result.listen);
    // No browser executable is permitted; no general Mach lookup or network is granted.
    expect(
      await run(
        boundary,
        `const r=require('node:child_process').spawnSync('/usr/bin/open',['-h']); console.log(r.error?.code ?? r.status)`,
      ),
    ).toMatch(/EPERM|EACCES/);
  },
);

macIt(
  'disjoins shared/private/other-member state and blocks private publication and shared-workspace writes',
  async () => {
    const shared = prepare();
    writeFileSync(join(shared.home, 'history.txt'), 'shared-native-history');
    const privateIdentity = {
      ...grant.identity,
      contextId: randomUUID(),
      visibility: 'private' as const,
    };
    const privateContext = prepare({
      identity: privateIdentity,
      forbiddenPaths: [...grant.forbiddenPaths, shared.home],
    });
    const otherMember = prepare({
      identity: { ...grant.identity, memberId: randomUUID(), contextId: randomUUID() },
    });
    writeFileSync(join(otherMember.home, 'history.txt'), 'other-member-native-history');
    expect(privateContext.home).not.toBe(shared.home);
    expect(
      await run(
        privateContext,
        `const fs=require('node:fs'); let deny=0; for(const op of [()=>fs.readFileSync(${JSON.stringify(join(shared.home, 'history.txt'))}),()=>fs.writeFileSync('shared-mutation.txt','x')]){try{op()}catch(e){if(['EPERM','EACCES'].includes(e.code))deny++}} console.log(deny)`,
      ),
    ).toBe('2');
    expect(
      await run(
        privateContext,
        `try{require('node:fs').readFileSync(${JSON.stringify(join(otherMember.home, 'history.txt'))});console.log('escape')}catch(e){console.log(e.code)}`,
      ),
    ).toMatch(/EPERM|EACCES/);
    expect(
      authorizeGroupBroker(
        { identity: privateIdentity, revision: 1 },
        { identity: privateIdentity, revision: 1, operation: 'propose-shared' },
        admitted,
      ),
    ).toBe(false);
    expect(
      authorizeGroupBroker(
        { identity: privateIdentity, revision: 1 },
        { identity: privateIdentity, revision: 1, operation: 'read-shared' },
        admitted,
      ),
    ).toBe(true);
    expect(
      authorizeGroupBroker(
        { identity: grant.identity, revision: 1 },
        {
          identity: { ...grant.identity, memberId: randomUUID() },
          revision: 1,
          operation: 'read-shared',
        },
        admitted,
      ),
    ).toBe(false);
    expect(
      authorizeGroupBroker(
        { identity: grant.identity, revision: 1 },
        { identity: grant.identity, revision: 2, operation: 'read-shared' },
        admitted,
      ),
    ).toBe(false);
    expect(
      authorizeGroupBroker(
        { identity: grant.identity, revision: 1 },
        { identity: grant.identity, revision: 1, operation: 'read-shared' },
        () => false,
      ),
    ).toBe(false);
  },
);

macIt(
  'rejects broad grants, protected overlaps, hardlinks, symlink escapes and reused native contexts',
  () => {
    expect(() => prepare({ workspace: root })).toThrow(GroupIsolationBlocked);
    expect(() => prepare({ readResources: [join(root, 'host-data')] })).toThrow(
      GroupIsolationBlocked,
    );
    linkSync(join(root, 'unrelated-chat/private.txt'), join(root, 'workspace/hardlink'));
    expect(() => prepare()).toThrow(/Hard-linked/);
    rmSync(join(root, 'workspace/hardlink'));
    symlinkSync(join(root, 'personal-home/history.txt'), join(root, 'workspace/escape'));
    expect(() => prepare()).toThrow(/symlink/);
    rmSync(join(root, 'workspace/escape'));
    prepare();
    expect(() => prepare()).toThrow(/admission failed/);
  },
);

// Change only a fabricated/approved path component, never invent a folded policy key.
const wrongCase = (path: string) => join(dirname(path), basename(path).toUpperCase());

macIt('blocks wrong-case forbidden paths and wrong-case grants on the actual filesystem', () => {
  const secret = join(grant.workspace, 'secret');
  mkdirSync(secret);
  writeFileSync(join(secret, 'canary.txt'), 'fabricated-secret');
  // Alter the shared ancestor so a plain JS realpath prefix check fails open.
  const alias = join(wrongCase(grant.workspace), 'secret');
  expect(alias).not.toBe(secret);
  expect(realpathSync.native(alias)).toBe(realpathSync.native(secret));
  expect(() => prepare({ forbiddenPaths: [...grant.forbiddenPaths, alias] })).toThrow(
    /overlaps host-private/,
  );
  const forbiddenGrant = wrongCase(join(root, 'host-data'));
  expect(realpathSync.native(forbiddenGrant)).toBe(join(root, 'host-data'));
  expect(() => prepare({ readResources: [forbiddenGrant] })).toThrow(GroupIsolationBlocked);
});

macIt(
  'resolves Unicode-equivalent forbidden and granted paths using native filesystem spelling',
  () => {
    const secret = join(grant.workspace, 's\u00e9cret');
    mkdirSync(secret);
    writeFileSync(join(secret, 'canary.txt'), 'fabricated-unicode-secret');
    const alias = secret.normalize('NFD');
    expect(alias).not.toBe(secret);
    expect(realpathSync.native(alias)).toBe(realpathSync.native(secret));
    expect(() => prepare({ forbiddenPaths: [...grant.forbiddenPaths, alias] })).toThrow(
      /overlaps host-private/,
    );
    expect(() => prepare({ readResources: [alias], forbiddenPaths: [secret] })).toThrow(
      GroupIsolationBlocked,
    );
  },
);

macIt(
  'allows scoped projects with native casing for grants, ancestry, symlinks and executables',
  async () => {
    symlinkSync(wrongCase(join(root, 'read-resource')), join(grant.workspace, 'allowed-alias'));
    const boundary = prepare({
      workspace: wrongCase(grant.workspace),
      stateBase: wrongCase(grant.stateBase),
      readResources: [wrongCase(join(root, 'read-resource'))],
      executables: [wrongCase(node)],
    });
    const result = await boundary.executeCanary(
      wrongCase(node),
      [
        '-e',
        `const fs=require('node:fs'); fs.writeFileSync('allowed.txt','written'); console.log(fs.readFileSync('allowed-alias/granted.txt','utf8'))`,
      ],
      admitted,
    );
    expect(result).toMatchObject({ code: 0, stdout: 'granted\n' });
    expect(readFileSync(join(grant.workspace, 'allowed.txt'), 'utf8')).toBe('written');
  },
);

macIt(
  'rejects fabricated ambient home and Library grants while allowing a project beneath home',
  async () => {
    const ambientHome = join(root, 'ambient-home');
    mkdirSync(ambientHome);
    mkdirSync(join(ambientHome, 'Library'));
    const project = join(ambientHome, 'project');
    mkdirSync(project);
    const previous = process.env.HOME;
    try {
      process.env.HOME = ambientHome;
      for (const workspace of [ambientHome, wrongCase(ambientHome), join(ambientHome, 'Library')])
        expect(() => prepare({ workspace })).toThrow(/Broad ambient roots/);
      const boundary = prepare({ workspace: project });
      expect(
        await run(
          boundary,
          `require('node:fs').writeFileSync('allowed.txt','project'); console.log('ok')`,
        ),
      ).toBe('ok');
      expect(readFileSync(join(project, 'allowed.txt'), 'utf8')).toBe('project');
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  },
);

macIt('rejects symlinked native-state ancestors before creating anything through them', () => {
  symlinkSync(join(root, 'unrelated-chat'), join(grant.stateBase, grant.identity.installationId));
  expect(() => prepare()).toThrow(/ancestry/);
  expect(existsSync(join(root, 'unrelated-chat', grant.identity.groupId))).toBe(false);
});

macIt(
  'revalidates grant revision, identity, expiry and path replacement immediately before spawning',
  async () => {
    const boundary = prepare();
    await expect(
      boundary.executeCanary(node, ['-e', 'console.log("must-not-run")'], () => false),
    ).rejects.toThrow(/revoked/);
    await expect(boundary.executeCanary('/usr/bin/true', [], admitted)).rejects.toThrow(
      /not approved/,
    );
    renameSync(grant.workspace, grant.workspace + '-old');
    mkdirSync(grant.workspace);
    await expect(
      boundary.executeCanary(node, ['-e', 'console.log("must-not-run")'], admitted),
    ).rejects.toThrow(/changed identity/);
    expect(() =>
      prepare({
        expiresAt: Date.now() - 1,
        identity: { ...grant.identity, contextId: randomUUID() },
      }),
    ).toThrow(/expiring/);
    expect(() =>
      prepare({
        broker: { socket: join(root, 'missing.sock'), identity: grant.identity, revision: 2 },
      }),
    ).toThrow(GroupIsolationBlocked);
  },
);

macIt(
  'bounds output/deadlines, stops only its owned process group and cleans owned state',
  async () => {
    const boundary = prepare();
    const unrelated = spawn(node, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      await expect(
        boundary.executeCanary(node, ['-e', 'setInterval(()=>{},1000)'], admitted, 100),
      ).rejects.toThrow(/deadline/);
      await expect(
        boundary.executeCanary(
          node,
          ['-e', 'process.stdout.write("x".repeat(70000));setInterval(()=>{},1000)'],
          admitted,
        ),
      ).rejects.toThrow(/output limit/);
      const pid = Number(
        await run(
          boundary,
          `const cp=require('node:child_process');const c=cp.spawn(${JSON.stringify(node)},['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid);setTimeout(()=>process.exit(),40);`,
        ),
      );
      // The OS may briefly retain a killed, orphaned zombie before reaping it.
      await expect
        .poll(
          () => {
            try {
              return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
                encoding: 'utf8',
              })
                .trim()
                .startsWith('Z');
            } catch {
              return true;
            }
          },
          { timeout: 1_000, interval: 20 },
        )
        .toBe(true);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      const home = boundary.home;
      boundary.close();
      contexts = contexts.filter((context) => context !== boundary);
      expect(existsSync(home)).toBe(false);
      expect(existsSync(grant.workspace)).toBe(true);
      await expect(
        boundary.executeCanary(node, ['-e', 'console.log("must-not-run")'], admitted),
      ).rejects.toThrow(/closed/);
    } finally {
      const exited = new Promise<void>((done) => unrelated.once('close', () => done()));
      unrelated.kill('SIGKILL');
      await exited;
    }
  },
);

it('blocks unsupported platforms without spawning a canary', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => GroupIsolation.prepare(grant)).toThrow(/Only the verified/);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

macIt('protects the real account home independent of a fabricated HOME', () => {
  const prior = process.env.HOME;
  process.env.HOME = join(root, 'fabricated-home');
  const outside = mkdtempSync('/private/tmp/group-real-home-');
  try {
    expect(() =>
      prepare({
        workspace: userInfo().homedir,
        readResources: [],
        forbiddenPaths: ['/dev/null'],
        stateBase: outside,
      }),
    ).toThrow(/Broad ambient/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
  }
});

macIt('burns context IDs permanently after close and rejects socket reuse/placement', async () => {
  const boundary = prepare();
  boundary.close();
  contexts = [];
  expect(() => prepare()).toThrow(GroupIsolationBlocked);
  const socket = join(root, 'unique.sock');
  await listen(relative(process.cwd(), socket));
  chmodSync(socket, 0o600);
  const fresh = { ...grant.identity, contextId: randomUUID() };
  const first = prepare({ identity: fresh, broker: { socket, identity: fresh, revision: 1 } });
  first.close();
  contexts = [];
  const next = { ...fresh, contextId: randomUUID() };
  expect(() =>
    prepare({ identity: next, broker: { socket, identity: next, revision: 1 } }),
  ).toThrow(GroupIsolationBlocked);
  const inside = join(grant.workspace, 'inside.sock');
  await listen(relative(process.cwd(), inside));
  chmodSync(inside, 0o600);
  expect(() =>
    prepare({ identity: next, broker: { socket: inside, identity: next, revision: 1 } }),
  ).toThrow(/outside resource/);
});

macIt('denies metadata of ungranted runtime siblings', async () => {
  const runtimeDir = join(root, 'runtime');
  mkdirSync(runtimeDir);
  const runtime = join(runtimeDir, 'approved.txt'),
    hidden = join(runtimeDir, 'private-name.txt');
  writeFileSync(runtime, 'runtime');
  writeFileSync(hidden, 'private');
  const boundary = prepare({ runtimeFiles: [...libs, runtime] });
  expect(
    await run(
      boundary,
      `try {require('node:fs').statSync(${JSON.stringify(hidden)}); console.log('escape')} catch(e){console.log(e.code)}`,
    ),
  ).toMatch(/EPERM|EACCES/);
});

macIt(
  'rejects Unicode aliases of a shared ancestor, rather than relying on a disjointness guard',
  () => {
    const parent = join(root, 's\u00e9cret-parent');
    mkdirSync(parent);
    const workspace = join(parent, 'workspace');
    mkdirSync(workspace);
    const secret = join(workspace, 'secret');
    mkdirSync(secret);
    const alias = join(parent.normalize('NFD'), 'workspace', 'secret');
    expect(alias).not.toBe(secret);
    expect(() => prepare({ workspace, forbiddenPaths: [...grant.forbiddenPaths, alias] })).toThrow(
      /overlaps host-private/,
    );
  },
);

macIt(
  'denies real KERN_PROCARGS2 even when the approved binary knows a fabricated victim PID',
  async () => {
    const source = join(root, 'sysctl.c'),
      binary = join(root, 'sysctl-canary');
    writeFileSync(
      source,
      `#include <sys/types.h>
#include <sys/sysctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
int main(int argc, char **argv) {
 int mib[3]={CTL_KERN,KERN_PROCARGS2,atoi(argv[1])}; char buf[65536]; size_t n=sizeof(buf);
 if(sysctl(mib,3,buf,&n,0,0)!=0) {puts(errno==EPERM||errno==EACCES ? "denied" : "other-error"); return 0;}
 int found=0; for(size_t i=0;i+strlen("FABRICATED-GROUP-SYSCTL")<=n;i++)
 if(memcmp(buf+i,"FABRICATED-GROUP-SYSCTL",strlen("FABRICATED-GROUP-SYSCTL"))==0) found=1;
 puts(found ? "fabricated-visible" : "no-sentinel"); return 0;
}`,
    );
    execFileSync('/usr/bin/cc', [source, '-o', binary], { stdio: 'pipe' });
    const victim = spawn(node, ['-e', 'setInterval(()=>{},1000)', 'FABRICATED-GROUP-SYSCTL-ARGV'], {
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', FABRICATED: 'FABRICATED-GROUP-SYSCTL-ENV' },
    });
    try {
      await new Promise<void>((done, fail) => {
        victim.once('spawn', done);
        victim.once('error', fail);
      });
      expect(execFileSync(binary, [String(victim.pid)], { encoding: 'utf8' }).trim()).toBe(
        'fabricated-visible',
      );
      const boundary = prepare({ executables: [...grant.executables, binary] });
      const result = await boundary.executeCanary(binary, [String(victim.pid)], admitted);
      expect(result).toMatchObject({ code: 0, stdout: 'denied\n' });
    } finally {
      const exited = new Promise<void>((done) => victim.once('exit', () => done()));
      victim.kill('SIGKILL');
      await exited;
    }
  },
);

macIt(
  'demonstrates an escaped-session descendant remains confined but needs an owned host stop',
  async () => {
    const boundary = prepare();
    const heartbeat = join(boundary.scratch, 'heartbeat');
    const access = join(boundary.scratch, 'descendant-access');
    let escapedPid: number | undefined;
    try {
      const result = await boundary.executeCanary(
        node,
        [
          '-e',
          `
      const child=require('node:child_process').spawn(${JSON.stringify(node)},['-e',
        ${JSON.stringify(`const fs=require('node:fs'); let denied='escape'; try {fs.readFileSync(${JSON.stringify(join(root, 'host-data/agent-client.json'))})} catch(e) {denied=e.code} fs.writeFileSync(${JSON.stringify(access)},denied); let n=0; setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(++n)),20)`)}],
        {detached:true,stdio:'ignore'}); child.unref(); console.log(child.pid);
    `,
        ],
        admitted,
      );
      expect(result.code, result.stderr).toBe(0);
      escapedPid = Number(result.stdout.trim());
      expect(escapedPid).toBeGreaterThan(1);
      let first = '';
      for (let i = 0; i < 30; i++) {
        if (existsSync(heartbeat)) {
          first = readFileSync(heartbeat, 'utf8');
          break;
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(first).not.toBe('');
      expect(readFileSync(access, 'utf8')).toMatch(/EPERM|EACCES/);
      await new Promise((done) => setTimeout(done, 80));
      expect(readFileSync(heartbeat, 'utf8')).not.toBe(first);
      // Do not describe process-group cleanup as whole-tree termination. The
      // actual escaped child still runs; production admission remains denied.
    } finally {
      if (escapedPid && Number.isSafeInteger(escapedPid) && escapedPid > 1) {
        try {
          process.kill(-escapedPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        let stopped = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const state = execFileSync('/bin/ps', ['-p', String(escapedPid), '-o', 'stat='], {
              encoding: 'utf8',
            }).trim();
            if (!state || state.startsWith('Z')) {
              stopped = true;
              break;
            }
          } catch (error) {
            if ((error as { status?: number }).status === 1) {
              stopped = true;
              break;
            }
            throw error;
          }
          await new Promise((done) => setTimeout(done, 10));
        }
        expect(stopped).toBe(true); // Exact owned PID; no global process search/kill.
      }
    }
  },
);

macIt(
  'auth-only process binds its own Unix RPC, reaches only its proxy, cannot spawn descendants, and stops on revocation',
  async () => {
    const socketDir = realpathSync.native(mkdtempSync('/tmp/swa-auth-canary-'));
    chmodSync(socketDir, 0o700);
    const proxy = createServer((stream) => stream.end('proxy-granted'));
    servers.push(proxy);
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
    const socket = join(socketDir, 'rpc.sock');
    let allowed = true;
    const boundary = prepare({ authentication: { socket, proxyPort: address.port } });
    const resultPath = join(grant.workspace, 'auth-canary.json');
    const source = `
    const fs=require('node:fs'), net=require('node:net'), cp=require('node:child_process');
    const result={};
    try { result.spawn=cp.spawnSync(process.execPath,['-e','process.exit(0)']).error?.code; } catch(e) { result.spawn=e.code; }
    const listener=net.createServer(s=>s.end('owned-rpc')); listener.listen(${JSON.stringify(socket)});
    const c=net.connect(${address.port},'127.0.0.1'); c.on('data',b=>result.proxy=b.toString()); c.on('close',()=>fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result)));
    setInterval(()=>{},100);
  `;
    const child = boundary.spawnAuthentication(
      node,
      ['-e', source],
      { ...boundary.environment() },
      () => allowed,
    );
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      try {
        await expect.poll(() => existsSync(resultPath), { timeout: 2_000 }).toBe(true);
      } catch {
        throw new Error(
          `Auth canary did not initialize (${child.exitCode}/${child.signalCode}): ${stderr}`,
        );
      }
      expect(JSON.parse(readFileSync(resultPath, 'utf8')), stderr).toEqual({
        spawn: 'EPERM',
        proxy: 'proxy-granted',
      });
      expect(
        await new Promise<string>((done, fail) => {
          const peer = requireSocket(socket);
          peer.on('data', (chunk: Buffer) => done(chunk.toString()));
          peer.on('error', fail);
        }),
      ).toBe('owned-rpc');
      allowed = false;
      await exited;
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      allowed = false;
      child.kill('SIGKILL');
      await exited;
      boundary.close();
      contexts = contexts.filter((entry) => entry !== boundary);
      rmSync(socketDir, { recursive: true, force: true });
    }
  },
);
