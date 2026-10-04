import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FolderOpen, Home } from 'lucide-react';
import { folderBrowseSchema } from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';
import './FolderBrowser.css';

type Listing = ReturnType<typeof folderBrowseSchema.parse>;
export function FolderBrowser({
  close,
  select,
}: {
  close: () => void;
  select: (id: string) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const request = useRef(0);
  const last = useRef<{ id?: string; offset: number }>({ offset: 0 });
  const load = async (id?: string, offset = 0) => {
    const version = ++request.current;
    last.current = { id, offset };
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ offset: String(offset) });
      if (id) params.set('folderId', id);
      const value = folderBrowseSchema.parse(await api(`/project-folders?${params}`));
      if (version !== request.current) return;
      setListing((previous) =>
        offset && previous?.current.id === value.current.id
          ? { ...value, folders: [...previous.folders, ...value.folders] }
          : value,
      );
      if (!offset) setQuery('');
    } catch (reason) {
      if (version === request.current)
        setError(reason instanceof Error ? reason.message : 'Could not read folders. Try again.');
    } finally {
      if (version === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, []);
  const folders =
    listing?.folders.filter((folder) => folder.name.toLowerCase().includes(query.toLowerCase())) ??
    [];
  return (
    <Modal title="Choose a project folder" className="folder-browser" close={close}>
      <p>Folders on the selected computer. Your files stay where they are.</p>
      <div className="folder-browser-navigation">
        <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
          <Home size={18} />
          Home folder
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !listing?.parentId}
          onClick={() => void load(listing!.parentId!)}
        >
          <ArrowUp size={18} />
          Up
        </button>
      </div>
      {listing && (
        <>
          <strong className="folder-browser-current">{listing.current.name}</strong>
          <label>
            Find a folder in this list
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => void load(last.current.id, last.current.offset)}
          >
            Try again
          </button>
        </div>
      )}
      {busy && <p role="status">Loading folders…</p>}
      <div className="folder-browser-list" aria-busy={busy}>
        {folders.map((folder) => (
          <button
            type="button"
            key={folder.id}
            disabled={busy}
            onClick={() => void load(folder.id)}
          >
            <FolderOpen size={20} />
            <span>{folder.name}</span>
            <span aria-hidden="true">›</span>
          </button>
        ))}
        {listing && !busy && !folders.length && (
          <p>
            {query
              ? 'No matching folders in this list.'
              : 'No subfolders. You can select this folder.'}
          </p>
        )}
        {listing?.nextOffset !== null && listing?.nextOffset !== undefined && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void load(listing.current.id, listing.nextOffset!)}
          >
            Load more folders
          </button>
        )}
      </div>
      <div className="folder-browser-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !!error || !listing?.current.canSelect}
          onClick={() => select(listing!.current.id)}
        >
          Use this folder
        </button>
      </div>
      {listing && !listing.current.canSelect && <small>Open a project folder to select it.</small>}
    </Modal>
  );
}
