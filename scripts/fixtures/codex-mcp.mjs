#!/usr/bin/env node
// Test-only Codex wrapper: add one harmless local MCP fixture without writing user configuration.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = process.env.DOCK_MCP_FIXTURE;
if (!root || !/^.{1,500}\/data\/smoke\/[a-f0-9]{8}$/.test(root) || !existsSync(root))
  throw new Error('Use the generated MCP smoke fixture only.');
const config =
  'mcp_servers.dock_fixture={command=' +
  JSON.stringify(process.execPath) +
  ',args=[' +
  [
    fileURLToPath(
      new URL(
        process.env.DOCK_MCP_URLS === '1' ? './mcp-url-server.mjs' : './mcp-server.mjs',
        import.meta.url,
      ),
    ),
    join(root, 'mcp-calls.txt'),
    ...(process.env.DOCK_MCP_FORMS === '1' ? ['--forms'] : []),
  ]
    .map(JSON.stringify)
    .join(',') +
  '],enabled=false,default_tools_approval_mode="approve",tools={ping={approval_mode="approve"}}}';
const child = spawn('codex', [...process.argv.slice(2), '-c', config], {
  stdio: ['inherit', 'inherit', 'pipe'],
});
child.stderr.on('data', (data) => {
  appendFileSync(join(root, 'codex-fixture-diagnostics.txt'), data, { mode: 0o600 });
  process.stderr.write(data);
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => process.exit(code ?? 1));
