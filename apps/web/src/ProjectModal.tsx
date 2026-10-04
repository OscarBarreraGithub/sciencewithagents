import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, LockKeyhole } from 'lucide-react';
import {
  id,
  projectCreateSchema,
  projectSchema,
  projectOptionsSchema,
  projectConnectionSchema,
  projectTrackingSchema,
  type Project,
} from '@dock/shared';
import { api, apiScope, ApiError } from './api';
import { Modal } from './Modal';
import { FolderBrowser } from './FolderBrowser';

const storageKey =
  apiScope() === 'local' ? 'dock:project-draft' : `dock:${apiScope()}:project-draft`;
type Draft = {
  key: string;
  name: string;
  description: string;
  provider: 'policy' | 'codex' | 'claude';
};
function readDraft(): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (
      id.safeParse(value?.key).success &&
      typeof value.name === 'string' &&
      value.name.length <= 100 &&
      typeof value.description === 'string' &&
      value.description.length <= 2000 &&
      (value.provider === undefined ||
        value.provider === 'policy' ||
        value.provider === 'codex' ||
        value.provider === 'claude')
    )
      return {
        key: String(value.key),
        name: String(value.name),
        description: String(value.description),
        provider: value.provider ?? 'policy',
      };
  } catch {
    /* A new draft still works when browser storage is unavailable. */
  }
  return { key: crypto.randomUUID(), name: '', description: '', provider: 'policy' };
}

