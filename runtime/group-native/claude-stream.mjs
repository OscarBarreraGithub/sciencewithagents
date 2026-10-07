// Preserve native CLI args/tools/hooks. Retain only its typed final result in
// THIS context's private guest volume before forwarding it to the owning host.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const base = '/home/agent/.dock-native-results';
if (process.getuid() !== 1000) process.exit(1);
if (process.argv[2] === '--read-result') {
  const [session, delivery] = process.argv.slice(3);
  if (!uuid.test(session ?? '') || !uuid.test(delivery ?? '')) process.exit(1);
  let result;
  try {
    result = JSON.parse(readFileSync(`${base}/${delivery}.json`, 'utf8'));
  } catch {
    process.stdout.write(JSON.stringify({ found: false }) + '\n');
    process.exit(0);
  }
  if (
    result.frame?.session_id !== session ||
    result.frame?.user_message_uuid !== delivery ||
    result.frame?.type !== 'result'
  )
    process.exit(1);
  process.stdout.write(
    JSON.stringify({ found: true, result: result.frame, nativeToolItems: result.nativeToolItems }) +
      '\n',
  );
  process.exit(0);
}
mkdirSync(base, { recursive: true, mode: 0o700 });
const child = spawn('/usr/local/bin/claude', process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'pipe'],
});
// Raw diagnostics stay transient in the native adapter's fixed auth scanner.
child.stderr.pipe(process.stderr);
let delivery;
let toolIds = new Set();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 16 * 1024 * 1024) process.exit(1);
  const frame = JSON.parse(line);
  if (frame.type === 'user' && uuid.test(frame.uuid ?? '')) {
    delivery = frame.uuid;
    toolIds = new Set();
  }
  if (child.stdin.writableLength > 16 * 1024 * 1024) process.exit(1);
  child.stdin.write(line + '\n');
});
input.on('close', () => child.stdin.end());
const output = createInterface({ input: child.stdout });
output.on('line', (line) => {
  if (
    Buffer.byteLength(line) > 16 * 1024 * 1024 ||
    process.stdout.writableLength > 16 * 1024 * 1024
  )
    process.exit(1);
  const frame = JSON.parse(line);
  if (frame.type === 'assistant' && Array.isArray(frame.message?.content))
    for (const item of frame.message.content)
      if (item.type === 'tool_use' && typeof item.id === 'string') toolIds.add(item.id);
  if (frame.type === 'result') {
    const actualDelivery = frame.user_message_uuid ?? delivery;
    if (
      !uuid.test(frame.session_id ?? '') ||
      !uuid.test(actualDelivery ?? '') ||
      actualDelivery !== delivery
    )
      process.exit(1);
    const receipt = { ...frame, user_message_uuid: actualDelivery };
    // Result UUID+delivery owns one immutable receipt. Never clobber a prior turn.
    let fd;
    try {
      fd = openSync(`${base}/${actualDelivery}.json`, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ frame: receipt, nativeToolItems: toolIds.size }));
      fsyncSync(fd);
    } catch {
      process.exit(1);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  process.stdout.write(line + '\n');
});
child.once('error', () => process.exit(1));
child.once('close', (code) => process.exit(code ?? 1));
