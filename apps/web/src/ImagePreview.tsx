import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './imagePreview.css';

/** Images open above the existing chat, including in an installed phone app. */
export function ImagePreview({
  src,
  alt,
  label = `Open image ${alt}`,
  className = '',
  width,
  height,
}: {
  src: string;
  alt: string;
  label?: string;
  className?: string;
  width?: number;
  height?: number;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`image-preview-trigger ${className}`}
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt} width={width} height={height} loading="lazy" />
      </button>
      {open &&
        createPortal(
          <ImageViewer
            src={src}
            alt={alt}
            returnFocus={trigger.current}
            close={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

function ImageViewer({
  src,
  alt,
  returnFocus,
  close,
}: {
  src: string;
  alt: string;
  returnFocus: HTMLElement | null;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const token = useRef(crypto.randomUUID()).current;
  const closing = useRef(false);
  const closeRef = useRef(close);
  closeRef.current = close;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    const restoration = history.scrollRestoration;
    const priorOpen = document.documentElement.dataset.imageOpen;
    const scroll = [
      ...document.querySelectorAll(
        '.home-content, .conversation, .mirror-log, .assistant-fullscreen-body, .notepad',
      ),
    ].map((node) => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    history.scrollRestoration = 'manual';
    document.documentElement.dataset.imageOpen = token;
    // An unchanged URL keeps the chat mounted. Phone/browser Back consumes only
    // this overlay entry rather than leaving the chat for a raw image response.
    history.pushState({ ...history.state, swaImageViewer: token }, '', location.href);
    const back = () => {
      closing.current = true;
      closeRef.current();
    };
    window.addEventListener('popstate', back);
    element.showModal();
    return () => {
      window.removeEventListener('popstate', back);
      element.close();
      if (history.state?.swaImageViewer === token) history.back();
      requestAnimationFrame(() => {
        const restore = () => {
          for (const item of scroll) {
            if (!item.node.isConnected) continue;
            item.node.scrollTop = item.top;
            item.node.scrollLeft = item.left;
          }
        };
        restore();
        requestAnimationFrame(() => {
          if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
          restore();
          if (document.documentElement.dataset.imageOpen === token) {
            if (priorOpen) document.documentElement.dataset.imageOpen = priorOpen;
            else delete document.documentElement.dataset.imageOpen;
          }
          history.scrollRestoration = restoration;
        });
      });
    };
  }, [token, returnFocus]);
  const dismiss = () => {
    if (closing.current) return;
    closing.current = true;
    if (history.state?.swaImageViewer === token) history.back();
    else closeRef.current();
  };
  return (
    <dialog
      ref={dialog}
      className="image-viewer"
      aria-label="Image viewer"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <header className="image-viewer-heading">
        <strong>{alt}</strong>
        <button type="button" className="secondary" onClick={dismiss} autoFocus>
          <X size={20} aria-hidden="true" /> Close
        </button>
      </header>
      <div className="image-viewer-stage">
        {failed ? (
          <p role="alert">This image could not be loaded. Close to return to your chat.</p>
        ) : (
          <img src={src} alt={alt} onError={() => setFailed(true)} />
        )}
      </div>
    </dialog>
  );
}
