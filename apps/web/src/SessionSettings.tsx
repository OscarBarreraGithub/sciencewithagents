import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { mcpCatalogSchema, effortLabel, type Model, type Agent } from '@dock/shared';
import { api, models } from './api';
import { useFormAction } from './useFormAction';
import { ExecutionInfo } from './ExecutionInfo';

export function SessionSettings({
  agent,
  close,
  act,
  embedded = false,
}: {
  agent: Agent;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  embedded?: boolean;
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
  const [mcpServers, setMcpServers] = useState(agent.mcpServers);
  const [pluginsEnabled, setPluginsEnabled] = useState(agent.pluginsEnabled);
  const [webSearch, setWebSearch] = useState(agent.webSearch);
  const [imageGeneration, setImageGeneration] = useState(agent.imageGeneration);
  const [mcpCatalog, setMcpCatalog] = useState<{ name: string }[]>([]);
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
      }}
    >
      <div className="settings-title">
        {embedded ? <h2>Session settings</h2> : <strong>Session settings</strong>}
        {!embedded && (
          <button className="icon-button" aria-label="Close settings" onClick={close}>
            <X size={16} />
          </button>
        )}
      </div>
      <p className="settings-help">
        The defaults are ready to use. Change these only when you want to.
      </p>
      {agent.provider === 'claude' && (
        <p className="settings-help">
          Claude uses this computer’s signed-in subscription and native configuration. Stop,
          Continue and New context are available here. Interactive terminal commands remain in
          Claude Code or its shared editor chat. Native helpers share their parent’s stop control.
        </p>
      )}
      <div className="settings-fields">
        {!agent.interview && (
          <label>
            Tools and connections
            <select
              value={toolPolicy}
              onChange={(event) => setToolPolicy(event.target.value as 'native' | 'restricted')}
            >
              <option value="native">
                Use my native {agent.provider === 'codex' ? 'Codex' : 'Claude'} settings
              </option>
              <option value="restricted">Keep app restrictions</option>
            </select>
          </label>
        )}
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
        <label>
          Reasoning
          <select
            value={effort}
            disabled={!model}
            onChange={(event) => setEffort(event.target.value)}
          >
            {(current?.efforts ?? [effort]).map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </label>
        {(agent.role === 'implementer' ||
          (agent.role === 'manager' && agent.toolPolicy === 'native' && !agent.interview)) && (
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
        )}
      </div>
      {toolPolicy === 'native' && (
        <p className="settings-help">
          Your native tools, skills, hooks and connections stay available with their own permission
          rules. QUARK monitors the work and can pause it. This does not change saved model choices
          or the task’s file permissions.
        </p>
      )}
      <p className="settings-help">
        Model chooses the AI. Reasoning sets how much thinking it can do; more can take longer.
        Changing settings does not erase this conversation or start work.
      </p>
      {!embedded && (
        <details>
          <summary>Provider, usage and assignment</summary>
          <ExecutionInfo agent={agent} />
        </details>
      )}
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
              ...(agent.provider === 'codex' && toolPolicy !== 'native' ? { mcpServers } : {}),
              ...(pluginsEnabled !== agent.pluginsEnabled ? { pluginsEnabled } : {}),
              ...(webSearch !== agent.webSearch ? { webSearch } : {}),
              ...(imageGeneration !== agent.imageGeneration ? { imageGeneration } : {}),
            });
            close();
          })
        }
      >
        Save settings
      </button>
    </div>
  );
}
