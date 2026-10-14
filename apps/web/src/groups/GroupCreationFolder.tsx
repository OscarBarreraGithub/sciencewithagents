import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import {
  projectConnectionSchema,
  projectFolderSchema,
  type projectFolderSelectionSchema,
} from '@dock/shared';
import { api, apiScope, ApiError, connectionLost } from '../api';
import { FolderBrowser } from '../FolderBrowser';
export type CreationSelection = ReturnType<typeof projectFolderSelectionSchema.parse>;
const storage = (scope: string) => `swa:groups:${scope}:creation-folder-pick`;
function savedPick() {
  try {
    return projectFolderSchema.parse(
      JSON.parse(sessionStorage.getItem(storage(apiScope())) ?? 'null'),
    );
  } catch {
    return null;
  }
}
/** Only the server-issued folder identity is sent back; canonical paths are display/copy data. */
export function GroupCreationFolder({
  selection,
  onSelection,
  onPending,
  disabled,
}: {
  selection: CreationSelection | null;
  onSelection: (value: CreationSelection) => void;
  onPending: (value: boolean) => void;
  disabled: boolean;
}) {
  const [browsing, setBrowsing] = useState(false),
    [pending, setPending] = useState(savedPick),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(false),
    generation = useRef(0);
  const scope = apiScope();
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [scope]);
  async function pick(folderId?: string) {
    if (active.current) return;
    const version = generation.current;
    const current = () => generation.current === version && apiScope() === scope;
    const operation = pending ?? {
      key: crypto.randomUUID(),
      selectOnly: true,
      ...(folderId ? { folderId } : {}),
    };
    active.current = true;
    setBusy(true);
    setBrowsing(false);
    setError('');
    try {
      sessionStorage.setItem(storage(scope), JSON.stringify(operation));
      setPending(operation);
      onPending(true);
      if (!current()) return;
      const value = projectConnectionSchema.parse(await api('/projects/connect-folder', operation));
      if (!current()) return;
      if (!value.selection?.workspacePath)
        throw new Error(
          'This host needs an update before returning a canonical folder. Retry the saved selection.',
        );
      onSelection(value.selection);
      sessionStorage.removeItem(storage(scope));
      setPending(null);
      onPending(false);
    } catch (reason) {
      if (!current()) return;
      if (
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        !connectionLost(reason)
      ) {
        sessionStorage.removeItem(storage(scope));
        setPending(null);
        onPending(false);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : 'Folder selection is uncertain. Retry the saved choice.',
      );
    } finally {
      if (current()) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <div>
      {selection && (
        <p>
          Selected folder: <span className="group-creation-path">{selection.workspacePath}</span>
        </p>
      )}
      {pending && <p>Retry the saved folder selection before choosing another folder.</p>}
      <button
        type="button"
        className="secondary"
        disabled={disabled || busy}
        onClick={() => (pending ? void pick() : setBrowsing(true))}
      >
        {pending
          ? 'Retry folder selection'
          : selection
            ? 'Choose another folder'
            : 'Choose work folder'}
      </button>
      {error && <p role="alert">{error}</p>}
      {browsing &&
        createPortal(
          <div onSubmit={(event) => event.stopPropagation()}>
            <FolderBrowser close={() => setBrowsing(false)} select={(id) => void pick(id)} />
          </div>,
          document.body,
        )}
    </div>
  );
}
