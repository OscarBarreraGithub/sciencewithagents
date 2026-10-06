import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { mcpCatalogSchema, effortLabel, type Model, type Agent } from '@dock/shared';
import { api, models } from './api';
import { useFormAction } from './useFormAction';
import { ExecutionInfo } from './ExecutionInfo';
import './SessionSettings.css';

export function SessionSettings({
  agent,
  close,
  act,
  embedded = false,
  titled = true,
}: {
  agent: Agent;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  embedded?: boolean;
  /** A host panel that already names this form can omit its own title. */
  titled?: boolean;
}) {
  const [catalog, setCatalog] = useState<Model[]>([]);
  const [model, setModel] = useState(
    agent.modelSelection === 'policy' ||
      (!agent.modelSelection && agent.assignment?.source === 'model_policy')
      ? ''
      : (agent.model ?? ''),
  );
  const [effort, setEffort] = useState<string>(agent.effort);
  const [permission, setPermission] = useState(agent.permission);
  const [toolPolicy, setToolPolicy] = useState(agent.toolPolicy ?? 'restricted');
  const [nativeChrome, setNativeChrome] = useState(agent.nativeChrome ?? 'inherit');
  const [mcpServers, setMcpServers] = useState(agent.mcpServers);
  const [pluginsEnabled, setPluginsEnabled] = useState(agent.pluginsEnabled);
  const [webSearch, setWebSearch] = useState(agent.webSearch);
  const [imageGeneration, setImageGeneration] = useState(agent.imageGeneration);
  const [mcpCatalog, setMcpCatalog] = useState<{ name: string }[]>([]);
  const hint = useId();
  const [saved, setSaved] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    // Navigation can render a cached snapshot before its refreshed settings.
    // Adopt that refresh only until the user starts editing this form.
    if (dirty.current) return;
    setModel(
      agent.modelSelection === 'policy' ||
        (!agent.modelSelection && agent.assignment?.source === 'model_policy')
        ? ''
        : (agent.model ?? ''),
    );
    setEffort(agent.effort);
    setPermission(agent.permission);
    setToolPolicy(agent.toolPolicy ?? 'restricted');
    setNativeChrome(agent.nativeChrome ?? 'inherit');
    setMcpServers(agent.mcpServers);
    setPluginsEnabled(agent.pluginsEnabled);
    setWebSearch(agent.webSearch);
    setImageGeneration(agent.imageGeneration);
  }, [agent.updatedAt, agent.id]);
  const action = useFormAction(act);
  const loadCatalog = () =>
    action.run(async () => {
      const value = await models(agent.id, agent.provider);
      setCatalog(value);
      if (toolPolicy !== 'native' && agent.provider === 'codex' && agent.role !== 'manager')
        setMcpCatalog(mcpCatalogSchema.parse(await api(`/agents/${agent.id}/mcp`)));
    });
  useEffect(() => {
    void loadCatalog();
  }, []);
  const current = catalog.find((m) => m.id === model);
  return (
    <div
      className="settings-card"
      onChange={() => {
        dirty.current = true;
        setSaved(false);
      }}
    >
      {(titled || !embedded) && (
        <div className="settings-title">
          {embedded ? <h2>Session settings</h2> : <strong>Session settings</strong>}
          {!embedded && (
            <button className="icon-button" aria-label="Close settings" onClick={close}>
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {/* Fields wrap by the card's own width, so a narrow panel stacks them instead of clipping. */}
      <div className="settings-fields session-fields">
        {!agent.interview && (
          <div className="session-field">
            <label>
              Tools and connections
              <select
                value={toolPolicy}
                aria-describedby={`${hint}-tools`}
                onChange={(event) => setToolPolicy(event.target.value as 'native' | 'restricted')}
              >
                <option value="native">
                  Use my native {agent.provider === 'codex' ? 'Codex' : 'Claude'} settings
                </option>
                <option value="restricted">Keep app restrictions</option>
              </select>
            </label>
            <small id={`${hint}-tools`}>
              {toolPolicy === 'native'
                ? 'Native tools, skills, hooks and permission rules stay on. QUARK can pause work.'
                : 'Only the tools chosen in this app are available.'}
            </small>
          </div>
        )}
        {agent.provider === 'claude' && toolPolicy === 'native' && !agent.interview && (
          <div className="session-field">
            <label>
              Chrome browser
              <select
                value={nativeChrome}
                onChange={(event) => setNativeChrome(event.target.value as 'inherit' | 'enabled')}
              >
                <option value="inherit">Inherit my native setting</option>
                <option value="enabled">Enable for this conversation</option>
              </select>
            </label>
          </div>
        )}
        <div className="session-field">
          <label>
            Model
            <select
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                const next = catalog.find((m) => m.id === event.target.value);
                if (next && !next.efforts.includes(effort)) setEffort(next.efforts[0]);
              }}
            >
              <option value="">Follow central model default</option>
              {model && !catalog.some((m) => m.id === model) && (
                <option value={model}>{model} (saved choice; unavailable in this catalog)</option>
              )}
              {catalog.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="session-field">
          <label>
            Reasoning
            <select
              value={effort}
              disabled={!model}
              aria-describedby={model ? undefined : `${hint}-effort`}
              onChange={(event) => setEffort(event.target.value)}
            >
              {(current?.efforts ?? [effort]).map((e) => (
                <option key={e} value={e}>
                  {effortLabel(e)}
                </option>
              ))}
            </select>
          </label>
          {!model && (
            <small id={`${hint}-effort`}>
              Set by the central default. Choose a model to change it.
            </small>
          )}
        </div>
        {(agent.role === 'implementer' ||
          (agent.role === 'manager' && agent.toolPolicy === 'native' && !agent.interview)) && (
          <div className="session-field">
            <label>
              Permissions
              <select
                value={permission}
                onChange={(event) => setPermission(event.target.value as Agent['permission'])}
              >
                <option value="read-only">Read files only</option>
                <option value="workspace-write">
                  {agent.role === 'manager'
                    ? 'Edit files in this project folder'
                    : 'Edit this task’s separate copy'}
                </option>
              </select>
            </label>
          </div>
        )}
      </div>
      {toolPolicy !== 'native' && agent.provider === 'codex' && agent.role !== 'manager' && (
        <fieldset className="mcp-settings">
          <legend>Web research</legend>
          <label>
            Web search
            <select
              value={webSearch}
              onChange={(event) => setWebSearch(event.target.value as Agent['webSearch'])}
            >
              <option value="disabled">Off</option>
              <option value="cached">Cached results</option>
              <option value="indexed">Index-gated access</option>
              <option value="live">Live web</option>
            </select>
          </label>
          <p>
            Uses Codex web search, not shell network access. Queries leave this computer and results
            are untrusted. Changing this setting reconnects the worker without deleting history.
          </p>
        </fieldset>
      )}
      {toolPolicy !== 'native' && agent.provider === 'codex' && agent.role !== 'manager' && (
        <fieldset className="mcp-settings">
          <legend>Image generation</legend>
          <label>
            <input
              type="checkbox"
              checked={imageGeneration}
              onChange={(event) => setImageGeneration(event.target.checked)}
            />
            <span>Use built-in image generation</span>
          </label>
          <p>
            Uses your Codex image-generation allowance without a separate API key. Prompts leave
            this computer. Changing this setting reconnects the worker without deleting history.
          </p>
        </fieldset>
      )}
      {toolPolicy !== 'native' && agent.provider === 'codex' && agent.role !== 'manager' && (
        <fieldset className="mcp-settings">
          <legend>Installed plugins</legend>
          <label>
            <input
              type="checkbox"
              checked={pluginsEnabled}
              onChange={(event) => setPluginsEnabled(event.target.checked)}
            />
            <span>Use installed Codex plugins</span>
          </label>
          <p>
            Uses your enabled plugins and connected apps from Codex. Tool calls prompt for approval;
            plugins can act outside the task sandbox. Use native /plugins to manage them. Changing
            this setting reconnects the worker without deleting history.
          </p>
        </fieldset>
      )}
      {toolPolicy !== 'native' && agent.provider === 'codex' && agent.role !== 'manager' && (
        <fieldset className="mcp-settings">
          <legend>MCP tools for this worker</legend>
          {Array.from(new Set([...mcpCatalog.map((s) => s.name), ...mcpServers])).map((name) => (
            <label key={name}>
              <input
                type="checkbox"
                checked={mcpServers.includes(name)}
                onChange={(event) =>
                  setMcpServers((old) =>
                    event.target.checked ? [...old, name] : old.filter((s) => s !== name),
                  )
                }
              />
              <span>
                {name}
                {!mcpCatalog.some((s) => s.name === name) ? ' (unavailable)' : ''}
              </span>
            </label>
          ))}
          <p>
            {mcpCatalog.length
              ? 'Every MCP tool call requires approval. These tools can act outside the task sandbox. Changing selection reconnects Codex without deleting history.'
              : 'No connected tools yet. These optional connections let an agent use other services. You can chat and work on projects without them.'}
          </p>
          <details>
            <summary>Connect a new tool (advanced setup)</summary>
            <p>
              New connections currently use Codex’s own setup; sciencewithagents does not yet have a
              connection setup wizard. Configure and sign in there, restart sciencewithagents, then
              select the connection here. Credentials stay in your local Codex configuration.
            </p>
            <a href="https://learn.chatgpt.com/docs/extend/mcp" target="_blank" rel="noreferrer">
              Open Codex’s connection setup guide
            </a>
          </details>
        </fieldset>
      )}
      {action.error && (
        <p className="session-error" role="alert">
          {action.error}
        </p>
      )}
      {action.error && !catalog.length && (
        <button className="secondary" disabled={action.pending} onClick={() => void loadCatalog()}>
          Try loading models again
        </button>
      )}
      <p className="settings-help session-save-note">
        Saving keeps this conversation and its history, and starts no work.
      </p>
      <button
        className="primary small-button"
        disabled={!catalog.length || action.pending}
        onClick={() =>
          void action.run(async () => {
            await api(`/agents/${agent.id}/settings`, {
              model: model || null,
              effort,
              permission,
              toolPolicy,
              ...(agent.provider === 'claude' && toolPolicy === 'native' ? { nativeChrome } : {}),
              ...(agent.provider === 'codex' && toolPolicy !== 'native' ? { mcpServers } : {}),
              ...(pluginsEnabled !== agent.pluginsEnabled ? { pluginsEnabled } : {}),
              ...(webSearch !== agent.webSearch ? { webSearch } : {}),
              ...(imageGeneration !== agent.imageGeneration ? { imageGeneration } : {}),
            });
            dirty.current = false;
            setSaved(true);
            close();
          })
        }
      >
        Save settings
      </button>
      {saved && !action.error && (
        <p className="settings-help session-saved" role="status">
          Settings saved.
        </p>
      )}
      {!embedded && (
        <details className="session-usage">
          <summary>Provider, usage and assignment</summary>
          <ExecutionInfo agent={agent} />
        </details>
      )}
    </div>
  );
}
