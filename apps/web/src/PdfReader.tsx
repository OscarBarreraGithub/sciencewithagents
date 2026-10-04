import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Minus, Plus, RefreshCw } from 'lucide-react';
import {
  documentReadingSchema,
  type DocumentReading as Reading,
  documentSchema,
  type SavedDocument,
} from '@dock/shared';
import type { PDFViewer as Viewer } from 'pdfjs-dist/types/web/pdf_viewer';
import { api, apiScope, apiUrl } from './api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { DocumentReading } from './DocumentReading';

type Position = { page: number; scale: string; top: number; left: number; width: number };
function PdfPages({
  doc,
  onReady,
  onFailure,
  controller,
}: {
  doc: SavedDocument;
  onReady: (pages: number, page: number, scale: number) => void;
  onFailure: (message: string) => void;
  controller: React.RefObject<Viewer | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current!;
    const key = `dock:pdf:${apiScope()}:${doc.id}`;
    let disposed = false;
    let destroy: (() => void) | undefined;
    let cleanup: (() => void) | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const { PDFViewer, EventBus, PDFLinkService } = await import('pdfjs-dist/web/pdf_viewer.mjs');
      if (disposed) return;
      const bus = new EventBus();
      const links = new PDFLinkService({
        eventBus: bus,
        externalLinkTarget: 2,
        externalLinkRel: 'noopener noreferrer',
      });
      const viewer = new PDFViewer({
        container: element,
        viewer: pages.current!,
        eventBus: bus,
        linkService: links,
        removePageBorders: true,
        maxCanvasPixels: 2 * 1024 ** 2,
        maxCanvasDim: 4096,
        annotationMode: 1,
        enableDetailCanvas: true,
      });
      controller.current = viewer;
      links.setViewer(viewer);
      const task = pdfjs.getDocument({
        url: apiUrl(`/documents/${doc.id}/pdf`),
        cMapUrl: '/pdf-assets/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/pdf-assets/standard_fonts/',
        wasmUrl: '/pdf-assets/wasm/',
        iccUrl: '/pdf-assets/iccs/',
        useWasm: false,
        disableRange: true,
        disableStream: true,
      });
      destroy = () => {
        viewer.setDocument(null!);
        links.setDocument(null!);
        void task.destroy();
        controller.current = null;
      };
      const pdf = await task.promise;
      if (disposed) {
        destroy();
        return;
      }
      const report = () => onReady(pdf.numPages, viewer.currentPageNumber, viewer.currentScale);
      let saved: Position | undefined;
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined;
      } catch {
        /* Storage can be unavailable. */
      }
      bus.on('pagesinit', () => {
        viewer.currentScaleValue = saved?.scale ?? 'page-width';
        viewer.currentPageNumber = Math.min(Math.max(saved?.page ?? 1, 1), pdf.numPages);
        if (saved && Math.abs(saved.width - element.clientWidth) < 2) {
          element.scrollTop = saved.top;
          element.scrollLeft = saved.left;
        }
        report();
      });
      bus.on('pagechanging', report);
      bus.on('scalechanging', report);
      bus.on('pagerendered', (event: { error?: Error }) => {
        if (event.error)
          onFailure('A page could not be rendered. Try downloading the PDF or rebuilding it.');
      });
      links.setDocument(pdf);
      viewer.setDocument(pdf);
      let pinch: { distance: number; scale: number; x: number; y: number } | null = null;
      let swipe: { x: number; y: number; at: number } | null = null;
      const distance = (a: Touch, b: Touch) =>
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const start = (event: TouchEvent) => {
        if (event.touches.length === 2) {
          const [a, b] = [event.touches[0]!, event.touches[1]!];
          pinch = {
            distance: distance(a, b),
            scale: viewer.currentScale,
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2,
          };
          swipe = null;
          event.preventDefault();
        } else if (
          event.touches.length === 1 &&
          element.scrollLeft < 2 &&
          element.scrollWidth <= element.clientWidth + 4
        ) {
          const touch = event.touches[0]!;
          swipe = { x: touch.clientX, y: touch.clientY, at: Date.now() };
        }
      };
      const move = (event: TouchEvent) => {
        if (pinch && event.touches.length === 2) {
          event.preventDefault();
          const scale = Math.min(
            4,
            Math.max(
              0.2,
              (pinch.scale * distance(event.touches[0]!, event.touches[1]!)) / pinch.distance,
            ),
          );
          viewer.updateScale({
            scaleFactor: scale / viewer.currentScale,
            drawingDelay: 150,
            origin: [pinch.x, pinch.y],
          });
        }
      };
      const end = (event: TouchEvent) => {
        if (swipe && event.changedTouches[0] && !event.touches.length) {
          const touch = event.changedTouches[0];
          if (
            touch.clientX - swipe.x > 100 &&
            Math.abs(touch.clientY - swipe.y) < 35 &&
            Date.now() - swipe.at < 700
          )
            element.dispatchEvent(new CustomEvent('pdf:back', { bubbles: true }));
        }
        swipe = null;
        if (event.touches.length < 2) pinch = null;
      };
      element.addEventListener('touchstart', start, { passive: false });
      element.addEventListener('touchmove', move, { passive: false });
      element.addEventListener('touchend', end);
      const resize = new ResizeObserver(() => {
        if (['page-width', 'page-fit'].includes(viewer.currentScaleValue))
          viewer.currentScaleValue = viewer.currentScaleValue;
        viewer.update();
      });
      resize.observe(element);
      cleanup = () => {
        try {
          localStorage.setItem(
            key,
            JSON.stringify({
              page: viewer.currentPageNumber,
              scale: viewer.currentScaleValue,
              top: element.scrollTop,
              left: element.scrollLeft,
              width: element.clientWidth,
            } satisfies Position),
          );
        } catch {
          /* Optional reading-position cache. */
        }
        resize.disconnect();
        element.removeEventListener('touchstart', start);
        element.removeEventListener('touchmove', move);
        element.removeEventListener('touchend', end);
      };
    })().catch((error) => {
      if (!disposed)
        onFailure(
          error instanceof Error
            ? `Could not open this PDF: ${error.message}`
            : 'Could not open this PDF. Try rebuilding it.',
        );
    });
    return () => {
      disposed = true;
      cleanup?.();
      destroy?.();
    };
  }, [doc.id, doc.builtAt, onReady, onFailure, controller]);
  return (
    <div ref={container} className="pdf-scroll" tabIndex={0} aria-label="PDF pages">
      <div className="pdfViewer" ref={pages} />
    </div>
  );
}

