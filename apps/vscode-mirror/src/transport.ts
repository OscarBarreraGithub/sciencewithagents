import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import WebSocket from 'ws';

export type BridgeTarget = { port: number; socketPath?: string };

/** Remote extension hosts must explicitly opt into a private SSH Unix forward. */
export function bridgeTarget(port: number, socketPath: string, remoteName?: string): BridgeTarget {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Set a sciencewithagents port between 1024 and 65535.');
  if (remoteName && remoteName !== 'ssh-remote')
    throw new Error('Remote sharing currently supports VS Code Remote SSH workspaces only.');
  if (remoteName && !socketPath)
    throw new Error(
      'Set the remote socket path after preparing a private SSH forward. Open connection setup from the sciencewithagents menu.',
    );
  if (!socketPath) return { port };
  if (
    process.platform === 'win32' ||
    !isAbsolute(socketPath) ||
    socketPath !== resolve(socketPath) ||
    socketPath.includes('\0') ||
    Buffer.byteLength(socketPath) > 100
  )
    throw new Error(
      'Use a canonical absolute Unix socket path under 100 bytes in a private directory.',
    );
  // ws splits its IPC pathname on ':' and does not decode URL escapes. Require
  // the configured filename to survive URL parsing exactly before using ws+unix.
  const url = new URL(`ws+unix://${socketPath}:/api/vscode/bridge`);
  if (
    socketPath.includes(':') ||
    url.pathname !== `${socketPath}:/api/vscode/bridge` ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use a Unix socket path without spaces, non-ASCII characters, colons or URL-special characters.',
    );
  return { port, socketPath };
}

/** Never repair permissions or follow a linked socket on the owner's behalf. */
export function checkPrivateSocket(socketPath: string) {
  const uid = process.getuid?.();
  const parent = dirname(socketPath);
  const directory = lstatSync(parent);
  const socket = lstatSync(socketPath);
  if (
    uid === undefined ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o7777) !== 0o700 ||
    realpathSync(parent) !== parent ||
    !socket.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o7777) !== 0o600
  )
    throw new Error(
      'The SSH socket must belong to this account, have mode 0600, and be inside its unlinked mode-0700 directory.',
    );
}

/** Provider setup is qualified locally, or explicitly opted into private Remote SSH. */
export function providerSetupSocket(remoteSocketPath?: string): string | undefined {
  if (remoteSocketPath) {
    const target = bridgeTarget(4330, remoteSocketPath, 'ssh-remote');
    return target.socketPath;
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(
      'Local setup supports macOS on Apple Silicon only. Remote SSH setup requires a configured private Unix socket. Nothing was patched.',
    );
}

export class MirrorTransport {
  socket?: WebSocket;
  issue = '';
  private retry?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly target: () => BridgeTarget,
    private readonly connected: (socket: WebSocket, target: BridgeTarget) => void,
    private readonly changed: () => void,
    private readonly retryMs = 4000,
  ) {}
  start() {
    this.stop();
    this.running = true;
    this.connect();
  }
  stop() {
    this.running = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.on('error', () => {});
    socket?.terminate();
    this.issue = '';
    this.changed();
  }
  private again() {
    if (this.running) this.retry = setTimeout(() => this.connect(), this.retryMs);
    this.changed();
  }
  private connect() {
    if (!this.running) return;
    let target: BridgeTarget;
    try {
      target = this.target();
      if (target.socketPath) checkPrivateSocket(target.socketPath);
    } catch (error) {
      this.issue =
        error instanceof Error && !('code' in error)
          ? error.message
          : 'The private SSH socket is unavailable. Restore the forward; sharing retries automatically.';
      this.again();
      return;
    }
    const address = target.socketPath
      ? `ws+unix://${target.socketPath}:/api/vscode/bridge`
      : `ws://127.0.0.1:${target.port}/api/vscode/bridge`;
    const socket = new WebSocket(address, {
      perMessageDeflate: false,
      maxPayload: 128 * 1024,
      handshakeTimeout: 5000,
      followRedirects: false,
      // ws+unix sets the HTTP socketPath, which VS Code's proxy patch passes
      // through. Keep the gateway Host fixed rather than deriving it from IPC.
      ...(target.socketPath ? { headers: { Host: `127.0.0.1:${target.port}` } } : {}),
    });
    this.socket = socket;
    this.issue = '';
    socket.on('open', () => {
      if (this.socket !== socket || !this.running) return;
      this.issue = '';
      this.connected(socket, target);
      this.changed();
    });
    socket.on('error', () => {
      this.issue = target.socketPath
        ? 'The private SSH forward is unavailable. Restore it; sharing retries automatically.'
        : 'The local app is unavailable. Open sciencewithagents; sharing retries automatically.';
    });
    socket.on('close', () => {
      if (this.socket !== socket || !this.running) return;
      this.socket = undefined;
      this.issue ||= 'The app connection closed. Sharing retries automatically.';
      this.again();
    });
    this.changed();
  }
}

export const remoteSetupInstructions = `Set up sciencewithagents sharing for this VS Code Remote SSH workspace.
Keep the native provider and companion in the same remote extension host. Preserve my existing SSH alias, sign-in, running editor and conversations.
Use my existing trusted SSH connection to reverse-forward a mode-0600 Unix socket inside a new mode-0700 directory on the remote host to the app's local 127.0.0.1 port. Do not expose a TCP listener on the cluster or copy credentials.
Set agentDockMirror.remoteSocketPath in Remote settings to the canonical socket path, and agentDockMirror.port to the app's local port. Verify the socket permissions before sharing. Do not reload or patch my active editor without a safe explicit setup step.
Remote phone screenshot attachments are unavailable; attach files in the native editor. Stop sharing before cancelling only this forward and removing its exact owned socket/directory.
Follow https://github.com/OscarBarreraGithub/sciencewithagents/blob/main/apps/vscode-mirror/README.md#remote-ssh-workspaces`;
