import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { fitToVisibleViewport } from './useVisibleViewport';

export function Modal({
  title,
  children,
  close,
  className,
  embedded = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  className?: string;
  embedded?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (embedded) return;
    const opener = document.activeElement;
    dialog.current?.showModal();
    const stop = dialog.current && fitToVisibleViewport(dialog.current, 'modal');
    // React removes the dialog rather than closing it, so restore the keyboard position here.
    return () => {
      stop?.();
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [embedded]);
  if (embedded)
    return (
      <section className={`flow-form-panel ${className ?? ''}`} aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </section>
    );
  return (
    <dialog
      ref={dialog}
      className={className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="modal-heading">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
