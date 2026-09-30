import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './store.js';
import { validateRoot } from './workspaces.js';
import { binary, dataDir, port } from './paths.js';
import { CodexRpc } from './codex.js';
import { randomUUID } from 'node:crypto';
import { Sessions } from './sessions.js';
import { Runtime } from './runtime.js';
import { service } from './service.js';
import { attachCli } from './attach-cli.js';
import { agentClientCommand } from './agent-client.js';
import { prepareBrowserHandoff } from './local-browser-handoff.js';

process.umask(0o077);
const [command, argument, ...rest] = process.argv.slice(2);
const exec = promisify(execFile);
if (command === 'quark') {
  try {
    console.log(JSON.stringify(await agentClientCommand(dataDir, argument, rest), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'QUARK request failed.');
    process.exitCode = 1;
  }
} else if (command === 'open') {
  const target = await prepareBrowserHandoff(dataDir, port);
  const opener =
    process.platform === 'darwin'
      ? '/usr/bin/open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open';
  await exec(opener, [target ?? `http://127.0.0.1:${port}`], { timeout: 5000 });
  console.log('Opened sciencewithagents in your browser.');
} else if (command === 'service') {
  await service(argument ?? 'status');
} else if (command === 'backup') {
  const { backup } = await import('node:sqlite');
  const target = join(
    dataDir,
    'backups',
    `dock-${new Date().toISOString().replaceAll(':', '-')}.sqlite`,
  );
  mkdirSync(join(dataDir, 'backups'), { recursive: true, mode: 0o700 });
  const store = new Store(join(dataDir, 'dock.sqlite'));
  try {
    await backup(store.db, target);
    console.log(
      `Database backup saved: ${target}\nThis contains the conversation archive and metadata. Back up project repositories and task worktrees separately.`,
    );
  } finally {
    store.close();
  }
} else if (command === 'doctor') {
  console.log(
    `Node ${process.version} · ${Number(process.versions.node.split('.')[0]) >= 24 ? 'supported' : 'Node 24+ required'}`,
  );
  for (const [program, args] of [
    [binary, ['--version']],
    [binary, ['login', 'status']],
    ['git', ['--version']],
  ] as const) {
    try {
      const result = await exec(program, [...args], { timeout: 10_000 });
      console.log((result.stdout || result.stderr).trim());
    } catch {
      console.log(`${program}: unavailable. Install it or complete codex login.`);
      process.exitCode = 1;
    }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    console.log(
      response.ok ? 'sciencewithagents is running.' : 'sciencewithagents needs attention.',
    );
  } catch {
    console.log('sciencewithagents is stopped. Start it with pnpm start.');
  }
} else if (command === 'add' && argument) {
  const root = await validateRoot(resolve(argument), dataDir);
  const nameIndex = rest.indexOf('--name');
  const descriptionIndex = rest.indexOf('--description');
  const providerIndex = rest.indexOf('--provider');
  const provider = providerIndex < 0 ? undefined : rest[providerIndex + 1];
  if (provider !== undefined && provider !== 'codex' && provider !== 'claude')
    throw new Error('Choose --provider codex or --provider claude.');
  const store = new Store(join(dataDir, 'dock.sqlite'));
  const project = store.register(
    root,
    nameIndex >= 0 ? rest[nameIndex + 1] || basename(root) : basename(root),
    descriptionIndex >= 0 ? rest[descriptionIndex + 1] || '' : '',
    provider,
  );
  console.log(
    `Registered ${project.name}. Manager: ${project.managerId}\nOpen the sciencewithagents app or use pnpm dock open.`,
  );
  store.close();
} else if (command === 'list') {
  const store = new Store(join(dataDir, 'dock.sqlite'));
  for (const project of store.projects())
    console.log(`${project.id}  ${project.name}\n  ${project.root}`);
  store.close();
} else if (command === 'attach' && argument) {
  await attachCli(argument);
} else if ((command === 'sessions' || command === 'import') && argument) {
  if (command === 'import' && (!rest[0] || !rest.includes('--stopped')))
    throw new Error(
      'Stop the original Codex client, then run dock import <project-id> <thread-id> --stopped.',
    );
  const store = new Store(join(dataDir, 'dock.sqlite'));
  const project = store.project(argument);
  const rpc = new CodexRpc(
    binary,
    join(dataDir, 'sockets', `discovery-${randomUUID().slice(0, 8)}.sock`),
    project.root,
    true,
  );
  // This CLI only reads history/imports records. Do not initialize a scheduler or
  // call Runtime.close(), which would recover jobs owned by the running gateway.
  const runtime = new Runtime(store, dataDir, binary, async () => rpc);
  const sessions = new Sessions(runtime);
  try {
    await rpc.start();
    if (command === 'sessions') {
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page = await sessions.list(project.id, cursor ?? undefined);
        for (const thread of page.data)
          console.log(
            `${thread.id}  ${thread.title}${thread.agentId ? ' [already imported]' : ''}`,
          );
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a session-list cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } else {
      const managerIndex = rest.indexOf('--manager');
      const worker = (await sessions.import(project.id, {
        key: randomUUID(),
        threadId: rest[0],
        managerId: managerIndex >= 0 ? rest[managerIndex + 1] : project.managerId,
        confirmedStopped: true,
      })) as { id: string };
      console.log(
        `Imported ${worker.id}. No model turn was started. Imports begin read-only; new implementation belongs in task worktrees.`,
      );
    }
  } finally {
    await rpc.close();
    store.close();
  }
} else {
  console.log(
    'sciencewithagents\n\n  pnpm dock open\n  pnpm dock quark help\n  pnpm dock doctor\n  pnpm dock add /absolute/repository --name "Project name"\n  pnpm dock list\n  pnpm dock attach <agent-id>\n  pnpm dock sessions <project-id>\n  pnpm dock import <project-id> <codex-thread-id> --stopped [--manager <manager-id>]\n\nRun pnpm build before using this CLI. Projects are registered locally; paths never come from the web client.',
  );
}
