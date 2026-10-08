import { detailSchema, snapshotSchema, modelSchema, type AgentDetailChannel } from '@dock/shared';
// A notification tap opens a new document with `?computer=entry`: its subscription belongs to
// this entry computer. The marker stays in this document's address, so reloads and in-app
// routes keep that computer; only an explicit choice here (selectComputer) removes it. The
// saved selection, other tabs and their drafts are unchanged.
const entryPinned = new URLSearchParams(location.search).get('computer') === 'entry';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ClusterContext = { controllerHost: string; projectId: string };
function storedContext(): { computer: string; cluster: ClusterContext | null } {
  if (entryPinned) return { computer: 'local', cluster: null };
  const pinned = new URLSearchParams(location.search).get('computer');
  if (pinned === 'local' || (pinned && uuid.test(pinned)))
    return { computer: pinned, cluster: null };
  let computer = 'local';
  try {
    const selected = localStorage.getItem('dock:host');
    if (selected && uuid.test(selected)) computer = selected;
    const saved: unknown = JSON.parse(localStorage.getItem('dock:cluster-project') ?? 'null');
    if (
      saved &&
      typeof saved === 'object' &&
      'controllerHost' in saved &&
      'projectId' in saved &&
      saved.controllerHost === computer &&
      typeof saved.projectId === 'string' &&
      uuid.test(saved.projectId)
    )
      return { computer, cluster: { controllerHost: computer, projectId: saved.projectId } };
  } catch {
    // Missing browser storage or a malformed saved destination opens the computer itself.
  }
  return { computer, cluster: null };
}
// Each document pins its own controller/project. Another tab cannot retarget its callbacks,
// uploads, caches or drafts while requests are in flight.
const documentContext = storedContext();
const documentScope = documentContext.cluster
  ? `cluster:${documentContext.computer}:${documentContext.cluster.projectId}`
  : documentContext.computer;
export function apiScope() {
  return documentScope;
}
export function apiComputer() {
  return documentContext.computer;
}
export function apiCluster() {
  return documentContext.cluster;
}
const reopen = (hash: string) => {
  const url = new URL(location.href);
  url.searchParams.delete('computer');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${hash}`);
  location.reload();
};
export function selectComputer(id: string, hash = location.hash) {
  if (id !== 'local' && !uuid.test(id)) throw new Error('This computer could not be selected.');
  try {
    localStorage.setItem('dock:host', id);
    localStorage.removeItem('dock:cluster-project');
  } catch {
    throw new Error(
      'This browser could not save the computer choice. Allow browser storage and try again.',
    );
  }
  reopen(hash);
}
/** Only an ID returned by the controller is used; host credentials never enter browser state. */
export function selectClusterProject(projectId: string, hash = location.hash) {
  if (!uuid.test(projectId)) throw new Error('This cluster project could not be opened.');
  try {
    localStorage.setItem('dock:host', documentContext.computer);
    localStorage.setItem(
      'dock:cluster-project',
      JSON.stringify({ controllerHost: documentContext.computer, projectId }),
    );
  } catch {
    throw new Error(
      'This browser could not save the cluster choice. Your unsent request is retained; allow browser storage and retry.',
    );
  }
  reopen(hash);
}
/** A return pins this tab's original controller without erasing another tab's newer choice. */
export function leaveClusterProject(hash = '#/chats') {
  const cluster = documentContext.cluster;
  try {
    const saved = JSON.parse(localStorage.getItem('dock:cluster-project') ?? 'null');
    if (
      cluster &&
      saved?.controllerHost === cluster.controllerHost &&
      saved?.projectId === cluster.projectId
    )
      localStorage.removeItem('dock:cluster-project');
  } catch {
    /* A return remains available without browser storage. */
  }
  const url = new URL(location.href);
  url.searchParams.set('computer', documentContext.computer);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${hash}`);
  location.reload();
}
export function apiUrl(path: string) {
  // Device enrollment and push subscriptions always belong to the entry computer.
  const pathname = path.split('?')[0]!;
  const local =
    pathname.startsWith('/phone/') ||
    pathname === '/hosts' ||
    pathname.startsWith('/hosts/') ||
    pathname === '/notifications' ||
    pathname.startsWith('/notifications/');
  if (local) return `/api${path}`;
  const cluster = documentContext.cluster;
  const nested = cluster ? `/cluster/projects/${cluster.projectId}/proxy${path}` : path;
  return `/api${documentContext.computer === 'local' ? '' : `/hosts/${documentContext.computer}/proxy`}${nested}`;
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
/** A request whose delivery is unknown: offline, timed out, or cut off by a tunnel/proxy. */
export const connectionLost = (error: unknown) =>
  error instanceof TypeError ||
  (error instanceof ApiError &&
    (error.code === 'OFFLINE' || error.code === 'REQUEST_TIMEOUT' || error.code === 'INTERRUPTED'));
export function api<T = unknown>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  return request<T>(apiUrl(path), path, body, signal, timeoutMs);
}
/** Reconnect and account/project controls address the controller before its private runtime exists. */
export function controllerApi<T = unknown>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  const prefix =
    documentContext.computer === 'local' ? '' : `/hosts/${documentContext.computer}/proxy`;
  return request<T>(`/api${prefix}${path}`, path, body, signal, timeoutMs);
}
/** Exact policy save to this tab's controller, including from a cluster project. */
export function saveSlurmPolicy<T = unknown>(body: unknown): Promise<T> {
  const prefix =
    documentContext.computer === 'local' ? '' : `/hosts/${documentContext.computer}/proxy`;
  return request<T>(
    `/api${prefix}/slurm-review/policy`,
    '/slurm-review/policy',
    body,
    undefined,
    30_000,
    'PUT',
  );
}
async function request<T>(
  url: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            method,
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
        'INTERRUPTED',
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
/** The server derives each channel; omitted means every saved entry. */
export const detail = async (id: string, before?: string, channel?: AgentDetailChannel) => {
  const query = new URLSearchParams();
  if (before) query.set('before', before);
  if (channel && channel !== 'all') query.set('channel', channel);
  return detailSchema.parse(await api(`/agents/${id}${query.size ? `?${query}` : ''}`));
};
export const models = async (agentId?: string, provider?: 'codex' | 'claude') => {
  const query = new URLSearchParams();
  if (agentId) query.set('agentId', agentId);
  if (provider) query.set('provider', provider);
  return modelSchema.array().parse(await api(`/models${query.size ? `?${query}` : ''}`));
};
