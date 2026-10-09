import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import {
  GROUP_UPDATE_LIMITS,
  groupUpdateSchema,
  groupHostUpdateSchema,
  type GroupHostUpdate,
  type GroupUpdateIdentity,
} from '@dock/shared/dist/group-updates.js';

type Destination = { url: string; headers: { [name: string]: string } };
type Channel = {
  identity: GroupUpdateIdentity;
  destination: () => Destination;
  peer?: WebSocket;
  retry?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  debounce?: ReturnType<typeof setTimeout>;
  connected: boolean;
  denied: boolean;
  failures: number;
};
const key = (identity: GroupUpdateIdentity) =>
  `${identity.groupId}:${identity.memberId}:${identity.installationId}`;
const signature = (destination: Destination) =>
  createHash('sha256').update(JSON.stringify(destination)).digest('hex');

/** One protected host connection per enrollment, shared by all authenticated
 * app event streams and local coordination. No payload/receipt or effect cache. */
export class GroupHostUpdates {
  private channels = new Map<string, Channel>();
  private listeners = new Set<(update: GroupHostUpdate) => void>();
  private closed = false;
  connected(identity: GroupUpdateIdentity) {
    return this.channels.get(key(identity))?.connected === true;
  }
  subscribe(listener: (update: GroupHostUpdate) => void) {
    this.listeners.add(listener);
    for (const channel of this.channels.values()) listener(this.view(channel, false));
    return () => {
      this.listeners.delete(listener);
    };
  }
  private view(channel: Channel, changed: boolean) {
    return groupHostUpdateSchema.parse({
      groupId: channel.identity.groupId,
      memberId: channel.identity.memberId,
      installationId: channel.identity.installationId,
      connected: channel.connected,
      changed,
    });
  }
  private emit(channel: Channel, changed: boolean) {
    const update = this.view(channel, changed);
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch {
        /* A disconnected reader cannot own transport. */
      }
    }
  }
  watch(identity: GroupUpdateIdentity, destination: () => Destination) {
    if (this.closed) return;
    const id = key(identity);
    if (this.channels.has(id)) return;
    if (this.channels.size >= 32) return;
    const channel: Channel = {
      identity: {
        groupId: identity.groupId,
        memberId: identity.memberId,
        installationId: identity.installationId,
      },
      destination,
      connected: false,
      denied: false,
      failures: 0,
    };
    this.channels.set(id, channel);
    this.open(channel);
  }
  /** Local removal releases this enrollment's transport slot without changing
   * membership, receipts or the authority used to finish existing delivery. */
  unwatch(identity: GroupUpdateIdentity) {
    const id = key(identity),
      channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    if (channel.retry) clearTimeout(channel.retry);
    if (channel.heartbeat) clearInterval(channel.heartbeat);
    if (channel.debounce) clearTimeout(channel.debounce);
    channel.retry = channel.heartbeat = channel.debounce = undefined;
    const peer = channel.peer;
    channel.peer = undefined;
    channel.connected = false;
    this.emit(channel, false);
    peer?.terminate();
  }
  private current(channel: Channel) {
    return !this.closed && this.channels.get(key(channel.identity)) === channel;
  }
  private open(channel: Channel) {
    if (!this.current(channel) || channel.denied || channel.peer) return;
    let destination: Destination;
    try {
      destination = channel.destination();
    } catch {
      this.retry(channel);
      return;
    }
    const retained = signature(destination);
    let peer: WebSocket;
    try {
      peer = new WebSocket(destination.url, {
        headers: destination.headers,
        handshakeTimeout: 5000,
        maxPayload: GROUP_UPDATE_LIMITS.frameBytes,
        followRedirects: false,
        perMessageDeflate: false,
      });
    } catch {
      this.retry(channel);
      return;
    }
    channel.peer = peer;
    let pong = true;
    peer.on('pong', () => {
      pong = true;
    });
    peer.on('open', () => {
      if (!this.current(channel) || channel.peer !== peer) {
        peer.close();
        return;
      }
      // Protocol pings are handled by the Cloudflare runtime without waking
      // the hibernating DO or performing an application/database request.
      channel.heartbeat = setInterval(() => {
        try {
          if (
            !this.current(channel) ||
            channel.peer !== peer ||
            signature(channel.destination()) !== retained
          )
            throw new Error('Binding changed');
        } catch {
          peer.terminate();
          return;
        }
        if (!pong) {
          peer.terminate();
          return;
        }
        pong = false;
        peer.ping();
      }, 30_000);
      channel.heartbeat.unref();
    });
    peer.on('message', (bytes, binary) => {
      if (!this.current(channel) || channel.peer !== peer) return;
      try {
        const body = Buffer.isBuffer(bytes)
          ? bytes
          : Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes);
        if (
          binary ||
          body.length > GROUP_UPDATE_LIMITS.frameBytes ||
          signature(channel.destination()) !== retained
        )
          throw new Error('Binding changed');
        const update = groupUpdateSchema.parse(JSON.parse(body.toString()));
        if (update.groupId !== channel.identity.groupId) throw new Error('Foreign group');
        if (update.kind === 'connected') {
          channel.connected = true;
          channel.failures = 0;
          this.emit(channel, true); // Reconcile after every connection/restart.
        } else if (channel.connected && !channel.debounce) {
          channel.debounce = setTimeout(() => {
            channel.debounce = undefined;
            if (this.current(channel) && channel.peer === peer && channel.connected)
              this.emit(channel, true);
          }, 150);
          channel.debounce.unref();
        }
      } catch {
        peer.close(1008, 'Unavailable');
      }
    });
    peer.on('unexpected-response', (_request, response) => {
      // An older service returns 400/404; use bounded disconnected fallback.
      // Revoked credentials stop reconnecting until a new enrollment is saved.
      channel.denied = response.statusCode === 403;
      response.resume();
      peer.terminate();
    });
    peer.on('error', () => {
      /* Close owns cleanup and finite backoff. */
    });
    peer.on('close', (code) => {
      if (channel.peer !== peer) return;
      channel.peer = undefined;
      if (channel.heartbeat) clearInterval(channel.heartbeat);
      channel.heartbeat = undefined;
      if (channel.debounce) clearTimeout(channel.debounce);
      channel.debounce = undefined;
      if (code === 4003) channel.denied = true;
      channel.connected = false;
      if (this.current(channel)) {
        this.emit(channel, false);
        this.retry(channel);
      }
    });
  }
  private retry(channel: Channel) {
    if (!this.current(channel) || channel.denied || channel.retry) return;
    // Avoid an upgrade storm against an old/offline service. Ordinary reads
    // still work through their own authority and disconnected poll cadence.
    const delay = Math.min(300_000, 30_000 * 2 ** Math.min(channel.failures++, 4));
    channel.retry = setTimeout(() => {
      channel.retry = undefined;
      this.open(channel);
    }, delay);
    channel.retry.unref();
  }
  close() {
    this.closed = true;
    for (const channel of this.channels.values()) this.unwatch(channel.identity);
    this.listeners.clear();
  }
}
