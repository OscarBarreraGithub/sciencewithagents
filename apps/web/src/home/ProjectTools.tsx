import { useEffect, useState } from 'react';
import {
  mcpCatalogSchema,
  projectToolsRequestSchema,
  projectToolsSchema,
  type ProjectTools as Policy,
  type WorkerTools,
} from '@dock/shared';
import { api, apiScope, ApiError } from '../api';

type Request = ReturnType<typeof projectToolsRequestSchema.parse>;
function readPending(key: string) {
  const saved = projectToolsRequestSchema.safeParse(
    JSON.parse(localStorage.getItem(key) ?? 'null'),
  );
  return saved.success ? saved.data : null;
}
function clearPending(key: string, request: Request) {
  if (readPending(key)?.key === request.key) localStorage.removeItem(key);
}

export function ProjectTools({ projectId }: { projectId: string }) {
  const storageKey = `dock:${apiScope()}:worker-tools:${projectId}`;
  const [pending, setPending] = useState<Request | null>(() => {
    try {
      return readPending(storageKey);
    } catch {
      return null;
    }
  });
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<WorkerTools | null>(pending?.codex ?? null);
  const [toolPolicy, setToolPolicy] = useState<Policy['toolPolicy']>(
    pending ? (pending.toolPolicy ?? 'restricted') : 'native',
  );
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const path = `/projects/${projectId}/worker-tools`;
  useEffect(() => {
    let active = true;
    void api(path)
      .then((value) => {
        if (!active) return;
        const saved = projectToolsSchema.parse(value);
        setPolicy(saved);
        setDraft((previous) => previous ?? saved.codex);
        setToolPolicy(pending ? (pending.toolPolicy ?? 'restricted') : saved.toolPolicy);
      })
      .catch(() => {
        if (active) setError('Could not read worker tool settings. Try again when connected.');
      });
    return () => {
      active = false;
    };
  }, [path]);
  const load = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = projectToolsSchema.parse(await api(path));
      setPolicy(saved);
      setDraft(pending?.codex ?? saved.codex);
      setToolPolicy(pending ? (pending.toolPolicy ?? 'restricted') : saved.toolPolicy);
    } catch {
      setError('Could not read worker tool settings. Your changes are still here.');
    } finally {
      setBusy(false);
    }
  };
  const change = (value: Partial<WorkerTools>) => {
    if (draft && !pending) {
      setDraft({ ...draft, ...value });
      setNotice('');
    }
  };
  const submit = async () => {
    if (!policy || !draft) return;
    const request = pending ?? {
      key: crypto.randomUUID(),
      revision: policy.revision,
      toolPolicy,
      codex: draft,
    };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const other = readPending(storageKey);
      if (!pending && other) {
        setPending(other);
        setDraft(other.codex);
        setToolPolicy(other.toolPolicy ?? 'restricted');
        setError(
          'Another tab has an unconfirmed save. Check that request first; no new change was sent.',
        );
        return;
      }
      // Retain the exact request before crossing the connection, including across reload.
      // A late confirmation from this tab must not overwrite another tab's newer receipt.
      if (!other || other.key === request.key)
        localStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      projectToolsSchema.parse(await api(path, request));
      const saved = projectToolsSchema.parse(await api(path));
      clearPending(storageKey, request);
      setPending(null);
      setPolicy(saved);
      setDraft(saved.codex);
      setToolPolicy(saved.toolPolicy);
      setNotice(
        saved.toolPolicy === 'native'
          ? 'Saved. New workers use native settings. Existing conversations keep their settings.'
          : 'Saved. New workers follow the app restrictions. Existing conversations keep their settings.',
      );
    } catch (reason) {
      if (reason instanceof ApiError && [400, 404, 409, 422].includes(reason.status)) {
        setPending(null);
        try {
          clearPending(storageKey, request);
        } catch {
          /* No unconfirmed action will be replayed automatically. */
        }
      }
      setError(
        reason instanceof ApiError
          ? reason.message
          : 'Could not confirm the save. Keep this page open and check the same request when connected.',
      );
    } finally {
      setBusy(false);
    }
  };
  const names = [
    ...new Set([
      ...(catalog ?? []),
      ...(policy?.codex.mcpServers ?? []),
      ...(draft?.mcpServers ?? []),
    ]),
  ].sort();
  return (
    <details className="flow-form-panel project-tools">
      <summary>Tools for new workers</summary>
      <p>
        New workers use your native tools and connections. QUARK watches budgets; your provider’s
        permissions still apply.
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <p role="status">
          A save needs confirmation. Check the same request before making other changes.
        </p>
      )}
      {draft && policy ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy || !!pending}>
            <legend>Default for new workers</legend>
            <label>
              Worker capabilities
              <select
                value={toolPolicy}
                onChange={(event) => {
                  setToolPolicy(event.target.value as Policy['toolPolicy']);
                  setNotice('');
                }}
              >
                <option value="native">Use native settings</option>
                <option value="restricted">Use app restrictions</option>
              </select>
            </label>
            {toolPolicy === 'native' && (
              <p className="flow-note">
                Codex and Claude keep their configured capabilities. Existing conversations keep
                their settings, and your previous restrictions stay saved.
              </p>
            )}
          </fieldset>
          {toolPolicy === 'restricted' && (
            <fieldset disabled={busy || !!pending}>
              <legend>Codex worker allowance</legend>
              <p className="flow-note">
                Managers request tools within this allowance. These switches apply to Codex;
                restricted Claude workers use the existing read or implementation tool set. Choose
                native settings above to use Claude’s configured tools and connections.
              </p>
              <label>
                Web research
                <select
                  value={draft.webSearch}
                  onChange={(event) =>
                    change({ webSearch: event.target.value as WorkerTools['webSearch'] })
                  }
                >
                  <option value="disabled">Not available</option>
                  <option value="indexed">Search the saved web index</option>
                  {draft.webSearch === 'cached' && (
                    <option value="cached">Saved web index (existing choice)</option>
                  )}
                  <option value="live">Live web search or saved index</option>
                </select>
              </label>
              <label className="project-tools-check">
                <input
                  type="checkbox"
                  checked={draft.imageGeneration}
                  onChange={(event) => change({ imageGeneration: event.target.checked })}
                />
                <span>Generate images</span>
              </label>
              <label className="project-tools-check">
                <input
                  type="checkbox"
                  checked={draft.pluginsEnabled}
                  onChange={(event) => change({ pluginsEnabled: event.target.checked })}
                />
                <span>Installed Codex plugins and connected apps</span>
              </label>
              <p className="flow-note">
                Uses what is already installed and connected on this computer. This does not install
                plugins or approve actions in other services.
              </p>
              <div className="flow-section-title">
                <h3>Connected tool servers (MCP)</h3>
                <button
                  type="button"
                  className="flow-button"
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      setCatalog(
                        mcpCatalogSchema
                          .parse(await api(`${path}/catalog`))
                          .map((server) => server.name),
                      );
                    } catch {
                      setError(
                        'Could not read this computer’s Codex tool catalog. Saved selections are retained; try again.',
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {catalog ? 'Refresh tool list' : 'Show available tools'}
                </button>
              </div>
              {catalog?.length === 0 && <p>No configured Codex tool servers were found.</p>}
              {names.map((name) => (
                <label key={name} className="project-tools-check">
                  <input
                    type="checkbox"
                    checked={draft.mcpServers.includes(name)}
                    disabled={!draft.mcpServers.includes(name) && draft.mcpServers.length >= 32}
                    onChange={(event) =>
                      change({
                        mcpServers: event.target.checked
                          ? [...draft.mcpServers, name]
                          : draft.mcpServers.filter((item) => item !== name),
                      })
                    }
                  />
                  <span>
                    {name}
                    {catalog && !catalog.includes(name) ? ' · saved, currently unavailable' : ''}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="project-tools-actions">
            <button className="flow-button primary" disabled={busy}>
              {busy ? 'Checking…' : pending ? 'Check save request' : 'Save worker settings'}
            </button>
            <button
              type="button"
              className="flow-button"
              disabled={busy || !!pending}
              onClick={() => void load()}
            >
              Reload saved settings
            </button>
          </div>
        </form>
      ) : (
        <button className="flow-button" disabled={busy} onClick={() => void load()}>
          Read worker settings
        </button>
      )}
    </details>
  );
}
