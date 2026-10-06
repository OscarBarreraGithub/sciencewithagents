import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { nativeCommandCatalogSchema } from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';
import { useBackStep } from './home/Navigation';

export type ChatCommand = 'new' | 'compact' | 'resume' | 'interrupt';

/** App commands open typed controls; provider commands remain in the native session. */
export function ChatCommands({
  onGoal,
  onCommand,
  onAdvanced,
  onBack,
  agentId,
  onNativeCommand,
}: {
  onGoal: () => void;
  onCommand?: (command: ChatCommand) => void;
  onAdvanced?: () => void;
  onBack?: (close: (() => void) | null) => void;
  agentId?: string;
  onNativeCommand?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ReturnType<
    typeof nativeCommandCatalogSchema.parse
  > | null>(null);
  const [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    if (!open || !agentId) return;
    let active = true;
    setCatalog(null);
    setCatalogError('');
    void api(`/agents/${agentId}/native-commands`)
      .then((result) => {
        if (active) setCatalog(nativeCommandCatalogSchema.parse(result));
      })
      .catch(() => {
        if (active)
          setCatalogError(
            'Native command discovery is unavailable on this computer. Existing chat and app controls still work.',
          );
      });
    return () => {
      active = false;
    };
  }, [open, agentId]);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useBackStep(open && !onBack ? close : null);
  useEffect(() => {
    if (!open || !onBack) return;
    onBack(close);
    return () => onBack(null);
  }, [open, onBack, close]);
  const choose = (action: () => void) => {
    flushSync(() => setOpen(false));
    trigger.current?.focus({ preventScroll: true });
    action();
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="icon-button session-command-trigger"
        title="Session commands"
        aria-label="Show commands"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="slash-icon">/</span>
      </button>
      {open && (
        <Modal title="Session commands" close={() => setOpen(false)}>
          <p>Choose a command without changing your message draft.</p>
          <div className="session-command-list">
            <button type="button" className="secondary" onClick={() => choose(onGoal)}>
              <code>/goal</code> Goal
            </button>
            {onCommand && (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => choose(() => onCommand('new'))}
                >
                  <code>/new · /clear</code> New context, keep history
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => choose(() => onCommand('compact'))}
                >
                  <code>/compact</code> Compact context
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => choose(() => onCommand('resume'))}
                >
                  <code>/resume</code> Resume from history
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => choose(() => onCommand('interrupt'))}
                >
                  <code>/stop</code> Stop reply
                </button>
              </>
            )}
            {onAdvanced && (
              <button type="button" className="secondary" onClick={() => choose(onAdvanced)}>
                Advanced controls
              </button>
            )}
          </div>
          {catalog?.commands.length && onNativeCommand ? (
            <div className="session-command-list">
              {catalog.commands
                .filter((name) => name !== 'compact')
                .map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="secondary"
                    onClick={() => choose(() => onNativeCommand?.(`/${name}`))}
                  >
                    <code>/{name}</code> Run in Claude
                  </button>
                ))}
            </div>
          ) : null}
          <p>
            {catalogError ||
              catalog?.note ||
              'Other provider commands stay in the original native session.'}
          </p>
        </Modal>
      )}
    </>
  );
}
