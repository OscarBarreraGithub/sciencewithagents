import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, MoreHorizontal } from 'lucide-react';
import {
  conversationVisibilitySchema,
  type ConversationVisibility,
  type ConversationVisibilityTarget,
  type ConversationVisibilityUpdate,
} from '@dock/shared';
import { api } from '../api';
import { Modal } from '../Modal';
import { refreshHome } from './refreshHome';

type VisibilityProps = {
  target: ConversationVisibilityTarget;
  record?: ConversationVisibility;
  changed: (record: ConversationVisibility) => void;
  name?: string;
  unavailable?: string;
};

/** App visibility only: never provider archiving, manager removal or queue cancellation.
 *  One request is retained until it is confirmed, so a retry repeats it exactly. */
function useVisibilityChange({ target, record, changed, name, unavailable }: VisibilityProps) {
  const attempt = useRef<ConversationVisibilityUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const restoring = attempt.current ? !attempt.current.archived : !!record?.archived;
  const label = `${restoring ? 'Restore' : 'Archive'} ${name ?? 'conversation'}`;
  const submit = async () => {
    if (busy || unavailable) return;
    attempt.current ??= {
      key: crypto.randomUUID(),
      target,
      expectedRevision: record?.revision ?? 0,
      archived: !record?.archived,
    };
    setBusy(true);
    setError('');
    try {
      const saved = conversationVisibilitySchema.parse(
        await api('/conversations/visibility', attempt.current),
      );
      attempt.current = null;
      changed(saved);
      void refreshHome();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The connection was interrupted. Retry this same visibility request.',
      );
    } finally {
      setBusy(false);
    }
  };
  const dialog = error && (
    <Modal title={label} close={() => setError('')}>
      <p role="alert">{error}</p>
      {unavailable && <p role="status">{unavailable}</p>}
      <button
        className="flow-button"
        type="button"
        disabled={busy || !!unavailable}
        onClick={() => void submit()}
      >
        Retry same request
      </button>
      <button
        className="flow-button"
        type="button"
        disabled={busy}
        onClick={() => {
          attempt.current = null;
          setError('');
          void refreshHome();
        }}
      >
        Inspect current visibility
      </button>
    </Modal>
  );
  return { busy, restoring, label, submit, dialog };
}

/** A quiet "more" menu holding Archive or Restore for one conversation. */
export function ConversationVisibilityButton(props: VisibilityProps) {
  const change = useVisibilityChange(props);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const hintId = useId();
  const options = props.name ? `Options for ${props.name}` : 'Conversation options';
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        ref={trigger}
        className="chat-tool conversation-menu-trigger"
        type="button"
        title={options}
        aria-label={options}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={change.busy || undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <ConversationMenu id={menuId} anchor={trigger} label={options} close={close}>
          <button
            className="conversation-menu-item"
            type="button"
            role="menuitem"
            aria-label={change.label}
            aria-describedby={hintId}
            disabled={change.busy || !!props.unavailable}
            onClick={() => {
              close(true);
              void change.submit();
            }}
          >
            {change.restoring ? <ArchiveRestore size={17} /> : <Archive size={17} />}
            <span>
              <strong>{change.restoring ? 'Restore' : 'Archive'}</strong>
              <small id={hintId}>
                {props.unavailable ??
                  (change.restoring
                    ? 'Show it in Chats again.'
                    : 'Hide it in this app only. Work, drafts and history stay.')}
              </small>
            </span>
          </button>
        </ConversationMenu>
      )}
      {change.dialog}
    </>
  );
}

/** Reverses the latest list change with its own retained request. */
export function ConversationVisibilityUndo(props: VisibilityProps & { name: string }) {
  const change = useVisibilityChange(props);
  return (
    <>
      <button
        className="chat-small-button"
        type="button"
        aria-label={`Undo: ${change.label}`}
        disabled={change.busy || !!props.unavailable}
        title={props.unavailable}
        onClick={() => void change.submit()}
      >
        Undo
      </button>
      {change.dialog}
    </>
  );
}

/** Rendered in the shell's top layer so scrolling lists and narrow panes never clip it. */
function ConversationMenu({
  id,
  anchor,
  label,
  close,
  children,
}: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  label: string;
  close: (refocus: boolean) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  const dismiss = useRef(close);
  dismiss.current = close;
  useLayoutEffect(() => {
    const position = () => {
      const button = anchor.current;
      const menu = box.current;
      if (!menu) return;
      if (!button?.isConnected) return dismiss.current(false);
      const at = button.getBoundingClientRect();
      const size = menu.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const left = Math.max(8, Math.min(at.right - size.width, width - size.width - 8));
      const below = at.bottom + 4;
      const above = at.top - size.height - 4;
      const top = below + size.height <= height - 8 || above < 8 ? below : above;
      setPlace({ top: Math.max(8, Math.min(top, height - size.height - 8)), left });
    };
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, []);
  useEffect(() => {
    // Layout initially hides the unpositioned menu. Focus only after it becomes visible.
    if (place.visibility === 'hidden') return;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({
      preventScroll: true,
    });
  }, [place.visibility]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchor.current?.contains(target))
        dismiss.current(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => items[(next + items.length) % items.length]?.focus();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      // Advance from the trigger's place, rather than a portal that is being removed.
      // WebKit otherwise drops focus to body when the menu disappears during native Tab.
      event.preventDefault();
      const button = anchor.current;
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, summary, [tabindex]',
        ),
      ].filter(
        (node) =>
          node.tabIndex >= 0 &&
          !node.hasAttribute('disabled') &&
          !box.current?.contains(node) &&
          node.getClientRects().length > 0,
      );
      const next = button && focusable[focusable.indexOf(button) + (event.shiftKey ? -1 : 1)];
      close(false);
      (next || button)?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(index - 1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      move(event.key === 'Home' ? 0 : -1);
    }
  };
  const host = anchor.current?.closest<HTMLElement>('.home-shell') ?? document.body;
  return createPortal(
    <div
      ref={box}
      id={id}
      className="conversation-menu"
      role="menu"
      aria-label={label}
      style={place}
      onKeyDown={keys}
    >
      {children}
    </div>,
    host,
  );
}
