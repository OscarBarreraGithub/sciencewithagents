import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rmdir,
  readFile,
  writeFile,
  access,
  realpath,
  rename,
  cp,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { nodeEntry, selectedTool, executableEntry } from './executables.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const appleString = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
// Resolve the surviving parents too: macOS can record /var and /private/var aliases.
async function relocatedPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await relocatedPath(dirname(path)), basename(path));
  }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Node 24 or newer is required.');
  const root = await realpath(option('--root') ?? fileURLToPath(new URL('../', import.meta.url)));
  const dataDir = resolve(option('--data') ?? process.env.DOCK_DATA_DIR ?? join(root, 'data'));
  if (args.includes('--node') && (!option('--node') || option('--node').startsWith('--')))
    throw new Error('Choose an absolute Node executable path or an installed command name');
  const nodePath = await nodeEntry(option('--node'));
  const nodeVersion = await exec(nodePath, ['--version'], { timeout: 10_000 });
  if (!/^v(2[4-9]|[3-9][0-9]|[1-9][0-9]{2,})\./.test(nodeVersion.stdout.trim()))
    throw new Error('The selected Node executable must be version 24 or newer');
  const port = Number(option('--port') ?? process.env.DOCK_PORT ?? 4330);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Choose a valid local app port.');
  await access(join(root, 'apps/server/dist/main.js'));
  await access(join(root, 'scripts/launcher.mjs'));
  const stateDir = join(dataDir, 'launcher');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const configPath = join(stateDir, 'config.json');
  const identity = createHash('sha256').update(resolve(dataDir)).digest('hex');
  const markerPath = join(stateDir, 'generated.json');
  let movedConfiguration = null;
  if (await exists(markerPath)) {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (marker.instanceId !== identity || marker.root !== root) {
      const previous = JSON.parse(await readFile(configPath, 'utf8'));
      const refuse = () => {
        throw new Error(
          'This launcher folder belongs to another installation. Nothing was replaced.',
        );
      };
      if (
        marker.version !== 1 ||
        previous.version !== 1 ||
        typeof marker.root !== 'string' ||
        !isAbsolute(marker.root) ||
        previous.root !== marker.root ||
        marker.root === root ||
        typeof previous.dataDir !== 'string' ||
        !isAbsolute(previous.dataDir) ||
        marker.instanceId !== createHash('sha256').update(resolve(previous.dataDir)).digest('hex')
      )
        refuse();
      const previousData = await relocatedPath(previous.dataDir);
      const currentData = await realpath(dataDir);
      const nestedData = relative(marker.root, previousData);
      if (
        currentData !== previousData &&
        (nestedData.startsWith('..') ||
          isAbsolute(nestedData) ||
          currentData !== resolve(root, nestedData))
      )
        refuse();
      // A copied installation is not a move. Permission errors are not proof of absence.
      try {
        await access(marker.root);
        refuse();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const pids = [];
      for (const name of ['owner.json', 'supervisor.lock']) {
        const path = join(stateDir, name);
        if (!(await exists(path))) continue;
        const state = JSON.parse(await readFile(path, 'utf8'));
        pids.push(state.parentPid, state.supervisorPid, state.serverPid);
      }
      const serviceLock = join(dataDir, 'server.lock');
      if (await exists(serviceLock)) pids.push(Number(await readFile(serviceLock, 'utf8')));
      for (const pid of pids.filter((value) => value !== null && value !== undefined)) {
        if (!Number.isSafeInteger(pid) || pid < 2) refuse();
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') continue;
          throw error;
        }
        throw new Error(
          'Close the previous sciencewithagents app and its server before rebuilding a moved launcher. Nothing was replaced.',
        );
      }
      movedConfiguration = { marker, config: previous };
    }
  } else if (
    (await exists(configPath)) ||
    (await exists(join(stateDir, 'sciencewithagents.app'))) ||
    (await exists(join(stateDir, 'Agent Dock.app')))
  ) {
    throw new Error('An unrecognised launcher already exists here. Nothing was replaced.');
  }
  const codexPath = await selectedTool(args, '--codex', 'DOCK_CODEX_BIN', 'codex', 'Codex');
  const claudePath = await selectedTool(args, '--claude', 'DOCK_CLAUDE_BIN', 'claude', 'Claude');
  const cloudflaredPath = await selectedTool(
    args,
    '--cloudflared',
    'DOCK_CLOUDFLARED_BIN',
    'cloudflared',
    'phone connector',
  );
  const ghPath = await executableEntry('gh');
  // Save only directories of these known tools, never a whole shell environment.
  const toolPaths = [
    ...new Set([codexPath, claudePath, cloudflaredPath, ghPath].filter(Boolean).map(dirname)),
  ];
  const config = {
    version: 1,
    root,
    dataDir,
    nodePath,
    codexPath,
    claudePath,
    cloudflaredPath,
    toolPaths,
    port,
  };
  if (movedConfiguration)
    await writeFile(
      join(stateDir, `before-move-${randomUUID()}.json`),
      JSON.stringify(movedConfiguration, null, 2),
      { mode: 0o600 },
    );
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(markerPath, JSON.stringify({ version: 1, instanceId: identity, root }), {
    mode: 0o600,
  });
  const helper = `exec ${shellQuote(nodePath)} ${shellQuote(join(root, 'scripts/launcher.mjs'))}`;
  const launch = appleString(
    `${helper} launch --config ${shellQuote(configPath)}${args.includes('--no-open') ? ' --no-open' : ''}`,
  );
  const stop = appleString(`${helper} stop --config ${shellQuote(configPath)}`);
  const source = `property ownsServer : false
on launchDock()
  try
    set outcome to do shell script ${launch}
    if outcome starts with "error:" then
      set explanation to text 7 thru -1 of outcome
      set choice to display dialog explanation with title "sciencewithagents needs attention" buttons {"Close", "Try Again"} default button "Try Again"
      if button returned of choice is "Try Again" then
        my launchDock()
      end if
      return
    end if
    set ownsServer to outcome is "owned"
  on error
    display dialog "sciencewithagents could not open. Your saved work is retained. Ask your setup agent to rebuild the launcher for this computer." with title "sciencewithagents needs attention" buttons {"OK"} default button "OK"
  end try
end launchDock
on run
  my launchDock()
end run
on reopen
  my launchDock()
end reopen
on open location appURL
  if appURL is "sciencewithagents://open" or appURL is "sciencewithagents://open/" then
    my launchDock()
  end if
end open location
on idle
  return 300
end idle
on quit
  if ownsServer then
    set choice to display dialog "Stop sciencewithagents on this computer? Your conversations remain saved, but phone access and running work will stop until you open it again. Closing the browser alone keeps sciencewithagents running." with title "Quit sciencewithagents" buttons {"Keep Running", "Stop and Quit"} default button "Keep Running"
    if button returned of choice is "Keep Running" then return
    try
      set outcome to do shell script ${stop}
      if outcome starts with "error:" then
        display dialog (text 7 thru -1 of outcome) with title "sciencewithagents is still running" buttons {"OK"} default button "OK"
        return
      end if
    on error
      display dialog "sciencewithagents could not confirm a safe stop. Nothing else was stopped. Ask your setup agent to check it." with title "sciencewithagents is still running" buttons {"OK"} default button "OK"
      return
    end try
  end if
  continue quit
end quit
`;
  await writeFile(join(stateDir, 'Launcher.applescript'), source, { mode: 0o600 });
  if (process.platform !== 'darwin' || args.includes('--skip-compile')) {
    console.log(
      `Launcher configuration prepared at ${stateDir}. macOS compilation is a separate setup step on this platform.`,
    );
  } else {
    const staging = await mkdtemp(join(stateDir, 'build-'));
    const temporary = join(staging, 'sciencewithagents.app');
    await exec('/usr/bin/osacompile', ['-s', '-o', temporary, '-e', source], { timeout: 30_000 });
    // The only accepted deep link opens the workspace; no URL supplies a path or command.
    const info = join(temporary, 'Contents/Info.plist');
    for (const command of [
      'Delete :CFBundleIconName',
      'Set :CFBundleIconFile sciencewithagents.icns',
      `Add :CFBundleIdentifier string com.sciencewithagents.desktop.${identity.slice(0, 16)}`,
      // A --no-open launcher does not take over the browser's desktop-app link.
      ...(!args.includes('--no-open')
        ? [
            'Add :CFBundleURLTypes array',
            'Add :CFBundleURLTypes:0 dict',
            'Add :CFBundleURLTypes:0:CFBundleURLName string sciencewithagents',
            'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
            'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string sciencewithagents',
          ]
        : []),
    ])
      await exec('/usr/libexec/PlistBuddy', ['-c', command, info], { timeout: 5000 });
    await cp(
      join(root, 'assets/branding/sciencewithagents.icns'),
      join(temporary, 'Contents/Resources/sciencewithagents.icns'),
    );
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', temporary], { timeout: 15_000 });
    const appPath = join(stateDir, 'sciencewithagents.app');
    if (await exists(appPath))
      await rename(appPath, join(stateDir, `sciencewithagents-previous-${randomUUID()}.app`));
    await rename(temporary, appPath);
    await rmdir(staging);
    if (args.includes('--install')) {
      const destination = join(homedir(), 'Applications', 'sciencewithagents.app');
      if (await exists(destination))
        throw new Error(
          'sciencewithagents.app already exists in your Applications folder. The newly built copy is retained under data/launcher; nothing installed was replaced.',
        );
      await mkdir(dirname(destination), { recursive: true });
      await cp(appPath, destination, { recursive: true, force: false, errorOnExist: true });
      console.log(
        `sciencewithagents.app is installed at ${destination}. No app, server, browser or login item was started.`,
      );
    } else
      console.log(
        `sciencewithagents.app is ready at ${appPath}. No app, server, browser or login item was started.`,
      );
  }
} catch (error) {
  console.error(
    `Launcher setup did not finish: ${error.message}. Existing projects and conversations were not removed.`,
  );
  process.exitCode = 1;
}
