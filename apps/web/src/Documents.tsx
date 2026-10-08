import { lazy, Suspense, useEffect, useRef, useState, type ComponentProps } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Code2,
  Download,
  FileText,
  Folder,
  HardDrive,
  Home,
  Monitor,
  RefreshCw,
} from 'lucide-react';
import {
  documentBrowseResponseSchema,
  type SavedDocument,
  type DocumentBrowse,
} from '@dock/shared';
import { api, ApiError } from './api';
import { documentResponseSchema } from './document-responses';
import { ArxivImportForm } from './ArxivImport';
import './documents.css';

const Reader = lazy(() => import('./PdfReader'));
const documentId = (href: string) => /^#\/latex\/([0-9a-f-]{36})$/i.exec(href)?.[1];
const selected = () => new URL(location.href).searchParams.get('document');
const placeIcons: Record<string, typeof Folder> = {
  home: Home,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  developer: Code2,
  computer: HardDrive,
  volumes: HardDrive,
};
// Server errors are already sentences; never show a parser dump from an unexpected response.
const readable = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;
export function openDocument(id: string) {
  // A direct #/latex/id link mounts the library before the sibling overlay host.
  // Defer delivery until the current effect flush has installed its listener.
  queueMicrotask(() => window.dispatchEvent(new CustomEvent('dock:document', { detail: id })));
}
export function DocumentLink({
  href,
  children,
  saved,
}: ComponentProps<'a'> & { saved?: { agentId: string; entryId: string; index: number } }) {
  const id = href && documentId(href);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <a
        href={href}
        target={id ? undefined : '_blank'}
        rel="noreferrer"
        aria-busy={busy}
        onClick={(event) => {
          if (saved) {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            void api('/documents/from-message', saved)
              .then(documentResponseSchema.parse)
              .then((document) => openDocument(document.id))
              .catch((error) => setError(error.message))
              .finally(() => setBusy(false));
            return;
          }
          if (!id || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          openDocument(id);
        }}
      >
        {children}
      </a>
      {error && (
        <span role="alert" className="document-link-error">
          {' '}
          {error}
        </span>
      )}
    </>
  );
}

/** An overlay keeps the conversation (including older loaded messages) mounted. */
export function DocumentHost() {
  const [id, setId] = useState(selected);
  const scroll = useRef<{ node: Element; top: number; left: number }[]>([]);
  const focus = useRef<HTMLElement | null>(null);
  const captured = useRef(false);
  const restoration = useRef<ScrollRestoration>('auto');
  const capture = () => {
    if (captured.current) return;
    captured.current = true;
    restoration.current = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scroll.current = [
      ...document.querySelectorAll(
        '.home-content, .conversation, .mirror-log, .assistant-fullscreen-body',
      ),
    ].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    document.documentElement.dataset.pdfOpen = 'true';
  };
  useEffect(() => {
    const change = () => setId(selected());
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!/^[0-9a-f-]{36}$/i.test(id) || selected() === id) return;
      capture();
      const url = new URL(location.href);
      url.searchParams.set('document', id);
      history.pushState({ ...history.state, swaDocument: true }, '', url);
      change();
    };
    window.addEventListener('dock:document', open);
    window.addEventListener('popstate', change);
    return () => {
      window.removeEventListener('dock:document', open);
      window.removeEventListener('popstate', change);
    };
  }, []);
  useEffect(() => {
    if (!id) return;
    capture();
    return () => {
      // Dialog focus restoration and browser history run after popstate. Restore
      // after the dialog has left the top layer, keeping chat auto-follow frozen.
      requestAnimationFrame(() => {
        if (selected()) return;
        const restore = () => {
          for (const item of scroll.current) {
            item.node.scrollTop = item.top;
            item.node.scrollLeft = item.left;
          }
        };
        restore();
        requestAnimationFrame(() => {
          if (selected()) return;
          focus.current?.focus({ preventScroll: true });
          restore();
          delete document.documentElement.dataset.pdfOpen;
          history.scrollRestoration = restoration.current;
          captured.current = false;
        });
      });
    };
  }, [id]);
  const close = () => {
    if (history.state?.swaDocument) history.back();
    else {
      const url = new URL(location.href);
      url.searchParams.delete('document');
      history.replaceState(history.state, '', url);
      setId(null);
    }
  };
  return id ? (
    <Suspense
      fallback={
        <div className="pdf-opening" role="status">
          Opening document… <button onClick={close}>Cancel</button>
        </div>
      }
    >
      <Reader key={id} id={id} close={close} />
    </Suspense>
  ) : null;
}

