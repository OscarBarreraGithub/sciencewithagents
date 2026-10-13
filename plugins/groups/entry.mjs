import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only an owner-created machine configuration; never data from a group or plugin cache.
export function configuration(
  file = process.env.SWA_GROUPS_CONFIG ??
    join(homedir(), '.config/sciencewithagents/groups-claude.json'),
) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Groups needs a private connection file owned by this account.');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (
      value.version !== 1 ||
      Object.keys(value).sort().join(',') !== 'dataDirectory,installation,version' ||
      typeof value.installation !== 'string' ||
      !isAbsolute(value.installation) ||
      typeof value.dataDirectory !== 'string' ||
      !isAbsolute(value.dataDirectory)
    )
      throw new Error(
        'Invalid Groups connection. Ask your setup agent to configure this installation.',
      );
    return value;
  } finally {
    closeSync(fd);
  }
}

if (process.argv[2] === 'mcp' || process.argv[2] === 'hook') {
  try {
    const config = configuration();
    const name = process.argv[2] === 'mcp' ? 'groups-external-mcp' : 'groups-claude-hook';
    const module = await import(
      pathToFileURL(join(config.installation, `apps/server/dist/${name}.js`)).href
    );
    if (name === 'groups-external-mcp') await module.startGroupsMcp(config.dataDirectory);
    else await module.runGroupsHook(config.dataDirectory);
  } catch {
    // Hooks never block native work. MCP errors go to stderr, never corrupt stdio JSON-RPC.
    console.error(
      'SWA Groups is disconnected. Open SWA and ask your setup agent to check docs/GROUPS_CLAUDE.md.',
    );
    if (process.argv[2] === 'mcp') process.exitCode = 1;
  }
}
