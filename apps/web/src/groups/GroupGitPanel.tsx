import { useEffect, useRef, useState } from 'react';
import {
  groupGitHostCommandSchema,
  groupGitHostViewSchema,
  type GroupGitHostCommand,
  type GroupGitHostView,
} from '@dock/shared/dist/group-git-host.js';
import { api, apiScope } from '../api';
import './group-git-panel.css';

type ChangeCommand<T = Extract<GroupGitHostCommand, { key: string }>> = T extends { key: string }
  ? Omit<T, 'key'>
  : never;
const changes = new Set(['policy', 'intent', 'propose', 'view']);
function PathList({ paths }: { paths: readonly string[] }) {
  const [page, setPage] = useState(0);
  const start = Math.min(page * 25, Math.max(0, Math.ceil(paths.length / 25) - 1) * 25);
  return (
    <>
      <ul>
        {paths.slice(start, start + 25).map((path, n) => (
          <li key={`${start + n}:${path}`}>{path}</li>
        ))}
      </ul>
      {paths.length > 25 && (
        <div className="group-git-buttons">
          <button disabled={!start} onClick={() => setPage(page - 1)}>
            Previous files
          </button>
          <span>
            {start + 1}–{Math.min(start + 25, paths.length)} of {paths.length}
          </span>
          <button disabled={start + 25 >= paths.length} onClick={() => setPage(page + 1)}>
            More files
          </button>
        </div>
      )}
    </>
  );
}
/** Only saved group/resource/review/file IDs cross this owner port. */
export function GroupGitPanel({
  handle,
  request,
}: {
  handle: string;
  request?: (command: GroupGitHostCommand) => Promise<unknown>;
}) {
  const [view, setView] = useState<GroupGitHostView | null>(null);
  const [repositoryId, setRepositoryId] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'metadata' | 'content'>('private');
  const [paths, setPaths] = useState<string[]>([]);
  const [pathPage, setPathPage] = useState(0);
  const [reviewId, setReviewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<GroupGitHostCommand | null>(null);
  const current = useRef(handle);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const storageKey = `swa:${apiScope()}:group-git:${handle}`;
  const repository = view?.repositories.find((r) => r.id === repositoryId);
  const selected = view?.selected?.id === repositoryId ? view.selected : null;
  const mutable = !busy && !pending && Boolean(repository);

  async function control(command: GroupGitHostCommand, retry = false) {
    const owner = handle,
      generation = epoch.current;
    const accepted = () => current.current === owner && epoch.current === generation;
    if (inFlight.current || (changes.has(command.kind) && pending && !retry)) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (changes.has(command.kind)) {
        // Persist before dispatch; retry/reload reuses the complete original input.
        sessionStorage.setItem(storageKey, JSON.stringify(command));
        setPending(command);
      }
      const result = groupGitHostViewSchema.parse(
        await (request ? request(command) : api('/groups/git', { handle: owner, command })),
      );
      if (!accepted()) return;
      setView(result);
      setRepositoryId((previous) =>
        result.repositories.some((r) => r.id === previous)
          ? previous
          : (result.selected?.id ?? result.repositories[0]?.id ?? ''),
      );
      if (changes.has(command.kind)) {
        if ('key' in command && result.receipt?.key === command.key) {
          sessionStorage.removeItem(storageKey);
          setPending(null);
          if (result.receipt.state === 'refused') setError(result.receipt.message);
        } else
          setError('The change is not yet acknowledged. Check status or retry the saved change.');
      }
    } catch (reason) {
      if (accepted())
        setError(
          reason instanceof Error
            ? reason.message
            : 'Git status is unavailable. Your saved change is retained.',
        );
    } finally {
      if (accepted()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    current.current = handle;
    epoch.current++;
    inFlight.current = false;
    setView(null);
    setRepositoryId('');
    setBusy(false);
    setError('');
    let retained: GroupGitHostCommand | null = null;
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const value = groupGitHostCommandSchema.parse(JSON.parse(saved));
        if (changes.has(value.kind)) retained = value;
      }
    } catch {
      /* Invalid local receipt never creates authority. */
    }
    setPending(retained);
    void control({ kind: 'list' });
    return () => {
      epoch.current++;
      if (current.current === handle) current.current = '';
    };
  }, [handle]);
  useEffect(() => {
    setVisibility(repository?.visibility ?? 'private');
    setPaths(repository?.paths.filter((p) => p.visibility === 'content').map((p) => p.id) ?? []);
    setReviewId(repository?.reviews[0]?.id ?? '');
    setPathPage(0);
  }, [repository]);
  const change = (command: ChangeCommand) =>
    void control({ ...command, key: crypto.randomUUID() } as GroupGitHostCommand);
  const picked = repository?.paths.filter((p) => paths.includes(p.id)) ?? [];
  // Never paint another group's retained resource view during a handle change.
  if (current.current !== handle)
    return (
      <details className="group-git-panel">
        <summary>Shared Git workspace</summary>
        <p>Checking saved repositories…</p>
      </details>
    );
  return (
    <details className="group-git-panel">
      <summary>Shared Git workspace</summary>
      <p role="status">
        {view?.message ??
          (busy ? 'Checking saved repositories…' : 'Saved repository status is unavailable.')}
      </p>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <div className="group-git-retry">
          <p>
            A saved change needs acknowledgement. Check status or retry the same change before
            starting another.
          </p>
          <button disabled={busy} onClick={() => void control(pending, true)}>
            Retry saved change
          </button>
        </div>
      )}
      {!view ? null : !view.repositories.length ? (
        <p>
          Ask the setup agent to connect a repository on this computer. Personal repositories remain
          private.
        </p>
      ) : (
        <>
          <label>
            Repository
            <select
              value={repositoryId}
              disabled={busy}
              onChange={(e) => {
                setRepositoryId(e.target.value);
                void control({ kind: 'status', repositoryId: e.target.value });
              }}
            >
              {view.repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <p>
            Selected branch: <strong>{repository?.branch}</strong>. Your working files stay in
            place.
          </p>
          <div className="group-git-buttons">
            <button disabled={busy} onClick={() => void control({ kind: 'status', repositoryId })}>
              Check status
            </button>
            <button disabled={busy} onClick={() => void control({ kind: 'observe', repositoryId })}>
              Check shared branch
            </button>
            <button
              disabled={busy}
              onClick={() => void control({ kind: 'snapshot', repositoryId })}
            >
              Check working files
            </button>
            <button
              disabled={busy}
              onClick={() => void control({ kind: 'warnings', repositoryId })}
            >
              Check overlaps
            </button>
          </div>
          {selected?.observedOid && (
            <p>
              Observed version: <code>{selected.observedOid.slice(0, 12)}</code>
            </p>
          )}
          {selected?.pending && (
            <p>
              A previous Git operation needs reconciliation.{' '}
              <button
                disabled={busy}
                onClick={() => void control({ kind: 'reconcile', repositoryId })}
              >
                Inspect saved operation
              </button>
            </p>
          )}
          {selected?.snapshot && (
            <section aria-label="Working files">
              <p>
                {selected.snapshot.dirty
                  ? 'Uncommitted changes.'
                  : 'No recorded uncommitted changes.'}{' '}
                {selected.snapshot.untracked && 'Untracked files present.'}{' '}
                {selected.snapshot.conflicts && 'Conflicts need attention.'}{' '}
                {!selected.snapshot.complete &&
                  'This check is incomplete; earlier change evidence is retained.'}
              </p>
              <p>
                Unsaved editor buffers cannot be checked. Save your files before comparing work.
              </p>
              {!!selected.snapshot.paths.length && <PathList paths={selected.snapshot.paths} />}
              {!!selected.snapshot.renames.length && (
                <>
                  <p>Renames</p>
                  <PathList paths={selected.snapshot.renames.map(([a, b]) => `${a} → ${b}`)} />
                </>
              )}
            </section>
          )}
          {!!selected?.warnings.length && (
            <section aria-label="Overlap warnings">
              {selected.warnings.map((warning, n) => (
                <div key={n}>
                  <p>{warning.message}</p>
                  <PathList paths={warning.paths} />
                </div>
              ))}
            </section>
          )}
          <details>
            <summary>Resource visibility and planned edits</summary>
            <p>
              Private shares no repository details. Metadata shares repository status. Selected
              content allows only the files you choose below.
            </p>
            <label>
              Visibility
              <select
                value={visibility}
                disabled={busy || Boolean(pending)}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
              >
                <option value="private">Private</option>
                <option value="metadata">Metadata only</option>
                <option value="content">Selected content</option>
              </select>
            </label>
            <fieldset disabled={busy || Boolean(pending)}>
              <legend>Selected files</legend>
              {repository?.paths.slice(pathPage * 25, (pathPage + 1) * 25).map((path) => (
                <label key={path.id}>
                  <input
                    type="checkbox"
                    checked={paths.includes(path.id)}
                    onChange={(e) =>
                      setPaths((prior) =>
                        e.target.checked
                          ? [...prior, path.id]
                          : prior.filter((id) => id !== path.id),
                      )
                    }
                  />
                  {path.name}
                </label>
              ))}
              {!repository?.paths.length && <p>No files have been configured for sharing.</p>}
            </fieldset>
            {(repository?.paths.length ?? 0) > 25 && (
              <div className="group-git-buttons">
                <button disabled={!pathPage} onClick={() => setPathPage(pathPage - 1)}>
                  Previous choices
                </button>
                <span>Page {pathPage + 1}</span>
                <button
                  disabled={(pathPage + 1) * 25 >= (repository?.paths.length ?? 0)}
                  onClick={() => setPathPage(pathPage + 1)}
                >
                  More choices
                </button>
              </div>
            )}
            <div className="group-git-buttons">
              <button
                disabled={!mutable || (visibility === 'content' && !paths.length)}
                onClick={() =>
                  change({
                    kind: 'policy',
                    repositoryId,
                    visibility,
                    paths: visibility === 'content' ? paths : [],
                  })
                }
              >
                Save visibility
              </button>
              <button
                disabled={
                  !mutable ||
                  !selected?.snapshot ||
                  !picked.length ||
                  picked.length > 256 ||
                  picked.some((p) => p.visibility !== 'content')
                }
                onClick={() => change({ kind: 'intent', repositoryId, paths })}
              >
                Share planned edits
              </button>
            </div>
            <p>
              Planned edits are an advisory warning for other collaborators, not a file lock. Choose
              currently shared content and check working files first.
            </p>
          </details>
          <details>
            <summary>Reviewed proposals and separate views</summary>
            <p>
              A proposal publishes only an independently reviewed version and its approved history.
              It does not merge or replace your checkout.
            </p>
            <label>
              Approved version
              <select
                value={reviewId}
                disabled={busy}
                onChange={(e) => setReviewId(e.target.value)}
              >
                <option value="">No version selected</option>
                {repository?.reviews.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.sourceOid.slice(0, 12)}
                  </option>
                ))}
              </select>
            </label>
            <div className="group-git-buttons">
              <button
                disabled={!mutable || !reviewId || selected?.pending}
                onClick={() => change({ kind: 'propose', repositoryId, reviewId })}
              >
                Publish reviewed proposal
              </button>
              <button
                disabled={!mutable || !selected?.observedOid || selected.pending}
                onClick={() => change({ kind: 'view', repositoryId, view: 'main' })}
              >
                Create separate main view
              </button>
              <button
                disabled={!mutable || !selected?.observedOid || selected.pending}
                onClick={() => change({ kind: 'view', repositoryId, view: 'task' })}
              >
                Create separate task view
              </button>
            </div>
          </details>
        </>
      )}
    </details>
  );
}
