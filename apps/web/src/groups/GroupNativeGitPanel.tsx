import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  groupNativeGitRequestSchema,
  groupNativeGitViewSchema,
  type GroupNativeGitRequest,
  type GroupNativeGitView,
} from '@dock/shared/dist/group-native-git.js';
import { api, apiScope, ApiError, connectionLost } from '../api';
import './group-git-panel.css';
import { groupGitHubSetupPromptForFolder } from './GroupSetupPrompt';

/** The owner supplies saved handles and exact commits, never a filesystem path. */
export function GroupNativeGitPanel({
  handle,
  request,
  connectionTarget,
  advancedTarget,
  refreshKey = 0,
}: {
  handle: string;
  request?: (input: GroupNativeGitRequest) => Promise<unknown>;
  connectionTarget?: HTMLDivElement | null;
  advancedTarget?: HTMLDivElement | null;
  refreshKey?: number;
}) {
  const [view, setView] = useState<GroupNativeGitView | null>(null);
  const [username, setUsername] = useState('');
  const [autoSync, setAutoSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<GroupNativeGitRequest | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const refreshVersion = useRef(refreshKey);
  refreshVersion.current = refreshKey;
  const queuedStatus = useRef(false);
  const storageKey = `swa:${apiScope()}:group-native-git:${handle}`;

  async function control(input: GroupNativeGitRequest) {
    if (inFlight.current) {
      if (input.action === 'status') queuedStatus.current = true;
      return;
    }
    const current = generation.current;
    const revision = refreshVersion.current;
    const changed = 'key' in input;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (changed) {
        sessionStorage.setItem(storageKey, JSON.stringify(input));
        setPending(input);
      }
      const result = groupNativeGitViewSchema.parse(
        await (request ? request(input) : api('/groups/native-git', input)),
      );
      if (generation.current !== current) return;
      if (revision === refreshVersion.current) {
        setView(input.action === 'connect' ? null : result);
        if (input.action !== 'connect') {
          setUsername(result.githubUsername);
          setAutoSync(result.autoSync);
        }
      } else queuedStatus.current = true;
      if (changed) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
      }
      if (input.action === 'connect') {
        const currentView = groupNativeGitViewSchema.parse(
          await (request
            ? request({ action: 'status', handle })
            : api('/groups/native-git', { action: 'status', handle })),
        );
        if (generation.current !== current) return;
        if (revision === refreshVersion.current) {
          setView(currentView);
          setUsername(currentView.githubUsername);
          setAutoSync(currentView.autoSync);
        } else queuedStatus.current = true;
      }
    } catch (reason) {
      if (generation.current !== current) return;
      setError(
        reason instanceof Error ? reason.message : 'Shared repository status is unavailable.',
      );
      // A definite refusal did not acknowledge this change; a new inspected
      // action can replace it. Unknown delivery retains the exact request.
      if (
        changed &&
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        !connectionLost(reason)
      ) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
      }
    } finally {
      if (generation.current === current) {
        inFlight.current = false;
        setBusy(false);
        if (queuedStatus.current) {
          queuedStatus.current = false;
          void control({ action: 'status', handle });
        }
      }
    }
  }
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    queuedStatus.current = false;
    setView(null);
    setUsername('');
    setAutoSync(false);
    setBusy(false);
    setError('');
    let saved: GroupNativeGitRequest | null = null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      const parsed = raw ? groupNativeGitRequestSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success && parsed.data.handle === handle && 'key' in parsed.data)
        saved = parsed.data;
    } catch {
      /* Invalid local retry data cannot select another workspace. */
    }
    setPending(saved);
    void control({ action: 'status', handle });
    return () => {
      generation.current++;
    };
  }, [handle]);

  useEffect(() => {
    if (refreshKey) {
      setView(null);
      void control({ action: 'status', handle });
    }
  }, [refreshKey]);
  const mutable = !busy && !pending;
  const preview = view?.preview;
  const setupPrompt = `${groupGitHubSetupPromptForFolder(view?.workspacePath ?? '(choose the intended work folder first)', false)}\nCurrent GitHub repository: ${JSON.stringify(view?.repository ?? '(ask me which intended private repository to connect)')}.`;
  const advanced = (
    <section className="group-git-panel" aria-label="Shared GitHub workspace">
      <h3>Shared files on GitHub</h3>
      <p>
        Each member uses their own GitHub account. Add your username when you know it; leaving it
        blank sends no invitation.
      </p>
      {view?.repository && (
        <p>
          Repository:{' '}
          <a href={view.repository} target="_blank" rel="noreferrer">
            {view.repository}
          </a>
        </p>
      )}
      {view?.branch && (
        <p>
          Current work branch: <code>{view.branch}</code>
        </p>
      )}
      <p role="status">{view?.message ?? 'Opening this computer’s shared workspace…'}</p>
      {view?.workspacePath && (
        <details>
          <summary>GitHub setup prompt for your agent</summary>
          <p>Copy this into the setup agent on this computer.</p>
          <textarea
            aria-label="Scoped GitHub setup prompt"
            readOnly
            value={setupPrompt}
            rows={9}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(setupPrompt)
                .catch(() => setError('Select and copy the setup prompt above.'))
            }
          >
            Copy GitHub setup prompt
          </button>
        </details>
      )}
      {view?.dirty && (
        <p>Uncommitted files are preserved. Finish and review the task before sharing.</p>
      )}
      {!!view?.localEdits.length && (
        <details>
          <summary>Unfinished files on this computer</summary>
          <p>
            This local status includes task workspaces. File contents stay local until review and
            sharing.
          </p>
          <ul>
            {view.localEdits.map((workspace) => (
              <li key={workspace.taskId ?? 'group'}>
                <strong>{workspace.label}</strong> ·{' '}
                {workspace.state === 'unavailable'
                  ? 'status unavailable'
                  : workspace.changed
                    ? `${workspace.changed} changed`
                    : 'clean'}
                {!!workspace.withheld && (
                  <p>{workspace.withheld} private or runtime names withheld.</p>
                )}
                {!!workspace.files.length && (
                  <ul>
                    {workspace.files.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code> · {file.status === '??' ? 'new file' : 'edited'}
                      </li>
                    ))}
                  </ul>
                )}
                {workspace.truncated && <p>Showing the first 16 file names.</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {view?.busy && (
        <p>
          Shared agents are active. Fetching is safe; applying or switching waits for their work to
          settle.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void control({
            action: 'configure',
            handle,
            key: crypto.randomUUID(),
            githubUsername: username,
            autoSync,
          });
        }}
      >
        <label>
          Your GitHub username (optional)
          <input
            value={username}
            maxLength={39}
            autoComplete="off"
            placeholder="Leave blank until provided"
            disabled={!mutable}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <fieldset disabled={!mutable}>
          <label>
            <input
              type="checkbox"
              checked={autoSync}
              disabled={!view?.available}
              onChange={(event) => setAutoSync(event.target.checked)}
            />
            Automatic sync
          </label>
          <p>Syncs committed, reviewed changes; leaves unfinished work untouched.</p>
        </fieldset>
        <div className="group-git-buttons">
          <button disabled={!mutable || !view}>Save GitHub setup</button>
          <button
            type="button"
            disabled={!mutable || !view?.available}
            onClick={() => void control({ action: 'sync', handle, key: crypto.randomUUID() })}
          >
            Sync now
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void control({ action: 'status', handle })}
          >
            Refresh status
          </button>
        </div>
      </form>
      {pending && (
        <div className="group-git-retry">
          <p>This change’s acknowledgement was interrupted. Retry its saved request.</p>
          <button disabled={busy} onClick={() => void control(pending)}>
            Retry saved Git change
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {!!view?.tasks.length && (
        <details>
          <summary>Review shared tasks</summary>
          <ul>
            {view.tasks.map((task) => (
              <li key={task.id}>
                <span>
                  {task.title} · {task.status}
                  {task.reviewed ? ' · reviewed' : ''}
                </span>
                {task.status === 'done' && task.reviewed && (
                  <button
                    disabled={!mutable}
                    onClick={() => void control({ action: 'preview', handle, taskId: task.id })}
                  >
                    Inspect exact changes
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {preview && (
        <section aria-label="Exact shared task changes">
          <h4>Review before applying</h4>
          <p>
            Source <code>{preview.source.slice(0, 12)}</code> → shared copy{' '}
            <code>{preview.target.slice(0, 12)}</code>
          </p>
          <pre style={{ overflowX: 'auto', maxWidth: '100%', maxHeight: '24rem' }}>
            {preview.changes}
            {'\n'}
            {preview.patch}
          </pre>
          {preview.canApply ? (
            <button
              disabled={!mutable || view?.busy}
              onClick={() =>
                void control({
                  action: 'apply',
                  handle,
                  key: crypto.randomUUID(),
                  taskId: preview.taskId,
                  source: preview.source,
                  target: preview.target,
                })
              }
            >
              Confirm and apply these exact changes
            </button>
          ) : (
            <p>
              The shared copy advanced. Ask your manager to prepare and independently review updated
              changes; both branches are preserved.
            </p>
          )}
          <p>
            This is your confirmation for projects that require human review. GitHub publication
            follows your sync setting.
          </p>
        </section>
      )}
    </section>
  );
  const connection = (
    <section className="group-git-panel" aria-label="Shared repository connection">
      <h3>Connect the shared repository</h3>
      <p>
        After your setup agent prepares this folder’s private repository, verify access using your
        own native GitHub account. Connecting makes no model call.
      </p>
      {view?.connected === true && (
        <p role="status">Repository verified. Automatic sync: {view.autoSync ? 'On' : 'Paused'}.</p>
      )}
      <p role="status">{view?.message ?? 'Reading repository status…'}</p>
      {view?.connected === undefined && view && (
        <p>
          This host has not reported a verified connection. Update it before relying on the new
          connection workflow.
        </p>
      )}
      <div className="group-git-buttons">
        {view?.connected !== true && (
          <button
            className="secondary"
            type="button"
            disabled={!mutable || !view?.available}
            onClick={() => void control({ action: 'connect', handle, key: crypto.randomUUID() })}
          >
            Connect shared repository
          </button>
        )}
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => void control({ action: 'status', handle })}
        >
          Check repository
        </button>
        {pending?.action === 'connect' && (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => void control(pending)}
          >
            Retry saved connection
          </button>
        )}
      </div>
      {pending && pending.action !== 'connect' && (
        <p>
          A saved repository change is unresolved. Review it in Advanced → Git sync and reviewed
          changes before connecting again.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {view?.connected && (
        <p>
          Only reviewed, applied commits sync. Advanced → Git sync and reviewed changes lets you
          pause or inspect sync; an existing saved pause is preserved.
        </p>
      )}
    </section>
  );
  if (connectionTarget !== undefined || advancedTarget !== undefined)
    return (
      <>
        {connectionTarget && createPortal(connection, connectionTarget)}
        {advancedTarget && createPortal(advanced, advancedTarget)}
      </>
    );
  return advanced;
}
