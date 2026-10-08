import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { Agent } from 'node:http';
import type { HostTransport } from './hosts.js';
import { queryOptions } from './cluster.js';
import {
  developmentInputSchema,
  type DevelopmentInput,
  type DevelopmentLease,
} from './cluster-development.js';

export const pythonPipe = `import socket,sys,threading,os,json,re,subprocess
p=json.loads(sys.argv[1]); jid=p['jobId']
if os.environ.get('SLURM_JOB_ID')!=jid: raise RuntimeError('Wrong allocation')
r=subprocess.run(['scontrol','show','job','-o',jid],capture_output=True,text=True,timeout=15)
f=dict(re.findall(r'(\\w+)=([^ ]*)',r.stdout))
if r.returncode or f.get('Comment')!=p['comment'] or f.get('UserId')!=p['username']+'('+str(os.getuid())+')': raise RuntimeError('Allocation identity changed')
s=socket.create_connection(('127.0.0.1',p['port']),timeout=15); s.settimeout(None)
def upstream():
 try:
  while True:
   b=os.read(0,65536)
   if not b: break
   s.sendall(b)
 finally:
  try: s.shutdown(socket.SHUT_WR)
  except OSError: pass
t=threading.Thread(target=upstream,daemon=True); t.start()
try:
 while True:
  b=s.recv(65536)
  if not b: break
  sys.stdout.buffer.write(b); sys.stdout.buffer.flush()
finally: s.close()
`;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Private loopback only, with a fixed Slurm command and independent ownership check on each stream. */
export async function connectClusterLoopback(
  inputValue: DevelopmentInput,
  lease: DevelopmentLease,
  remotePort: number,
  validate: () => Promise<boolean>,
): Promise<HostTransport> {
  const input = developmentInputSchema.parse(inputValue);
  if (
    !lease.jobId ||
    lease.state !== 'ready' ||
    !Number.isInteger(remotePort) ||
    remotePort < 1024 ||
    remotePort > 65535 ||
    !(await validate())
  )
    throw new Error('The owned development allocation is unavailable.');
  let stopped = false;
  const streams = new Map<Socket, ChildProcessWithoutNullStreams | null>();
  const server = createServer((socket) => {
    // Cap concurrent long-lived SSE/PTY connections; there is no unbounded remote process pool.
    if (stopped || streams.size >= 24) {
      socket.destroy();
      return;
    }
    // Pending ownership checks reserve a slot too, before their first asynchronous wait.
    streams.set(socket, null);
    socket.once('close', () => {
      const child = streams.get(socket);
      streams.delete(socket);
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.kill('SIGTERM');
    });
    socket.pause();
    void validate().then(
      (valid) => {
        if (!valid || stopped || socket.destroyed) {
          socket.destroy();
          return;
        }
        const parameters = JSON.stringify({
          jobId: lease.jobId,
          username: lease.username,
          comment: `swa-development:${lease.projectId}:${lease.token}`,
          port: remotePort,
        });
        const child = spawn(
          'ssh',
          [
            ...queryOptions,
            '-T',
            '-o',
            'ClearAllForwardings=yes',
            '-o',
            'ForwardAgent=no',
            '-o',
            'ForwardX11=no',
            '-o',
            'PermitLocalCommand=no',
            '--',
            input.alias,
            'srun',
            '--unbuffered',
            '--jobid=' + lease.jobId,
            '--overlap',
            '--nodes=1',
            '--ntasks=1',
            'python3',
            '-c',
            quote(pythonPipe),
            quote(parameters),
          ],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        streams.set(socket, child);
        // stderr may contain private native environment details: drain it without logging.
        child.stderr.resume();
        child.stdin.on('error', () => socket.destroy());
        child.stdout.on('error', () => socket.destroy());
        child.once('error', () => socket.destroy());
        child.once('exit', () => socket.destroy());
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
        socket.resume();
      },
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Unable to open the private cluster connection.');
  // A fresh peer challenge and identity check need not each start another Slurm step.
  // Share only this exact allocation's private pipes, within the existing stream cap.
  const agent = new Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 24 });
  return {
    port: address.port,
    agent,
    // Each HTTP connection verifies ownership and starts its own Slurm pipe.
    // Preserve the ordinary host timeout while allowing this bounded native startup.
    connectionStartTimeoutMs: 15_000,
    alive: () => !stopped && server.listening,
    close: async () => {
      if (stopped) return;
      stopped = true;
      agent.destroy();
      for (const [socket, child] of streams) {
        socket.destroy();
        child?.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
