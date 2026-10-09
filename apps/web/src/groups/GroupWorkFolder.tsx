import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  projectConnectionSchema,
  projectFolderSchema,
  projectFolderSelectionSchema,
} from '@dock/shared';
import {
  groupWorkspaceInputSchema,
  groupWorkspaceViewSchema,
  type GroupWorkspaceView,
} from '@dock/shared/dist/group-workspace.js';
import { api, apiScope, ApiError, connectionLost } from '../api';
import { FolderBrowser } from '../FolderBrowser';
import { groupGitHubSetupPromptForFolder } from './GroupSetupPrompt';

type Selection = ReturnType<typeof projectFolderSelectionSchema.parse>;
type Pick = ReturnType<typeof projectFolderSchema.parse>;
type Bind = Extract<ReturnType<typeof groupWorkspaceInputSchema.parse>, { action: 'select' }>;
const prefix = () => `swa:${apiScope()}:groups-work-folder`;
function readStored<T>(storage: string, parse: (raw: unknown) => T): T | null {
  try {
    const raw = sessionStorage.getItem(storage);
    return raw && raw.length <= 32_768 ? parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
const definitive = (reason: unknown) =>
  reason instanceof ApiError &&
  reason.status >= 400 &&
  reason.status < 500 &&
  !connectionLost(reason);

/** Paths are display/copy-only server output; binding submits the saved selection identity. */
export function GroupWorkFolder({
  handle,
  connection,
  onOpen,
  onBound,
}: {
  handle?: string;
  connection?: ReactNode;
  onOpen?: () => void;
  onBound?: () => void;
}) {
  const scope = prefix(),
    bindingStorage = `${scope}:${handle}:bind`,
    pickStorage = `${scope}:pick`,
    selectionStorage = `${scope}:selection`;
  const [selection, setSelection] = useState<Selection | null>(null),
    [pendingPick, setPendingPick] = useState<Pick | null>(null),
    [pendingBind, setPendingBind] = useState<Bind | null>(null),
    [workspace, setWorkspace] = useState<GroupWorkspaceView | null>(null),
    [browsing, setBrowsing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const generation = useRef(0),
    inFlight = useRef(false);
  const readWorkspace = async () => {
    if (!handle) return null;
    const version = generation.current;
    const value = groupWorkspaceViewSchema.parse(
      await api('/groups/workspace', { action: 'status', handle }),
    );
    if (generation.current === version) setWorkspace(value);
    return value;
  };
  useEffect(() => {
    const version = ++generation.current;
    inFlight.current = false;
    setWorkspace(null);
    setError('');
    setCopied(false);
    setBusy(false);
    setBrowsing(false);
    setSelection(readStored(selectionStorage, projectFolderSelectionSchema.parse));
    const pick = readStored(pickStorage, projectFolderSchema.parse);
    setPendingPick(pick?.selectOnly === true ? pick : null);
    const binding = readStored(bindingStorage, groupWorkspaceInputSchema.parse);
    setPendingBind(binding?.action === 'select' && binding.handle === handle ? binding : null);
    if (handle)
      void readWorkspace().catch((reason: unknown) => {
        if (generation.current === version)
          setError(reason instanceof Error ? reason.message : 'The work folder could not be read.');
      });
    return () => {
      generation.current++;
    };
  }, [scope, handle]);
  const pick = async (folderId?: string) => {
    if (inFlight.current) return;
    const operation = pendingPick ?? {
      key: crypto.randomUUID(),
      selectOnly: true,
      ...(folderId ? { folderId } : {}),
    };
    const version = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setCopied(false);
    setBrowsing(false);
    sessionStorage.setItem(pickStorage, JSON.stringify(operation));
    setPendingPick(operation);
    try {
      const value = projectConnectionSchema.parse(await api('/projects/connect-folder', operation));
      if (generation.current !== version) return;
      if (!value.selection)
        throw new Error(
          'This host did not return a saved folder selection. The request is retained.',
        );
      sessionStorage.setItem(selectionStorage, JSON.stringify(value.selection));
      setSelection(value.selection);
      sessionStorage.removeItem(pickStorage);
      setPendingPick(null);
      if (!value.selection.workspacePath)
        setError(
          'Folder selected, but this host needs an update before showing a scoped setup prompt.',
        );
    } catch (reason) {
      if (generation.current !== version) return;
      if (definitive(reason)) {
        sessionStorage.removeItem(pickStorage);
        setPendingPick(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : 'Folder selection is uncertain. Retry the same saved selection.',
      );
    } finally {
      if (generation.current === version) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const bind = async () => {
    if (!handle || inFlight.current || (!pendingBind && (!selection || !workspace))) return;
    const operation = pendingBind ?? {
      action: 'select' as const,
      handle,
      key: crypto.randomUUID(),
      revision: workspace!.revision,
      selectionKey: selection!.key,
    };
    const version = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    sessionStorage.setItem(bindingStorage, JSON.stringify(operation));
    setPendingBind(operation);
    try {
      groupWorkspaceViewSchema.parse(await api('/groups/workspace', operation));
      if (generation.current !== version) return;
      sessionStorage.removeItem(bindingStorage);
      setPendingBind(null);
      // Retained receipts may describe an earlier revision. Display a fresh status.
      await readWorkspace();
      if (generation.current === version) onBound?.();
    } catch (reason) {
      if (generation.current !== version) return;
      if (definitive(reason)) {
        sessionStorage.removeItem(bindingStorage);
        setPendingBind(null);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : 'The group binding is uncertain. Retry the exact saved change.',
      );
    } finally {
      if (generation.current === version) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  const check = async () => {
    const version = generation.current;
    setError('');
    try {
      await readWorkspace();
    } catch (reason) {
      if (generation.current === version)
        setError(reason instanceof Error ? reason.message : 'Status could not be read.');
    }
  };
  const bound = Boolean(
    selection && workspace?.selectionKey === selection.key && workspace.available,
  );
  const path = selection?.workspacePath ?? workspace?.workspacePath;
  const prompt = path
    ? groupGitHubSetupPromptForFolder(path, Boolean(selection?.workspacePath))
    : '';
  return (
    <details
      className="group-host-members group-work-folder"
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen?.();
      }}
      open={!handle}
    >
      <summary>Work folder</summary>
      <p>
        Choose the project files this group will work on. Choosing and connecting a folder makes no
        model call. Group messages and app databases stay in the app’s private data folder.
      </p>
      {selection && (
        <p>
          Selected: <strong>{selection.name}</strong>
          {selection.workspacePath && (
            <>
              <br />
              <code>{selection.workspacePath}</code>
            </>
          )}
        </p>
      )}
      {handle && <p role="status">{workspace?.message ?? 'Reading this group’s folder…'}</p>}
      {handle && workspace?.workspacePath && !bound && (
        <p>
          Current group folder: <code>{workspace.workspacePath}</code>
        </p>
      )}
      {pendingPick && (
        <p>
          The folder selection reply is uncertain. Retry the saved selection before choosing another
          folder.
        </p>
      )}
      {pendingBind && (
        <p>
          The group change reply is uncertain. Retry that exact binding; a new selection cannot
          replace it.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="groups-list-actions">
        <button
          className="secondary"
          type="button"
          disabled={busy || Boolean(pendingBind)}
          onClick={() => (pendingPick ? void pick() : setBrowsing(true))}
        >
          {pendingPick
            ? 'Retry folder selection'
            : selection
              ? 'Choose another folder'
              : 'Choose work folder'}
        </button>
        {handle && (pendingBind || (selection && !bound)) && (
          <button
            className="secondary"
            type="button"
            disabled={busy || (!pendingBind && !workspace) || Boolean(pendingPick)}
            onClick={() => void bind()}
          >
            {pendingBind ? 'Retry saved folder binding' : 'Use this folder for this group'}
          </button>
        )}
        {handle && (error || pendingBind) && (
          <button className="secondary" type="button" disabled={busy} onClick={() => void check()}>
            Check work folder
          </button>
        )}
      </div>
      {bound && (
        <p>
          Future group Work uses this saved folder. Earlier work and captured reports keep their
          original workspace identities.
        </p>
      )}
      {!handle && selection && (
        <p>
          Selection saved on this computer. After creating or joining, open Manage → Work folder and
          attach it explicitly.
        </p>
      )}
      {prompt && (
        <section className="group-setup-choice">
          <h3>Set up the private shared repository</h3>
          <p>
            Give this scoped prompt to your own setup agent. It checks the intended source files,
            existing Git history and each person’s GitHub access.
          </p>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(prompt)
                .then(() => setCopied(true))
                .catch(() => setError('Copy did not work. Open Read prompt and copy it by hand.'))
            }
          >
            {copied ? 'Copied' : 'Copy folder setup prompt'}
          </button>
          <details>
            <summary>Read prompt</summary>
            <pre aria-label="Selected folder setup prompt">{prompt}</pre>
          </details>
        </section>
      )}
      {connection}
      {browsing && (
        <FolderBrowser close={() => setBrowsing(false)} select={(id) => void pick(id)} />
      )}
    </details>
  );
}
