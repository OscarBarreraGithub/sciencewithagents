import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
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
    const viewport = window.visualViewport;
    const resize = () => {
      element.style.setProperty('--assistant-height', `${viewport?.height ?? innerHeight}px`);
      element.style.setProperty('--assistant-top', `${viewport?.offsetTop ?? 0}px`);
    };
    resize();
    element.showModal();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
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