export function ProjectModal({
  close,
  onCreated,
}: {
  close: () => void;
  onCreated: (project: Project) => Promise<void>;
}) {
  const [draft, setDraft] = useState(readDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [folderBrowser, setFolderBrowser] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [canChooseFolder, setCanChooseFolder] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const folderStorageKey = `${storageKey}:folder-request`;
  const folderKey = useRef<string | null>(null);
  if (folderKey.current === null) {
    try {
      const saved = JSON.parse(localStorage.getItem(folderStorageKey) ?? 'null');
      if (id.safeParse(saved?.key).success && saved.provider === draft.provider)
        folderKey.current = saved.key;
    } catch {
      /* The current view can still retain its receipt in memory. */
    }
    folderKey.current ??= crypto.randomUUID();
  }
  const [tracking, setTracking] = useState<{ key: string; name: string } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(folderStorageKey) ?? 'null');
      const parsed = projectTrackingSchema.safeParse(saved?.tracking);
      return saved?.provider === draft.provider &&
        parsed.success &&
        parsed.data.key === folderKey.current
        ? parsed.data
        : null;
    } catch {
      return null;
    }
  });
  const [trackingPending, setTrackingPending] = useState(() => {
    try {
      return Boolean(JSON.parse(localStorage.getItem(folderStorageKey) ?? 'null')?.trackingPending);
    } catch {
      return false;
    }
  });
  const saveFolderReceipt = (nextTracking = tracking, pending = trackingPending) => {
    try {
      localStorage.setItem(
        folderStorageKey,
        JSON.stringify({
          key: folderKey.current,
          provider: draft.provider,
          tracking: nextTracking,
          trackingPending: pending,
        }),
      );
    } catch {
      /* The exact request stays in this view when browser storage is unavailable. */
    }
  };
  const clearFolderReceipt = () => {
    folderKey.current = crypto.randomUUID();
    setTracking(null);
    setTrackingPending(false);
    try {
      localStorage.removeItem(folderStorageKey);
    } catch {
      /* Optional browser storage. */
    }
  };
  const submitting = useRef(false);
  useEffect(() => {
    void api('/project-options')
      .then((value) => {
        const options = projectOptionsSchema.parse(value);
        setCanChooseFolder(options.canChooseFolder);
        setFolderBrowser(!!options.folderBrowser);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      /* Keep the in-memory draft. */
    }
  }, [draft]);
  const change = (field: 'name' | 'description', value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value, key: crypto.randomUUID() }));
    setError('');
  };
  const connectFolder = async (folderId?: string) => {
    setBrowsing(false);
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setChoosingFolder(true);
    setError('');
    try {
      saveFolderReceipt();
      const value = projectConnectionSchema.parse(
        await api('/projects/connect-folder', {
          key: folderKey.current,
          fresh: true,
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
          ...(folderId ? { folderId } : {}),
          ...(draft.provider !== 'policy' ? { provider: draft.provider } : {}),
        }),
      );
      if (value.tracking) {
        setTracking(value.tracking);
        saveFolderReceipt(value.tracking, false);
      } else {
        clearFolderReceipt();
        if (value.project) await onCreated(projectSchema.parse(value.project));
      }
    } catch (error) {
      if (!(error instanceof TypeError)) clearFolderReceipt();
      setError(
        error instanceof TypeError
          ? 'We lost the connection. Try again when you’re connected; your project will not be duplicated.'
          : error instanceof Error
            ? error.message
            : 'We couldn’t open that folder. Please try again.',
      );
    } finally {
      submitting.current = false;
      setSaving(false);
      setChoosingFolder(false);
    }
  };
  return (
    <Modal
      title="Create a project"
      className="project-dialog"
      close={() => {
        if (!submitting.current) close();
      }}
    >
      {browsing && (
        <FolderBrowser close={() => setBrowsing(false)} select={(id) => void connectFolder(id)} />
      )}
      <form
        className="project-create-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          const { provider, ...details } = draft;
          const parsed = projectCreateSchema.safeParse({
            ...details,
            ...(provider !== 'policy' ? { provider } : {}),
          });
          if (!parsed.success) {
            setError('Give your project a name to get started.');
            return;
          }
          submitting.current = true;
          setSaving(true);
          setError('');
          try {
            const project = projectSchema.parse(await api('/projects', parsed.data));
            try {
              localStorage.removeItem(storageKey);
            } catch {
              /* Creation already succeeded. */
            }
            await onCreated(project);
          } catch (error) {
            setError(
              error instanceof TypeError
                ? 'We lost the connection. Your details are saved—try Create project again when you’re connected.'
                : error instanceof Error
                  ? error.message
                  : 'We couldn’t create your project. Please try again.',
            );
          } finally {
            submitting.current = false;
            setSaving(false);
          }
        }}
      >
        <div className="project-fields" hidden={!!tracking}>
          <p>A place for your idea, your team and everything you work on together.</p>
          <label>
            Project name
            <input
              autoFocus
              required
              maxLength={100}
              placeholder="e.g. My gardening journal"
              value={draft.name}
              disabled={saving || !!tracking}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          <label>
            What would you like to do? <span className="muted">Optional</span>
            <textarea
              rows={3}
              maxLength={2000}
              placeholder="A sentence or two is plenty. You can figure out the details together."
              value={draft.description}
              disabled={saving || !!tracking}
              onChange={(event) => change('description', event.target.value)}
            />
          </label>
          <div className="project-privacy">
            <LockKeyhole size={17} />
            <p>
              Saved on this computer. Nothing is published online. We’ll take care of setting up the
              project for you.
            </p>
          </div>
          <label>
            Manager provider
            <select
              value={draft.provider}
              disabled={saving || !!tracking}
              onChange={(event) => {
                setDraft((previous) => ({
                  ...previous,
                  provider: event.target.value as Draft['provider'],
                  key: crypto.randomUUID(),
                }));
                clearFolderReceipt();
                setError('');
              }}
            >
              <option value="policy">Follow model settings</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <p className="muted">
            Uses that provider’s existing sign-in on the selected computer. Managers delegate work;
            you can add managers from either provider later. A saved conversation keeps its
            provider.
          </p>
        </div>
        <div className={`project-actions${tracking ? ' project-actions-tracking' : ''}`}>
          {error && (
            <p className="project-error" role="alert">
              {error}
            </p>
          )}
          {!tracking && (
            <button
              className="primary"
              type="submit"
              disabled={saving || !!tracking || !draft.name.trim()}
            >
              {saving && !choosingFolder ? 'Creating your project…' : 'Create project'}
              <ArrowRight size={16} />
            </button>
          )}
          {tracking && (
            <div className="project-tracking" role="region" aria-label="Start tracking this folder">
              <h3>{tracking.name}</h3>
              <p>This folder needs a local starting version before your team can work with it.</p>
              <p className="muted">
                Your files stay in place. Local defaults exclude common environment and dependency
                files, alongside your own ignore rules. Nothing is uploaded.
              </p>
              {trackingPending && (
                <p role="status">
                  Your request is saved. Check it again to finish this same folder; no second
                  project will be created.
                </p>
              )}
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={async () => {
                  if (submitting.current) return;
                  submitting.current = true;
                  setSaving(true);
                  setTrackingPending(true);
                  saveFolderReceipt(tracking, true);
                  setError('');
                  try {
                    const value = projectConnectionSchema.parse(
                      await api('/projects/track-folder', {
                        key: tracking.key,
                        confirmedTracking: true,
                      }),
                    );
                    if (!value.project)
                      throw new Error(
                        'The starting version is not ready. Check this same request again.',
                      );
                    clearFolderReceipt();
                    await onCreated(value.project);
                  } catch (error) {
                    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                      setTrackingPending(false);
                      saveFolderReceipt(tracking, false);
                    }
                    setError(
                      error instanceof Error
                        ? error.message
                        : 'We couldn’t confirm the starting version. Check this request again.',
                    );
                  } finally {
                    submitting.current = false;
                    setSaving(false);
                  }
                }}
              >
                {saving
                  ? 'Saving the starting version…'
                  : trackingPending
                    ? 'Check tracking request'
                    : 'Start tracking this folder'}
              </button>
              {!trackingPending && (
                <button
                  type="button"
                  className="secondary"
                  disabled={saving}
                  onClick={clearFolderReceipt}
                >
                  Choose another folder
                </button>
              )}
            </div>
          )}
          {canChooseFolder && !tracking && (
            <button
              type="button"
              className="secondary project-folder"
              disabled={saving || !!tracking}
              onClick={() => (folderBrowser ? setBrowsing(true) : void connectFolder())}
            >
              <FolderOpen size={16} />
              {choosingFolder ? 'Selecting folder…' : 'Use an existing project folder'}
            </button>
          )}
          {canChooseFolder && (
            <p className="project-next">
              An already connected project keeps its existing manager and provider.
            </p>
          )}
          <p className="project-next">
            {choosingFolder
              ? 'The selected folder is being connected. Your files stay where they are.'
              : 'Next, you’ll meet your manager. No work starts until you send a message.'}
          </p>
        </div>
      </form>
    </Modal>
  );
}
