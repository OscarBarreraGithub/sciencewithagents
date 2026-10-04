import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Code2,
  Download,
  FileText,
  Folder,
  HardDrive,
  Home,
  Monitor,
  Search,
  X,
} from 'lucide-react';
import { folderBrowseSchema } from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';
import './FolderBrowser.css';

type Listing = ReturnType<typeof folderBrowseSchema.parse>;
type Read = {
  id?: string;
  offset?: number;
  query?: string;
  scope?: 'children' | 'descendants';
  hidden?: boolean;
  historyIndex?: number;
};
const icons = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  developer: Code2,
  computer: HardDrive,
  volumes: HardDrive,
};
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
  const [scope, setScope] = useState<'children' | 'descendants'>('descendants');
  const [hidden, setHidden] = useState(false);
  const [history, setHistory] = useState<{ ids: string[]; index: number }>({ ids: [], index: -1 });
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const last = useRef<Read>({});
  const listRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<HTMLElement>(null);
  const load = async (read: Read = {}) => {
    const version = ++request.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    last.current = read;
    setBusy(true);
    setError('');
    try {
      const params = new URLSearchParams({ offset: String(read.offset ?? 0) });
      if (read.id) params.set('folderId', read.id);
      if (read.query) {
        params.set('query', read.query);
        params.set('scope', read.scope ?? 'descendants');
      }
      if (read.hidden) params.set('hidden', 'true');
      const value = folderBrowseSchema.parse(
        await api(`/project-folders?${params}`, undefined, abort.signal),
      );
      if (version !== request.current) return;
      setListing((previous) =>
        read.offset && previous?.current.id === value.current.id
          ? { ...value, folders: [...previous.folders, ...value.folders] }
          : value,
      );
      if (!read.offset) {
        if (listRef.current) listRef.current.scrollTop = 0;
      }
      setHistory((previous) => {
        if (read.historyIndex !== undefined) return { ...previous, index: read.historyIndex };
        if (previous.ids[previous.index] === value.current.id) return previous;
        const past = previous.ids.slice(0, previous.index + 1);
        const existing = past.indexOf(value.current.id);
        const ids = existing >= 0 ? past.slice(0, existing + 1) : [...past, value.current.id];
        return { ids, index: ids.length - 1 };
      });
    } catch (reason) {
      if (version === request.current && !abort.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Could not read folders. Try again.');
    } finally {
      if (version === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      request.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    // Keep the current folder visible on narrow screens; ancestors remain scrollable.
    if (pathRef.current) pathRef.current.scrollLeft = pathRef.current.scrollWidth;
  }, [listing?.current.id]);
  const navigate = (id?: string, historyIndex?: number) => {
    setQuery('');
    void load({ id, hidden, historyIndex });
  };
  const enhanced = !!listing?.locations.length;
  // Keep navigation usable while an older connected computer awaits its backend update.
  const folders =
    listing?.folders.filter(
      (folder) => enhanced || folder.name.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const breadcrumbs = listing?.breadcrumbs.length
    ? listing.breadcrumbs
    : listing
      ? [listing.current]
      : [];
  const search = (value = query, nextScope = scope, nextHidden = hidden) => {
    if (enhanced)
      void load({
        id: listing?.current.id,
        query: value.trim(),
        scope: nextScope,
        hidden: nextHidden,
      });
  };
  return (
    <Modal title="Choose a project folder" className="folder-browser" close={close}>
      <p className="folder-browser-description">Browse folders on the selected computer.</p>
      <div className="folder-browser-workspace">
        <nav className="folder-browser-places" aria-label="Locations">
          {(listing?.locations.length
            ? listing.locations
            : [{ id: '', name: 'Home', kind: 'home' as const }]
          ).map((place) => {
            const Icon = icons[place.kind];
            return (
              <button
                key={place.id}
                type="button"
                aria-current={listing?.current.id === place.id ? 'location' : undefined}
                onClick={() => navigate(place.kind === 'home' ? undefined : place.id)}
              >
                <Icon size={19} />
                <span>{place.name}</span>
              </button>
            );
          })}
        </nav>
        <div className="folder-browser-content">
          <div className="folder-browser-toolbar">
            <div className="folder-browser-history">
              <button
                type="button"
                aria-label="Previous folder"
                title="Previous folder"
                disabled={history.index <= 0}
                onClick={() => navigate(history.ids[history.index - 1], history.index - 1)}
              >
                <ArrowLeft size={19} />
              </button>
              <button
                type="button"
                aria-label="Next folder"
                title="Next folder"
                disabled={history.index >= history.ids.length - 1}
                onClick={() => navigate(history.ids[history.index + 1], history.index + 1)}
              >
                <ArrowRight size={19} />
              </button>
            </div>
            <form
              className="folder-browser-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                search();
              }}
            >
              <input
                type="search"
                aria-label="Search folders"
                placeholder={
                  enhanced ? `Search in ${listing?.current.name ?? 'Home'}` : 'Find a folder'
                }
                maxLength={120}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (!event.target.value && listing?.search) search('');
                }}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Clear folder search"
                  title="Clear search"
                  onClick={() => {
                    setQuery('');
                    if (enhanced) search('');
                  }}
                >
                  <X size={17} />
                </button>
              )}
              <button
                type="submit"
                aria-label="Search folders"
                title="Search folders"
                disabled={!listing}
              >
                <Search size={19} />
              </button>
            </form>
          </div>
          <nav ref={pathRef} className="folder-browser-path" aria-label="Folder path">
            {!enhanced && listing?.parentId && (
              <button type="button" onClick={() => navigate(listing.parentId!)}>
                Parent folder
              </button>
            )}
            {breadcrumbs.map((part, index) => (
              <span key={part.id}>
                {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
                <button
                  type="button"
                  aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}
                  onClick={() => navigate(part.id)}
                >
                  {part.name}
                </button>
              </span>
            ))}
          </nav>
          {enhanced && (
            <div className="folder-browser-options">
              <label>
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(event) => {
                    setHidden(event.target.checked);
                    search(query, scope, event.target.checked);
                  }}
                />
                Hidden folders
              </label>
              <label>
                <select
                  aria-label="Search scope"
                  value={scope}
                  onChange={(event) => {
                    const next = event.target.value as typeof scope;
                    setScope(next);
                    if (query) search(query, next);
                  }}
                >
                  <option value="descendants">Include subfolders</option>
                  <option value="children">This folder only</option>
                </select>
              </label>
            </div>
          )}
          {error && (
            <div role="alert" className="folder-browser-error">
              <p>{error}</p>
              <button type="button" onClick={() => void load(last.current)}>
                Try again
              </button>
            </div>
          )}
          <div className="folder-browser-list" ref={listRef} aria-label="Folders" aria-busy={busy}>
            {busy && (
              <p className="folder-browser-loading" role="status">
                {last.current.query ? 'Searching folders…' : 'Loading folders…'}
              </p>
            )}
            {!busy && listing?.search && (
              <p className="folder-browser-result-count" role="status">
                {folders.length} {folders.length === 1 ? 'folder' : 'folders'} found
                {listing.search.partial
                  ? ' · Search limited. Open a more specific folder to search further.'
                  : ''}
              </p>
            )}
            {folders.map((folder) => (
              <button
                type="button"
                key={`${folder.id}:${folder.name}`}
                disabled={busy}
                onClick={() => navigate(folder.id)}
              >
                <Folder size={23} aria-hidden="true" />
                <span>
                  <strong>{folder.name}</strong>
                  {folder.location && <small>{folder.location}</small>}
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
            {listing && !busy && !folders.length && (
              <p className="folder-browser-empty">
                {listing.search || query
                  ? 'No matching folders found here.'
                  : 'No subfolders in this folder.'}
              </p>
            )}
            {listing?.nextOffset !== null && listing?.nextOffset !== undefined && (
              <button
                className="folder-browser-more"
                type="button"
                disabled={busy}
                onClick={() =>
                  void load({ id: listing.current.id, offset: listing.nextOffset!, hidden })
                }
              >
                Load more folders
              </button>
            )}
          </div>
        </div>
      </div>
      <footer className="folder-browser-actions">
        <div className="folder-browser-selection">
          <Folder size={20} />
          <span>
            {listing?.current.canSelect
              ? listing.current.name
              : 'Open a project folder to select it.'}
          </span>
        </div>
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
      </footer>
    </Modal>
  );
}
