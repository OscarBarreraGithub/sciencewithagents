import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = process.env.DOCK_DATA_DIR;
writeFileSync(
  join(dataDir, 'provider-environment.json'),
  JSON.stringify({
    codexPath: process.env.DOCK_CODEX_BIN ?? null,
    claudePath: process.env.DOCK_CLAUDE_BIN ?? null,
    cloudflaredPath: process.env.DOCK_CLOUDFLARED_BIN ?? null,
    path: process.env.PATH ?? '',
    ...(process.env.DOCK_LAUNCHER_FIXTURE_ENV === '1'
      ? {
          independent: Object.fromEntries(
            [
              'CLAUDECODE',
              'CLAUDE_CODE_CHILD_SESSION',
              'CLAUDE_CODE_SESSION_ID',
              'CLAUDE_CODE_SESSION_ATTENDED',
              'CLAUDE_PID',
              'CLAUDE_CODE_SSE_PORT',
              'CLAUDE_CODE_ENTRYPOINT',
              'CLAUDE_CONFIG_DIR',
              'ANTHROPIC_MODEL',
              'CLAUDE_CODE_EFFORT_LEVEL',
              'CLAUDE_CODE_SHELL_PREFIX',
              'CLAUDE_CODE_IDE_HOST_OVERRIDE',
              'ANTHROPIC_API_KEY',
              'ANTHROPIC_BASE_URL',
              'CLAUDE_CODE_USE_BEDROCK',
              'HTTPS_PROXY',
              'DOCK_FIXTURE_CUSTOM',
            ].map((name) => [name, process.env[name] ?? null]),
          ),
        }
      : {}),
  }),
  { mode: 0o600 },
);
let firstProbe = true;
const server = createServer((request, response) => {
  const mode = process.env.DOCK_LAUNCHER_FIXTURE_PROBE;
  if (firstProbe && ['delay', 'reset'].includes(mode)) {
    firstProbe = false;
    if (mode === 'reset') request.socket.destroy();
    else setTimeout(() => reply(response), 1200);
    return;
  }
  reply(response);
});
function reply(response) {
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      protocolVersion: 1,
      instanceId: createHash('sha256').update(resolve(dataDir)).digest('hex'),
    }),
  );
}
server.listen(Number(process.env.DOCK_PORT), '127.0.0.1', () =>
  appendFileSync(join(dataDir, 'starts'), 'started\n'),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  writeFileSync(join(dataDir, 'graceful-stop'), 'yes');
  server.close(() => process.exit(0));
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
if (process.env.DOCK_LAUNCHER_LIFETIME === '1') {
  process.stdin.once('end', stop);
  process.stdin.resume();
}