export function LatexApp({ initialId }: { initialId?: string }) {
  const [recent, setRecent] = useState<SavedDocument[]>([]);
  const [compiler, setCompiler] = useState<string | null | undefined>();
  const [browse, setBrowse] = useState<DocumentBrowse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [filter, setFilter] = useState('');
  const request = useRef(0);
  const pathRef = useRef<HTMLElement>(null);
  const loadRecent = () =>
    api<{ documents: unknown[]; compiler: string | null }>('/documents')
      .then((result) => {
        setRecent(result.documents.map((value) => documentResponseSchema.parse(value)));
        setCompiler(result.compiler);
      })
      .catch((error) =>
        setError(readable(error, 'Recent documents could not be read. Reload and try again.')),
      );
  useEffect(() => {
    void loadRecent();
    const update = () => {
      if (!selected()) void loadRecent();
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  useEffect(() => {
    if (initialId && /^[0-9a-f-]{36}$/i.test(initialId) && !selected()) openDocument(initialId);
  }, [initialId]);
  async function folder(id?: string, offset = 0, append = false) {
    const number = ++request.current;
    setBusy(true);
    setError('');
    setBrowsing(true);
    setFilter('');
    try {
      const result = documentBrowseResponseSchema.parse(
        await api(
          `/documents/browse?${new URLSearchParams({ ...(id ? { folderId: id } : {}), offset: String(offset) })}`,
        ),
      );
      if (number === request.current)
        setBrowse((old) =>
          append && old
            ? {
                ...result,
                folders: [...old.folders, ...result.folders],
                files: [...old.files, ...result.files],
              }
            : result,
        );
    } catch (error) {
      if (number === request.current)
        setError(readable(error, 'This folder could not be read. Reload and try again.'));
    } finally {
      if (number === request.current) setBusy(false);
    }
  }
  const file = (doc: SavedDocument) => (
    <button key={doc.id} className="latex-file" onClick={() => openDocument(doc.id)}>
      <FileText aria-hidden="true" size={22} />
      <span>
        <strong>{doc.name}</strong>
        <small>
          {doc.arxiv ? `arXiv ${doc.arxiv.id}v${doc.arxiv.version}` : doc.folder} ·{' '}
          {doc.kind === 'tex' ? 'LaTeX' : 'PDF'}
          {doc.hasPdf ? ' · PDF ready' : ''}
        </small>
      </span>
      <ChevronRight size={18} />
    </button>
  );
  useEffect(() => {
    // Keep the current folder visible on narrow screens; ancestors remain scrollable.
    if (pathRef.current) pathRef.current.scrollLeft = pathRef.current.scrollWidth;
  }, [browse?.current.id]);
  const breadcrumbs = browse?.breadcrumbs.length
    ? browse.breadcrumbs
    : browse
      ? [browse.current]
      : [];
  const matches = (name: string) => name.toLocaleLowerCase().includes(filter.toLocaleLowerCase());
  return (
    <section className="latex-app">
      <header>
        <span className="latex-app-icon" aria-hidden="true">
          T<span>E</span>X
        </span>
        <div>
          <h1>LaTeX</h1>
          <p>Read PDFs and turn LaTeX files into documents.</p>
        </div>
      </header>
      <button className="flow-button primary" onClick={() => void folder()}>
        <Folder size={20} /> Browse this computer
      </button>
      <ArxivImportForm
        onReady={(document) => {
          setRecent((old) => [document, ...old.filter((item) => item.id !== document.id)]);
          openDocument(document.id);
        }}
      />
      {compiler === null && (
        <p className="latex-note">
          PDFs open directly. To build .tex files, ask your setup agent to install Tectonic or TeX
          Live with latexmk on this computer.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {browsing && (
        <section className="latex-browser" aria-label="Files on this computer">
          <header>
            <button
              disabled={busy || !browse?.parentId}
              aria-label="Parent folder"
              onClick={() => void folder(browse?.parentId ?? undefined)}
            >
              <ArrowLeft size={20} />
            </button>
            <h2>{browse?.current.name ?? 'This computer'}</h2>
            <button
              aria-label="Refresh folder"
              disabled={busy}
              onClick={() => void folder(browse?.current.id)}
            >
              <RefreshCw size={18} />
            </button>
          </header>
          {!!browse?.locations.length && (
            <nav className="latex-places" aria-label="Locations">
              {browse.locations.map((place) => {
                const Icon = placeIcons[place.kind] ?? Folder;
                return (
                  <button
                    key={place.id}
                    type="button"
                    disabled={busy}
                    aria-current={browse.current.id === place.id ? 'location' : undefined}
                    onClick={() => void folder(place.id)}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span>{place.name}</span>
                  </button>
                );
              })}
            </nav>
          )}
          {breadcrumbs.length > 1 && (
            <nav ref={pathRef} className="latex-path" aria-label="Folder path">
              {breadcrumbs.map((part, index) => (
                <span key={part.id}>
                  {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
                  <button
                    type="button"
                    disabled={busy}
                    aria-current={index === breadcrumbs.length - 1 ? 'location' : undefined}
                    onClick={() => void folder(part.id)}
                  >
                    {part.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
          <label className="latex-filter">
            Find in this folder
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="File or folder name"
              type="search"
            />
          </label>
          {busy && <p role="status">Reading files…</p>}
          <div className="latex-files" aria-busy={busy}>
            {browse?.folders
              .filter((item) => matches(item.name))
              .map((item) => (
                <button
                  className="latex-file"
                  key={item.id}
                  disabled={busy}
                  onClick={() => void folder(item.id)}
                >
                  <Folder size={22} />
                  <span>{item.name}</span>
                  <ChevronRight size={18} />
                </button>
              ))}
            {browse?.files.filter((item) => matches(item.name)).map(file)}
            {!busy && browse && !browse.folders.length && !browse.files.length && (
              <p>No folders, .tex files or PDFs here.</p>
            )}
            {!busy &&
              filter &&
              browse &&
              ![...browse.folders, ...browse.files].some((item) => matches(item.name)) && (
                <p>No matching files in the loaded list.</p>
              )}
          </div>
          {browse && (browse.nextOffset !== null || browse.nextFileOffset !== null) && (
            <button
              disabled={busy}
              onClick={() =>
                void folder(
                  browse.current.id,
                  Math.min(
                    ...[browse.nextOffset, browse.nextFileOffset].filter(
                      (x): x is number => x !== null,
                    ),
                  ),
                  true,
                )
              }
            >
              Load more
            </button>
          )}
        </section>
      )}
      <section aria-label="Recent documents">
        <h2>Recent documents</h2>
        {recent.length ? (
          <div className="latex-recents">{recent.map(file)}</div>
        ) : (
          <p className="latex-note">
            Documents you open appear here. Files stay on the selected computer.
          </p>
        )}
      </section>
    </section>
  );
}
