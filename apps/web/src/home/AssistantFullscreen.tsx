import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { fitToVisibleViewport } from '../useVisibleViewport';
import './assistant-fullscreen.css';

/** A full-screen chat in the top layer; opening and returning never send a message. */
export function AssistantFullscreen({
  title,
  back,
  close,
  children,
  controls,
}: {
  title: string;
  back: string;
  close: () => void;
  children: ReactNode;
  controls?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const stop = fitToVisibleViewport(element, 'assistant');
    element.showModal();
    return () => {
      stop();
      element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="assistant-fullscreen"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="assistant-fullscreen-bar">
        <button
          type="button"
          className="flow-button assistant-back"
          onClick={close}
          aria-label={back}
        >
          <ArrowLeft size={18} /> <span>{back}</span>
        </button>
        <strong>{title.replace(/ conversation$/, '')}</strong>
        {controls}
      </header>
      <div className="assistant-fullscreen-body chat-pane">{children}</div>
    </dialog>
  );
}
