import { detailSchema, snapshotSchema, modelSchema } from '@dock/shared';
// The selector is local UI state. Server-side host configuration remains the authority.
function storedScope() {
  const selected = localStorage.getItem('dock:host');
  return selected && /^[0-9a-f-]{36}$/i.test(selected) ? selected : 'local';
}
// A document never changes account underneath an in-flight form callback. Computer
// selection creates a new document; late continuations keep their original target.
const documentScope = storedScope();
export function apiScope() {
  // localStorage is shared by tabs, but an already-open tab keeps its own computer.
  // UI labels and draft keys must agree with the pinned request route until reload.
  return documentScope;
}
export function apiUrl(path: string) {
  const scope = documentScope;
  // Device enrollment belongs to the entry computer, never a selected downstream host.
  const local = path.startsWith('/phone/') || path === '/hosts' || path.startsWith('/hosts/');
  return `/api${scope === 'local' || local ? '' : `/hosts/${scope}/proxy`}${path}`;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reconnectUrl?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T = unknown>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(apiUrl(path), {
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    // A tunnel outage or unavailable provider is not an expired phone session.
    if (response.status === 401 && path !== '/phone/status')
      window.dispatchEvent(new Event('dock:authentication-required'));
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new ApiError(
        'The computer connection was interrupted. Your work is retained; try again when it reconnects.',
        response.status,
      );
    const value = (await response.json()) as {
      error?: string;
      code?: string;
      reconnectUrl?: string;
    };
    if (!response.ok)
      throw new ApiError(
        value.error || `Request failed (${response.status}).`,
        response.status,
        value.code,
        value.reconnectUrl,
      );
    return value as T;
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    if (controller.signal.aborted)
      throw new ApiError(
        'This computer took too long to respond. Your draft is retained. Reconnect and retry the same message to check its delivery.',
        0,
        'REQUEST_TIMEOUT',
      );
    if (error instanceof TypeError)
      throw new ApiError(
        'Cannot reach this computer. Your draft is retained; reconnect before retrying.',
        0,
        'OFFLINE',
      );
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
export const snapshot = async () => snapshotSchema.parse(await api('/snapshot'));
export const detail = async (id: string, before?: string) =>
  detailSchema.parse(
    await api(`/agents/${id}${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  );
export const models = async (agentId?: string, provider?: 'codex' | 'claude') => {
  const query = new URLSearchParams();
  if (agentId) query.set('agentId', agentId);
  if (provider) query.set('provider', provider);
  return modelSchema.array().parse(await api(`/models${query.size ? `?${query}` : ''}`));
};
