import { createServer } from 'node:http';
import { chmodSync } from 'node:fs';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

export type NativeTransition = {
  params: unknown;
  before?(): Promise<void>;
  /** Last synchronous admission check, immediately before forwarding provider input. */
  submitted?(): void;
  finish(result: unknown): Promise<void>;
  cancel(reason?: 'rejected'): void;
};
export type NativeHandoff = { handoff(): Promise<void>; cancel(): void };
export const nativeConfigMutations = new Set([
  'plugin/install',
  'plugin/uninstall',
  'plugin/reconcile',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/upgrade',
  'config/value/write',
  'config/batchWrite',
  'config/mcpServer/reload',
  'experimentalFeature/enablement/set',
]);

/** Private CLI transport. Gate context acknowledgements; host UI owns URL elicitations. */
export class NativeRelay {
  private server = createServer((_request, reply) => reply.writeHead(404).end());
  private sockets = new Set<WebSocket>();
  private cancellations = new Set<() => void>();
  private wss = new WebSocketServer({
    server: this.server,
    path: '/rpc',
    perMessageDeflate: false,
    maxPayload: 4 * 1024 * 1024,
  });
  constructor(
    readonly path: string,
    readonly upstream: string,
    readonly prepare: (method: string, params: unknown) => NativeTransition | NativeHandoff | null,
  ) {}
  async start() {
    this.wss.on('connection', (client) => {
      const provider = new WebSocket(`ws+unix://${this.upstream}:/rpc`, {
        headers: { Host: 'localhost' },
        perMessageDeflate: false,
        // Native /plugins includes the full marketplace catalog (~8 MiB on the
        // tested provider). Keep CLI input bounded separately at 4 MiB.
        maxPayload: 16 * 1024 * 1024,
        handshakeTimeout: 5000,
      });
      this.sockets.add(client);
      this.sockets.add(provider);
      const pending = new Map<string | number, NativeTransition | NativeHandoff>();
      const buffered: RawData[] = [];
      let bufferedBytes = 0;
      const cancel = () => {
        for (const transition of pending.values()) transition.cancel();
        pending.clear();
      };
      this.cancellations.add(cancel);
      const close = () => {
        cancel();
        this.cancellations.delete(cancel);
        this.sockets.delete(client);
        this.sockets.delete(provider);
        client.terminate();
        provider.terminate();
      };
      const send = (socket: WebSocket, data: RawData | string) => {
        const limit = (socket === client ? 16 : 4) * 1024 * 1024;
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > limit) return close();
        socket.send(data, { binary: false });
      };
      const receive = async (data: RawData) => {
        let message;
        try {
          message = JSON.parse(data.toString());
          if (
            pending.size &&
            ([
              'thread/start',
              'thread/resume',
              'thread/fork',
              'turn/start',
              'thread/compact/start',
            ].includes(message.method) ||
              nativeConfigMutations.has(message.method))
          )
            throw new Error('Wait for the current native context transition to finish.');
          if (
            [
              'thread/start',
              'thread/resume',
              'thread/fork',
              'turn/start',
              'thread/compact/start',
            ].includes(message.method) ||
            nativeConfigMutations.has(message.method)
          ) {
            if (!['string', 'number'].includes(typeof message.id))
              throw new Error('A context request needs an ID.');
            const transition = this.prepare(message.method, message.params);
            if (transition) {
              pending.set(message.id, transition);
              if ('handoff' in transition) {
                // Never send another agent's resume into this provider process.
                await transition.handoff();
                return close();
              }
              await transition.before?.();
              if (!pending.has(message.id)) return;
              if (
                provider.readyState !== WebSocket.OPEN ||
                provider.bufferedAmount > 4 * 1024 * 1024
              )
                return close();
              transition.submitted?.();
              send(provider, JSON.stringify({ ...message, params: transition.params }));
            } else send(provider, data);
          } else send(provider, data);
        } catch (error) {
          const transition = pending.get(message?.id);
          transition?.cancel();
          pending.delete(message?.id);
          if (message && ['string', 'number'].includes(typeof message.id))
            send(
              client,
              JSON.stringify({
                id: message.id,
                error: {
                  code: -32000,
                  message: error instanceof Error ? error.message : 'Native request refused.',
                },
              }),
            );
          else close();
          if (transition && !('handoff' in transition)) close();
        }
      };
      client.on('message', (data) => {
        if (provider.readyState === WebSocket.CONNECTING) {
          bufferedBytes += Buffer.byteLength(data.toString());
          if (bufferedBytes > 4 * 1024 * 1024) return close();
          buffered.push(data);
        } else void receive(data);
      });
      provider.on('open', () => {
        for (const data of buffered) void receive(data);
        buffered.length = 0;
      });
      provider.on('message', (data) => {
        void (async () => {
          const message = JSON.parse(data.toString());
          // The host is subscribed before native work can start and receives the
          // same request on its own connection. Codex 0.153.4's CLI immediately
          // declines URL mode; do not let that race the owner's approval card.
          // No reply is synthesized. Host validation/expiry and native interrupt
          // still apply; ordinary tool consent and forms remain unchanged.
          if (
            message.method === 'mcpServer/elicitation/request' &&
            message.params?.mode === 'url' &&
            ['string', 'number'].includes(typeof message.id)
          )
            return;
          const transition = !message.method ? pending.get(message.id) : undefined;
          if (transition && !('handoff' in transition)) {
            try {
              if (!message.error) await transition.finish(message.result);
            } catch (error) {
              send(
                client,
                JSON.stringify({
                  id: message.id,
                  error: {
                    code: -32000,
                    message:
                      error instanceof Error ? error.message : 'Native context could not attach.',
                  },
                }),
              );
              return close();
            } finally {
              transition.cancel(message.error ? 'rejected' : undefined);
              pending.delete(message.id);
            }
          }
          send(client, data);
        })().catch(close);
      });
      for (const socket of [client, provider]) {
        socket.on('error', close);
        socket.once('close', close);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.path, resolve);
    });
    chmodSync(this.path, 0o600);
  }
  close() {
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.wss.close();
    this.server.close();
  }
}
