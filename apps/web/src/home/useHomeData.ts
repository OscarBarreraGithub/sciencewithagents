import { useEffect, useRef, useState } from 'react';
import {
  capacityStatusSchema,
  frontdeskStatusSchema,
  hostsStatusSchema,
  localJobsStatusSchema,
  mirrorWindowSchema,
  pulsarStatusSchema,
  resourceStatusSchema,
  snapshotSchema,
  clusterStatusSchema,
} from '@dock/shared';
import { api, controllerApi } from '../api';
import { trackRefresh } from './refreshHome';

const mirrorsSchema = mirrorWindowSchema.array();

// The new home is an observation surface. No session restoration, model turns,
// workspace writes or provider refresh requests happen when it is opened.
export function useReading<T>(
  path: string,
  parse: (value: unknown) => T,
  readApi = api,
  enabled = true,
) {
  const [reading, setReading] = useState<{ data: T | null; error: boolean; loaded: boolean }>({
    data: null,
    error: false,
    loaded: false,
  });
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) {
      retry.current = () => {};
      return;
    }
    let alive = true;
    let pending: Promise<boolean> | null = null;
    let followUp: Promise<boolean> | null = null;
    let controller: AbortController | undefined;
    const read = () => {
      if (pending) return pending;
      controller = new AbortController();
      const signal = controller.signal;
      const timeout = window.setTimeout(() => controller?.abort(), 15_000);
      pending = (async () => {
        try {
          const data = parse(await readApi(path, undefined, signal));
          if (alive) setReading({ data, error: false, loaded: true });
          return true;
        } catch {
          if (alive) setReading((old) => ({ ...old, error: true, loaded: true }));
          return false;
        } finally {
          window.clearTimeout(timeout);
          pending = null;
        }
      })();
      return pending;
    };
    const requestedRead = () => {
      if (!pending) return read();
      // An explicit refresh may follow a mutation newer than the in-flight response.
      // Coalesce those requests into one fresh read, and make their callers wait for it.
      followUp ??= pending.then(() => {
        followUp = null;
        return alive ? read() : false;
      });
      return followUp;
    };
    const refresh = () => {
      if (!document.hidden) void read();
    };
    const requested = (event: Event) => trackRefresh(event, requestedRead());
    retry.current = () => void requestedRead();
    void read();
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('swa:refresh-home', requested);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('swa:refresh-home', requested);
    };
  }, [path, parse, readApi, enabled]);
  return { ...reading, retry: () => retry.current() };
}

export function useHomeData() {
  return {
    snapshot: useReading('/snapshot', snapshotSchema.parse),
    frontdesk: useReading('/frontdesk', frontdeskStatusSchema.parse),
    capacity: useReading('/capacity', capacityStatusSchema.parse),
    hosts: useReading('/hosts', hostsStatusSchema.parse),
    work: useReading('/pulsar', pulsarStatusSchema.parse),
    resources: useReading('/resources', resourceStatusSchema.parse),
    local: useReading('/local-jobs', localJobsStatusSchema.parse),
    cluster: useReading('/cluster', clusterStatusSchema.parse, controllerApi),
    mirrors: useReading('/vscode/windows', mirrorsSchema.parse),
  };
}
export type HomeData = ReturnType<typeof useHomeData>;
