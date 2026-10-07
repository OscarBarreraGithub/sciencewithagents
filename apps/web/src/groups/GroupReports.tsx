import { useEffect, useRef, useState } from 'react';
import { groupReportListSchema } from '@dock/shared/dist/group-documents.js';
import type { DocumentPublicationKey } from '@dock/shared/dist/group-document-transport.js';
import { api, apiScope } from '../api';
import PdfReader from '../PdfReader';
import './group-documents.css';
type Entry = ReturnType<typeof groupReportListSchema.parse>['entries'][number];
export function GroupReports({ handle }: { handle: string }) {
  const [entries, setEntries] = useState<Entry[]>([]),
    [next, setNext] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [selected, setSelected] = useState<DocumentPublicationKey | null>(null);
  const current = useRef(handle);
  current.current = handle;
  useEffect(() => {
    setEntries([]);
    setNext(null);
    setSelected(null);
    setNotice('');
  }, [handle]);
  const load = async (after = 0) => {
    setBusy(true);
    setNotice('');
    try {
      const page = groupReportListSchema.parse(await api('/groups/reports', { handle, after }));
      if (current.current !== handle) return;
      setEntries((old) => (after ? [...old, ...page.entries] : page.entries));
      setNext(page.next);
    } catch (error) {
      if (current.current === handle) setNotice((error as Error).message);
    } finally {
      if (current.current === handle) setBusy(false);
    }
  };
  const revoke = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const storage = `swa:report-revoke:${apiScope()}:${handle}:${selected.publicationId}:${selected.manifestHash}`;
      let key = sessionStorage.getItem(storage);
      if (!key) {
        key = crypto.randomUUID();
        sessionStorage.setItem(storage, key);
      }
      await api(
        `/groups/reports/${handle}/${selected.publicationId}/${selected.manifestHash}/revoke`,
        { key },
      );
      sessionStorage.removeItem(storage);
      setSelected(null);
      await load();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="group-host-members group-reports">
      <summary>Shared reports</summary>
      <p>
        Reports appear here only after their owner explicitly shares selected files. Reading and PDF
        downloads remain in this group.
      </p>
      <button disabled={busy} onClick={() => void load()}>
        Load shared reports
      </button>
      {entries.map((entry) => (
        <div key={entry.key.publicationId} className="group-report-row">
          <a
            href={`#/groups/report/${entry.key.publicationId}/${entry.key.manifestHash}`}
            onClick={(event) => {
              event.preventDefault();
              setSelected(entry.key);
            }}
          >
            {entry.manifest.title}
          </a>
          <small>
            {entry.manifest.files.reduce((n, file) => n + file.bytes, 0).toLocaleString()} bytes ·
            immutable shared copy
          </small>
        </div>
      ))}
      {next !== null && (
        <button disabled={busy} onClick={() => void load(next)}>
          More reports
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {selected && (
        <PdfReader
          id={selected.publicationId}
          endpoint={`/groups/reports/${handle}/${selected.publicationId}/${selected.manifestHash}`}
          scoped
          close={() => setSelected(null)}
          actions={
            <details>
              <summary>Report sharing</summary>
              <p>Only the original sharing owner can revoke this shared copy.</p>
              <button disabled={busy} onClick={() => void revoke()}>
                Revoke this shared copy
              </button>
              {notice && <p role="status">{notice}</p>}
            </details>
          }
        />
      )}
    </details>
  );
}
