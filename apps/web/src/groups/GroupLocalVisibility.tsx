import { useEffect, useRef, useState } from 'react';
import {
  groupHostLocalVisibilitySchema,
  groupHostSummarySchema,
  type GroupHostSummary,
  groupHostListSchema,
} from '@dock/shared/dist/group-host.js';
import { api, apiScope, ApiError, connectionLost } from '../api';
import { Modal } from '../Modal';
import { DisplayName } from './DisplayName';

type GroupHostList = ReturnType<typeof groupHostListSchema.parse>;
type Operation = ReturnType<typeof groupHostLocalVisibilitySchema.parse>;
/** Local hiding retains enrollment/history; uncertain retries retain the exact change. */
export function GroupLocalVisibility({
  group,
  restore = false,
  refresh,
  onSettled,
}: {
  group: GroupHostSummary;
  restore?: boolean;
  refresh: () => Promise<GroupHostList>;
  onSettled?: (current: GroupHostList) => void;
}) {
  const storage = `swa:${apiScope()}:group-local-visibility:${group.handle}`;
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<Operation | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setBusy(false);
    let saved: Operation | null = null;
    try {
      const raw = sessionStorage.getItem(storage);
      const parsed =
        raw && raw.length < 4096 ? groupHostLocalVisibilitySchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success && parsed.data.handle === group.handle) saved = parsed.data;
    } catch {
      /* Damaged browser metadata cannot choose another enrollment. */
    }
    setPending(saved);
    setError('');
    setNotice('');
    setOpen(false);
    return () => {
      generation.current++;
    };
  }, [storage, group.handle]);
  const desiredHidden = pending?.hidden ?? !restore;
  const change = async () => {
    if (inFlight.current) return;
    const version = generation.current;
    const operation = pending ?? {
      handle: group.handle,
      key: crypto.randomUUID(),
      revision: group.local?.revision ?? 0,
      hidden: !restore,
    };
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    sessionStorage.setItem(storage, JSON.stringify(operation));
    setPending(operation);
    try {
      const receipt = groupHostSummarySchema.parse(
        await api('/groups/local-visibility', operation),
      );
      if (version !== generation.current) return;
      if (receipt.handle !== operation.handle || receipt.id !== group.id)
        throw new Error('This change did not match the saved group. Its retry is retained.');
      if (sessionStorage.getItem(storage) === JSON.stringify(operation))
        sessionStorage.removeItem(storage);
      setPending(null);
      setNotice('Saved change acknowledged. Checking the current list…');
      const current = await refresh();
      if (version !== generation.current) return;
      onSettled?.(current);
      setOpen(false);
    } catch (reason) {
      if (version !== generation.current) return;
      if (
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        !connectionLost(reason)
      ) {
        if (sessionStorage.getItem(storage) === JSON.stringify(operation))
          sessionStorage.removeItem(storage);
        setPending(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : 'The change is not confirmed. Keep this exact saved request.',
      );
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const check = async () => {
    if (inFlight.current) return;
    const version = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const current = await refresh();
      if (version !== generation.current) return;
      const value = [...current.groups, ...(current.removed ?? [])].find(
        (value) => value.handle === group.handle,
      );
      setNotice(
        value?.local?.hidden
          ? 'Currently hidden from this app. History and membership are retained.'
          : 'Currently shown in this app.',
      );
      if (!pending) onSettled?.(current);
    } catch (reason) {
      if (version === generation.current)
        setError(
          reason instanceof Error ? reason.message : 'The current setting could not be read.',
        );
    } finally {
      if (version === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <>
      <button className="secondary" type="button" onClick={() => setOpen(true)}>
        {pending ? 'Review saved list change' : restore ? 'Restore group' : 'Remove from my app'}
      </button>
      {open && (
        <Modal
          title={desiredHidden ? 'Remove group from my app' : 'Restore group to this app'}
          close={() => !busy && setOpen(false)}
        >
          <p>
            <strong>
              <DisplayName value={group.name} />
            </strong>
          </p>
          <p>
            Removing hides this group on this computer. Membership, messages, files and work are
            retained; you can restore it from Removed groups. It does not leave the group, stop
            creator hosting or delete shared cloud data.
          </p>
          {pending && (
            <p>
              The acknowledgement is uncertain. Retry only this exact saved change, or read the
              current setting. Checking does not repeat the change.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="groups-list-actions">
            <button className="primary" type="button" disabled={busy} onClick={() => void change()}>
              {pending ? 'Retry saved change' : desiredHidden ? 'Remove group' : 'Restore group'}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void check()}
            >
              Check current setting
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
