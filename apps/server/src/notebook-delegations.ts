import { notebookLifetimes } from './notebook-gateway.js';

type Action = 'renew' | 'revoke';
type Delegation = {
  stop(): void;
  unwatch?: () => void;
  timer?: NodeJS.Timeout;
  end?: NodeJS.Timeout;
};
/** Entry-side lifetime only. Notebook HTTP/WS travels directly to the selected host. */
export class NotebookDelegations {
  private active = new Map<string, Delegation>();
  constructor(private send: (hostId: string, action: Action, key: string) => Promise<void>) {}
  track(hostId: string, key: string, watch: (close: () => void) => () => void) {
    const id = `${hostId}:${key}`;
    if (this.active.has(id)) return;
    let ended = false;
    const stop = () => {
      if (ended) return;
      ended = true;
      clearInterval(delegation.timer);
      clearTimeout(delegation.end);
      delegation.unwatch?.();
      this.active.delete(id);
      // Failed delivery is bounded by the target's 90-second lease, never retried forever.
      void this.send(hostId, 'revoke', key).catch(() => {});
    };
    const delegation: Delegation = { stop };
    this.active.set(id, delegation);
    const unwatch = watch(stop);
    if (ended) {
      unwatch();
      return;
    }
    delegation.unwatch = unwatch;
    let renewing = false;
    delegation.timer = setInterval(() => {
      if (renewing || ended) return;
      renewing = true;
      void this.send(hostId, 'renew', key)
        .catch(stop)
        .finally(() => {
          renewing = false;
        });
    }, notebookLifetimes.renewalMs);
    delegation.timer.unref();
    delegation.end = setTimeout(stop, notebookLifetimes.sessionMs);
    delegation.end.unref();
  }
  close() {
    for (const item of [...this.active.values()]) item.stop();
  }
}
