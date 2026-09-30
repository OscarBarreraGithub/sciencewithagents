import WebSocket from 'ws';
import { terminalOutputSchema, id } from '@dock/shared';
import { dataDir, port } from './paths.js';
import { ownerAuthorization } from './local-access.js';

// The local CLI uses the same fixed Codex PTY and ownership lease as the browser.
// This prevents an untracked second CLI client from racing the task scheduler.
export async function attachCli(agentId: string) {
  id.parse(agentId);
  if (!process.stdin.isTTY) throw new Error('Use dock attach from an interactive terminal.');
  const origin = `http://127.0.0.1:${port}`;
  const path = `/api/agents/${agentId}/terminal`;
  const authorization = await ownerAuthorization(dataDir, port, 'GET', path);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin,
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  });
  let done = false;
  const input = (data: Buffer) => {
    const text = data.toString();
    for (let offset = 0; offset < text.length; offset += 4096)
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: 'input', data: text.slice(offset, offset + 4096) }));
  };
  const resize = () => {
    if (socket.readyState === 1)
      socket.send(
        JSON.stringify({
          type: 'resize',
          cols: Math.min(300, Math.max(20, process.stdout.columns || 100)),
          rows: Math.min(120, Math.max(5, process.stdout.rows || 30)),
        }),
      );
  };
  const restore = () => {
    if (done) return;
    done = true;
    process.stdin.setRawMode(false);
    process.stdin.off('data', input);
    process.stdout.off('resize', resize);
    process.stdin.pause();
    process.stdout.write('\u001b[?25h\u001b[?2004l\u001b[?1049l\r\n');
  };
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', input);
      process.stdout.on('resize', resize);
    });
    let sized = false;
    socket.on('message', (raw) => {
      const value = terminalOutputSchema.parse(JSON.parse(raw.toString()));
      if (value.type === 'transferred') {
        // The server moves this same input lease; there is no second raw Codex connection.
        process.stdout.write('\u001bc');
        sized = false;
      }
      if (value.type === 'output') {
        process.stdout.write(value.data);
        if (!sized) {
          sized = true;
          resize();
        }
      }
      if (value.type === 'error') {
        restore();
        socket.close();
        reject(new Error(value.message));
      }
      if (value.type === 'exit') {
        restore();
        socket.close();
        process.exitCode = value.code;
      }
    });
    socket.on('close', (_code, reason) => {
      restore();
      if (reason.length) process.stdout.write(reason.toString() + '\n');
      resolve();
    });
    socket.on('error', () => {
      restore();
      reject(new Error('Could not connect to sciencewithagents. Start the local service first.'));
    });
  });
}
