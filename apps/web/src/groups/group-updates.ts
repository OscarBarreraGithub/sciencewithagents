import { groupHostUpdateSchema, type GroupUpdateIdentity } from '@dock/shared';
import { apiScope, apiUrl } from '../api';
type Reading = { connected: boolean };
const readings = new Map<string, Reading>();
const listeners = new Map<string, Set<() => void>>();
const identityKey = (identity: GroupUpdateIdentity, scope: string) =>
  `${scope}:${identity.groupId}:${identity.memberId}:${identity.installationId}`;

/** Metadata only, scoped to the authenticated selected host event stream. */
export function receiveGroupUpdate(input: unknown, scope = apiScope()) {
  const parsed = groupHostUpdateSchema.safeParse(input);
  if (!parsed.success) return;
  const id = identityKey(parsed.data, scope);
  if (!readings.has(id) && readings.size >= 128) return;
  readings.set(id, { connected: parsed.data.connected });
  if (parsed.data.changed || !parsed.data.connected)
    listeners.get(id)?.forEach((refresh) => refresh());
}
export function resetGroupUpdates(scope = apiScope()) {
  for (const [id, value] of readings) {
    if (!id.startsWith(`${scope}:`)) continue;
    const connected = value.connected;
    value.connected = false;
    if (connected) listeners.get(id)?.forEach((refresh) => refresh());
  }
}
/** The normal Home/Groups surface has no legacy workspace event stream. Reuse
 * its fixed authenticated endpoint, with no historical event replay needed for
 * ephemeral hints: a future cursor is reset to the current head by the server. */
export function observeGroupUpdates() {
  const scope = apiScope();
  resetGroupUpdates(scope);
  const source = new EventSource(apiUrl(`/events?after=${Number.MAX_SAFE_INTEGER}`));
  let active = true;
  source.addEventListener('group', (event) => {
    if (!active || apiScope() !== scope) return;
    try {
      const data = (event as MessageEvent<string>).data;
      if (data.length <= 1024) receiveGroupUpdate(JSON.parse(data), scope);
    } catch {
      /* Unreadable hints never become freshness or authority. */
    }
  });
  source.onerror = () => {
    if (active) resetGroupUpdates(scope);
  };
  return () => {
    active = false;
    source.close();
    resetGroupUpdates(scope);
  };
}
export function groupPollingUpdates(identity: GroupUpdateIdentity) {
  const scope = apiScope(),
    id = identityKey(identity, scope);
  return {
    connected: () => readings.get(id)?.connected === true,
    subscribe: (refresh: () => void) => {
      const set = listeners.get(id) ?? new Set<() => void>();
      set.add(refresh);
      listeners.set(id, set);
      return () => {
        set.delete(refresh);
        if (!set.size) listeners.delete(id);
      };
    },
  };
}
