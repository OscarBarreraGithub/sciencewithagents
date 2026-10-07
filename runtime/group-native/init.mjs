// Trusted PID 1 only. Native agents execute separately as uid 1000. network=none,
// isolated PID/IPC/mount namespaces, read-only image, no host socket/home mounts.
// PID-1 exit tears down EVERY descendant, including setsid/double-fork trees.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { chownSync, chmodSync, mkdirSync } from 'node:fs';
const expiresAt = Number(process.argv[2]);
if (
  process.pid !== 1 ||
  process.getuid() !== 0 ||
  !Number.isFinite(expiresAt) ||
  expiresAt <= Date.now()
)
  process.exit(1);
// CHOWN is the sole root capability. Own the volume while initializing it;
// after transfer, root cannot chmod/traverse the agent's private mode-0700 home.
chownSync('/home/agent', 0, 0);
chmodSync('/home/agent', 0o700);
// Native CLIs require their configured directories even before any sign-in.
// Initialize only empty directory roots; retained account/history contents stay intact.
for (const path of ['/home/agent/workspace', '/home/agent/.codex', '/home/agent/.claude']) {
  mkdirSync(path, { mode: 0o700, recursive: true });
  chownSync(path, 1000, 1000);
}
chownSync('/home/agent', 1000, 1000);
const peers = new Map();
const send = (frame) => {
  if (process.stdout.writableLength > 16 * 1024 * 1024) process.exit(1);
  return process.stdout.write(JSON.stringify(frame) + '\n');
};
const proxy = createServer((_request, response) => response.writeHead(403).end());
proxy.on('connect', (request, peer, head) => {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(request.url ?? '');
  if (!match || head.length > 65536) {
    peer.destroy();
    return;
  }
  const id = randomUUID();
  peers.set(id, { peer, head, ready: false });
  peer.on('error', () => {});
  peer.on('close', () => {
    peers.delete(id);
    send({ type: 'end', id });
  });
  peer.on('data', (data) => {
    for (let i = 0; i < data.length; i += 65536)
      send({ type: 'data', id, data: data.subarray(i, i + 65536).toString('base64') });
    if (process.stdout.writableNeedDrain) {
      peer.pause();
      process.stdout.once('drain', () => peer.resume());
    }
  });
  peer.pause();
  send({ type: 'open', id, host: match[1].toLowerCase(), port: Number(match[2]) });
});
proxy.on('clientError', (_error, peer) => peer.destroy());
let bytes = 0;
let lastOwnerPing = Date.now();
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    bytes = byte === 10 ? 0 : bytes + 1;
    if (bytes > 100000) process.exit(1);
  }
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (line.length > 100000) process.exit(1);
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    process.exit(1);
  }
  if (value.type === 'stop') process.exit(0);
  if (value.type === 'ping') {
    lastOwnerPing = Date.now();
    return;
  }
  const record = peers.get(value.id);
  if (!record) return;
  if (value.type === 'opened') {
    record.ready = true;
    record.peer.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (record.head.length)
      send({ type: 'data', id: value.id, data: record.head.toString('base64') });
    record.head = Buffer.alloc(0);
    record.peer.resume();
  } else if (
    value.type === 'data' &&
    typeof value.data === 'string' &&
    value.data.length <= 87384
  ) {
    if (record.peer.writableLength > 16 * 1024 * 1024) process.exit(1);
    record.peer.write(Buffer.from(value.data, 'base64'));
  } else if (value.type === 'end' || value.type === 'error') record.peer.destroy();
  else process.exit(1);
});
// StdinOnce=true is checked by the host before attach. EOF after host crash is
// a namespace stop, not a process-group guess. Grant expiry is an extra backstop.
input.on('close', () => process.exit(0));
process.stdin.on('error', () => process.exit(1));
process.stdout.on('error', () => process.exit(1));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {
  // Independent of Docker attach-EOF behavior: the trusted UID-0 input pipe is
  // the only heartbeat authority. Group tools cannot obtain its descriptor.
  if (Date.now() >= expiresAt || Date.now() - lastOwnerPing >= 5000) process.exit(0);
}, 100);
await new Promise((done, fail) => {
  proxy.once('error', fail);
  proxy.listen(3128, '127.0.0.1', done);
});
send({ type: 'ready', pid: process.pid, uid: process.getuid(), network: 'none' });
