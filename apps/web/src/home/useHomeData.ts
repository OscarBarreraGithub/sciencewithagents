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
} from '@dock/shared';
import { api } from '../api';

const mirrorsSchema = mirrorWindowSchema.array();

// The new home is an observation surface. No session restoration, model turns,
// workspace writes or provider refresh requests happen when it is opened.
export function useReading<T>(path: string, parse: (value: unknown) => T) {
  const [reading, setReading] = useState<{ data: T | null; error: boolean; loaded: boolean }>({
    data: null,
    error: false,
    loaded: false,
  });
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = parse(await api(path));
        if (alive) setReading({ data, error: false, loaded: true });
      } catch {
        if (alive) setReading((old) => ({ ...old, error: true, loaded: true }));
      } finally {
        pending = false;
      }
    };
    const refresh = () => {
      if (!document.hidden) void read();
    };
    retry.current = () => void read();
    void read();
    const timer = window.setInterval(refresh, 10_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('swa:refresh-home', refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('swa:refresh-home', refresh);
    };
  }, [path, parse]);
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
    mirrors: useReading('/vscode/windows', mirrorsSchema.parse),
  };
}
export type HomeData = ReturnType<typeof useHomeData>;