export default function PdfReader({ id, close }: { id: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<Viewer | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [doc, setDoc] = useState<SavedDocument | null>(null);
  const [error, setError] = useState('');
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState('1');
  const [scale, setScale] = useState(100);
  const [sending, setSending] = useState(false);
  const [reading, setReading] = useState<Reading | null>(null);
  const [readingError, setReadingError] = useState('');
  const [mode, setMode] = useState<'reading' | 'pdf'>('reading');
  const [size, setSize] = useState(() => {
    try {
      return Math.max(18, Math.min(30, Number(localStorage.getItem('swa:reading-size')) || 20));
    } catch {
      return 20;
    }
  });
  const [readingVersion, setReadingVersion] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void api(`/documents/${id}/reading`, undefined, abort.signal)
      .then(documentReadingSchema.parse)
      .then((value) => {
        if (abort.signal.aborted) return;
        setReading(value);
        setReadingError('');
        if (!value.available) setMode('pdf');
      })
      .catch((error) => {
        if (abort.signal.aborted) return;
        setReadingError(error.message);
        setMode('pdf');
      });
    return () => abort.abort();
  }, [id, readingVersion]);
  function resizeText(delta: number) {
    const next = Math.max(18, Math.min(30, size + delta));
    setSize(next);
    try {
      localStorage.setItem('swa:reading-size', String(next));
    } catch {
      /* private storage */
    }
  }
  const actionKey = useRef(crypto.randomUUID());
  const ready = useCallback((pages: number, page: number, scale: number) => {
    setPages(pages);
    setPage(String(page));
    setScale(Math.round(scale * 100));
  }, []);
  const failure = useCallback((message: string) => setError(message), []);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const back = () => closeRef.current();
    element.addEventListener('pdf:back', back);
    return () => {
      element.removeEventListener('pdf:back', back);
      element.close();
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    setDoc(null);
    setPages(0);
    const read = async (open = false) => {
      try {
        const result = documentSchema.parse(
          await api(
            `/documents/${id}${open ? '/open' : ''}`,
            open ? { key: actionKey.current } : undefined,
            abort.signal,
          ),
        );
        if (abort.signal.aborted) return;
        setDoc(result);
      } catch (error) {
        if (!abort.signal.aborted) setError((error as Error).message);
      }
    };
    void read(true);
    return () => {
      abort.abort();
    };
  }, [id]);
  // Poll a rebuild without remounting the existing PDF while it is in progress.
  useEffect(() => {
    if (!doc || !['queued', 'building'].includes(doc.state)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void api(`/documents/${id}`, undefined, abort.signal)
        .then(documentSchema.parse)
        .then(setDoc)
        .catch((error) => {
          if (!abort.signal.aborted) setError(error.message);
        });
    }, 1200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [id, doc]);
  async function rebuild() {
    setSending(true);
    setReadingVersion((value) => value + 1);
    setError('');
    try {
      setDoc(
        documentSchema.parse(await api(`/documents/${id}/build`, { key: crypto.randomUUID() })),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSending(false);
    }
  }
  function jumpToPage() {
    const number = Math.min(pages, Math.max(1, Number(page) || 1));
    if (controller.current) {
      controller.current.currentPageNumber = number;
      setPage(String(number));
    }
  }
  const building = doc && ['queued', 'building'].includes(doc.state);
  return (
    <dialog
      className="pdf-reader"
      ref={dialog}
      aria-label="PDF reader"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="pdf-heading">
        <button onClick={close} aria-label="Back to where I was">
          <ArrowLeft size={21} />
          <span>Back</span>
        </button>
        <div>
          <strong>{doc?.name ?? 'Document'}</strong>
          <small>{doc?.folder ?? 'Opening…'}</small>
        </div>
        {doc?.kind === 'tex' && (
          <button
            disabled={!!building || sending}
            onClick={() => void rebuild()}
            aria-label="Rebuild"
            title="Rebuild PDF"
          >
            <RefreshCw size={20} />
          </button>
        )}
        {doc?.hasPdf && (
          <a
            href={apiUrl(`/documents/${id}/pdf`)}
            download={doc.name.replace(/\.tex$/i, '.pdf')}
            aria-label="Download PDF"
          >
            <Download size={21} />
          </a>
        )}
      </header>
      {(reading?.available || readingError) && (
        <div className="pdf-toolbar reader-mode" aria-label="Reading controls">
          {reading?.available && (
            <div className="reader-modes">
              <button aria-pressed={mode === 'reading'} onClick={() => setMode('reading')}>
                Reading
              </button>
              <button aria-pressed={mode === 'pdf'} onClick={() => setMode('pdf')}>
                Original PDF
              </button>
            </div>
          )}
          {mode === 'reading' && (
            <div className="reader-text-size">
              <button
                aria-label="Smaller text"
                disabled={size <= 18}
                onClick={() => resizeText(-2)}
              >
                A−
              </button>
              <button aria-label="Larger text" disabled={size >= 30} onClick={() => resizeText(2)}>
                A+
              </button>
            </div>
          )}
          {readingError && (
            <details>
              <summary>Reading mode unavailable</summary>
              <p>{readingError}</p>
              <button onClick={() => setReadingVersion((value) => value + 1)}>
                Retry reading mode
              </button>
            </details>
          )}
        </div>
      )}
      {mode === 'pdf' && (
        <div className="pdf-toolbar" aria-label="PDF controls">
          <div className="pdf-zoom">
            <button
              disabled={!pages || scale <= 20}
              aria-label="Zoom out"
              onClick={() => controller.current?.decreaseScale()}
            >
              <Minus size={20} />
            </button>
            <span aria-live="polite">{pages ? `${scale}%` : '—'}</span>
            <button
              disabled={!pages || scale >= 400}
              aria-label="Zoom in"
              onClick={() => controller.current?.increaseScale()}
            >
              <Plus size={20} />
            </button>
          </div>
          <label className="sr-only" htmlFor="pdf-fit">
            Page fit
          </label>
          <select
            id="pdf-fit"
            value=""
            disabled={!pages}
            onChange={(event) => {
              if (controller.current) controller.current.currentScaleValue = event.target.value;
            }}
          >
            <option value="" disabled>
              Fit / zoom
            </option>
            <option value="page-width">Fit width</option>
            <option value="page-fit">Whole page</option>
            <option value="1">100%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
            <option value="3">300%</option>
          </select>
          <form
            className="pdf-page-number"
            onSubmit={(event) => {
              event.preventDefault();
              jumpToPage();
              (document.activeElement as HTMLElement)?.blur();
            }}
          >
            <label htmlFor="pdf-page">Page</label>
            <input
              id="pdf-page"
              aria-label="Page number"
              inputMode="numeric"
              value={page}
              disabled={!pages}
              onChange={(event) => setPage(event.target.value.replace(/\D/g, ''))}
              onBlur={() => {
                jumpToPage();
              }}
            />
            <span>/ {pages || '…'}</span>
          </form>
        </div>
      )}
      {mode === 'pdf' && building && (
        <p className="pdf-status" role="status">
          {doc.state === 'queued'
            ? 'Waiting for the current document build…'
            : 'Building your PDF on this computer…'}
          {doc.hasPdf ? ' Showing the previous PDF.' : ''}
        </p>
      )}
      {(error || (mode === 'pdf' && doc?.error)) && (
        <div className="pdf-error" role="alert">
          <p>
            {error ||
              (doc?.hasPdf
                ? 'The latest build failed. Your previous PDF is still available.'
                : 'This document could not be built.')}
          </p>
          {doc?.error && (
            <details>
              <summary>Build details</summary>
              <pre>{doc.error}</pre>
            </details>
          )}
          <button disabled={!!building || sending} onClick={() => void rebuild()}>
            Try again
          </button>
        </div>
      )}
      <div className="pdf-body">
        {mode === 'reading' && reading?.available ? (
          <DocumentReading id={id} reading={reading} size={size} close={close} />
        ) : mode === 'pdf' && doc?.hasPdf ? (
          <PdfPages doc={doc} controller={controller} onReady={ready} onFailure={failure} />
        ) : (
          <div className="pdf-wait" role="status">
            {error || doc?.error
              ? 'Your source files have not been changed.'
              : 'Preparing your document…'}
          </div>
        )}
      </div>
    </dialog>
  );
}
