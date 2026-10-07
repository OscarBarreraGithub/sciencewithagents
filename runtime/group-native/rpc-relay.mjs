// Private Codex Unix WebSocket <-> JSON-lines transport inside the SAME guest.
// A Mac host Unix listener remains the existing CodexRpc adapter's transport.
import WebSocket from 'ws';
import { createInterface } from 'node:readline';
const path = process.argv[2];
if (path !== '/tmp/group-native.sock') process.exit(1);
let socket,
  pending = [],
  bytes = 0,
  stopping = false;
let lineBytes = 0;
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    lineBytes = byte === 10 ? 0 : lineBytes + 1;
    if (lineBytes > 16 * 1024 * 1024) process.exit(1);
  }
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 16 * 1024 * 1024) process.exit(1);
  if (socket?.readyState === WebSocket.OPEN) {
    if (socket.bufferedAmount > 16 * 1024 * 1024) process.exit(1);
    socket.send(line);
  } else {
    bytes += Buffer.byteLength(line);
    if (bytes > 16 * 1024 * 1024) process.exit(1);
    pending.push(line);
  }
});
input.on('close', () => {
  stopping = true;
  socket?.close();
  process.exit(0);
});
for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
  const candidate = new WebSocket(`ws+unix://${path}:/rpc`, {
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
  });
  const connected = await new Promise((done) => {
    candidate.once('open', () => done(true));
    candidate.once('error', () => done(false));
  });
  if (!connected) {
    candidate.close();
    await new Promise((done) => setTimeout(done, 50));
    continue;
  }
  socket = candidate;
  socket.on('message', (data) => {
    if (!process.stdout.write(data.toString() + '\n')) socket.pause();
  });
  process.stdout.on('drain', () => socket.resume());
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
  for (const line of pending) socket.send(line);
  pending = [];
  bytes = 0;
  break;
}
if (!socket) process.exit(1);
