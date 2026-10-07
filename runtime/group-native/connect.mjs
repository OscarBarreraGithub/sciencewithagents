// Native SSH ProxyCommand transport; no credentials or command emulation.
import { connect } from 'node:net';
const [host, port] = process.argv.slice(2);
if (!host || !/^[a-z0-9.-]+$/i.test(host) || !/^\d{1,5}$/.test(port ?? '')) process.exit(1);
const socket = connect(3128, '127.0.0.1');
let header = Buffer.alloc(0),
  ready = false;
socket.on('connect', () =>
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`),
);
socket.on('data', (data) => {
  if (ready) {
    if (!process.stdout.write(data)) socket.pause();
    return;
  }
  header = Buffer.concat([header, data]);
  if (header.length > 4096) {
    socket.destroy();
    return;
  }
  const end = header.indexOf('\r\n\r\n');
  if (end < 0) return;
  if (!header.subarray(0, end).toString().startsWith('HTTP/1.1 200 ')) {
    socket.destroy();
    return;
  }
  ready = true;
  process.stdout.write(header.subarray(end + 4));
  header = Buffer.alloc(0);
  process.stdin.pipe(socket);
});
process.stdout.on('drain', () => socket.resume());
process.stdin.on('end', () => socket.end());
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
