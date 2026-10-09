export const GROUP_POLLING = {
  idleMs: 60_000,
  activeMs: 5000,
  activeForMs: 30_000,
  rosterMs: 300_000,
  reconcileMs: 300_000,
} as const;

export type GroupPollEnvironment = {
  visible: () => boolean;
  now: () => number;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
  subscribe: (refresh: () => void) => () => void;
};
const browser: GroupPollEnvironment = {
  visible: () => !document.hidden,
  now: () => Date.now(),
  schedule: (callback, delay) => window.setTimeout(callback, delay),
  cancel: (timer) => window.clearTimeout(timer as number),
  subscribe: (refresh) => {
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  },
};

/** Read-only fallback. A change or unfinished receipt briefly increases cadence;
 * hidden views stop entirely. No result is retained as effect authorization. */
export function startGroupPolling(
  read: () => Promise<boolean | { changed: boolean; pending: boolean } | void>,
  options: {
    idleMs?: number;
    activeMs?: number;
    activeForMs?: number;
    immediate?: boolean;
    updates?: { connected: () => boolean; subscribe: (refresh: () => void) => () => void };
  } = {},
  environment: GroupPollEnvironment = browser,
) {
  const idleMs = options.idleMs ?? GROUP_POLLING.idleMs;
  const activeMs = options.activeMs ?? GROUP_POLLING.activeMs;
  const activeForMs = options.activeForMs ?? GROUP_POLLING.activeForMs;
  let timer: unknown;
  let stopped = false;
  let reading = false;
  let requested = false;
  let activeUntil = 0;
  let pending = false;
  const cancel = () => {
    if (timer !== undefined) environment.cancel(timer);
    timer = undefined;
  };
  const refresh = async () => {
    cancel();
    if (stopped || !environment.visible()) return;
    if (reading) {
      requested = true;
      return;
    }
    reading = true;
    try {
      const result = await read();
      pending = typeof result === 'object' && result.pending;
      if (result === true || (typeof result === 'object' && (result.changed || pending)))
        activeUntil = environment.now() + activeForMs;
    } catch {
      pending = false;
      // The reader owns its visible failure. A failed read cannot accelerate
      // requests indefinitely or leave an unhandled scheduling rejection.
    } finally {
      reading = false;
      if (!stopped && environment.visible()) {
        const delay = requested
          ? 0
          : options.updates?.connected()
            ? pending
              ? activeMs
              : GROUP_POLLING.reconcileMs
            : environment.now() < activeUntil
              ? activeMs
              : idleMs;
        requested = false;
        timer = environment.schedule(() => void refresh(), delay);
      }
    }
  };
  const wake = () => void refresh();
  const unsubscribe = environment.subscribe(wake);
  const unsubscribeUpdates = options.updates?.subscribe(wake);
  if (options.immediate !== false) wake();
  else if (environment.visible()) timer = environment.schedule(wake, idleMs);
  const stop = () => {
    stopped = true;
    cancel();
    unsubscribe();
    unsubscribeUpdates?.();
  };
  return Object.assign(stop, { refresh: wake });
}
