import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageCircle, Terminal } from 'lucide-react';
import { agentSchema, effortLabel, id as uuidSchema, type ProviderId } from '@dock/shared';
import { api, apiScope } from '../api';
import { useCatalogs } from './ProjectConfiguration';

type Start = {
  key: string;
  name: string;
  provider: ProviderId | null;
  model: string | null;
  effort: string | null;
};
const providerNames: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude' };
const storageKey = (terminal: boolean) =>
  `dock:${apiScope()}:conversation-start:${terminal ? 'terminal' : 'misc'}`;
function fresh(terminal: boolean): Start {
  return {
    key: crypto.randomUUID(),
    name: terminal ? 'Terminal session' : 'New chat',
    provider: terminal ? 'codex' : null,
    model: null,
    effort: null,
  };
}
function read(terminal: boolean): Start {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(terminal)) ?? 'null') as Start | null;
    if (raw && uuidSchema.safeParse(raw.key).success && typeof raw.name === 'string')
      return { ...fresh(terminal), ...raw };
  } catch {
    /* A new request still works without saved browser state. */
  }
  return fresh(terminal);
}

/** New saved Misc chat, or an advanced terminal-only session. Creating it sends no prompt. */
export function NewConversation({
  terminal,
  heading,
  onCreated,
}: {
  terminal: boolean;
  heading: ReactNode;
  onCreated: (agentId: string) => void;
}) {
  const { catalogs, policy, reload } = useCatalogs();
  const [start, setStart] = useState(() => read(terminal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const enabled = policy?.enabledProviders ?? (['codex', 'claude'] as ProviderId[]);
  // Terminal-only sessions currently need Codex; saved chats support either provider.
  const provider: ProviderId = terminal ? 'codex' : (start.provider ?? enabled[0] ?? 'codex');
  const catalog = catalogs[provider];
  const model = catalog.models.find((m) => m.id === start.model);
  const persist = (next: Start) => {
    setStart(next);
    try {
      localStorage.setItem(storageKey(terminal), JSON.stringify(next));
    } catch {
      /* The exact request stays in this view. */
    }
  };
  // Any change makes a different request, so it needs a different retry key.
  const edit = (patch: Partial<Start>) => {
    setError('');
    persist({ ...start, ...patch, key: crypto.randomUUID() });
  };
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const create = async () => {
    if (running.current) return;
    const name = start.name.trim();
    if (!name) {
      setError('Give this conversation a name.');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    const request = { ...start, provider };
    persist(request);
    try {
      const agent = agentSchema.parse(
        await api('/conversations', {
          key: request.key,
          name,
          provider,
          ...(request.model ? { model: request.model } : {}),
          ...(request.model && request.effort ? { effort: request.effort } : {}),
          saveContact: !terminal,
        }),
      );
      localStorage.removeItem(storageKey(terminal));
      onCreated(agent.id);
    } catch (reason) {
      setError(
        reason instanceof TypeError
          ? 'The connection was interrupted. Your choices are saved; trying again will not create a second conversation.'
          : reason instanceof Error
            ? reason.message
            : 'Could not start the conversation. Your choices are saved; try again.',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="flow-page project-config">
      {heading}
      <form
        className="config-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <fieldset className="config-section" disabled={busy}>
          <legend>{terminal ? 'Terminal session' : 'Conversation'}</legend>
          <p className="config-help">
            {terminal
              ? 'An advanced Codex session opened in its native terminal. It keeps its own history and is not listed in your chats.'
              : 'A saved conversation outside your projects, listed under Misc. It works in its own private folder on this computer.'}
          </p>
          <label className="config-name">
            Name
            <input
              ref={nameInput}
              required
              maxLength={100}
              value={start.name}
              onChange={(event) => edit({ name: event.target.value })}
            />
          </label>
          <div className="config-grid">
            <label>
              Provider
              <select
                value={provider}
                disabled={terminal}
                onChange={(event) =>
                  edit({ provider: event.target.value as ProviderId, model: null, effort: null })
                }
              >
                {(['codex', 'claude'] as const)
                  .filter((p) => (terminal ? p === 'codex' : enabled.includes(p) || p === provider))
                  .map((p) => (
                    <option key={p} value={p}>
                      {providerNames[p]}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Model
              <select
                value={start.model ?? ''}
                onChange={(event) => {
                  const next = catalog.models.find((m) => m.id === event.target.value);
                  edit({ model: next?.id ?? null, effort: null });
                }}
              >
                <option value="">Central default</option>
                {catalog.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Thinking
              <select
                value={start.effort ?? ''}
                disabled={!model}
                onChange={(event) => edit({ effort: event.target.value || null })}
              >
                <option value="">{model ? 'Automatic' : 'Follows the central default'}</option>
                {model?.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effortLabel(effort)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {terminal && (
            <p className="config-help">
              Terminal-only sessions currently use Codex. Save a Claude conversation as a chat
              instead.
            </p>
          )}
          {catalog.error && (
            <p className="config-warning" role="alert">
              {catalog.error}{' '}
              <button type="button" className="config-link-button" onClick={reload}>
                Read models again
              </button>
            </p>
          )}
        </fieldset>
        <div className="config-actions">
          {error && (
            <p className="config-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="flow-button primary config-spawn"
            disabled={busy || !start.name.trim()}
          >
            {terminal ? <Terminal size={17} /> : <MessageCircle size={17} />}
            {busy ? 'Starting…' : terminal ? 'Create terminal session' : 'Start chat'}
          </button>
          <p className="config-help">
            {terminal
              ? 'Next, open its native terminal from Advanced controls. Nothing runs until you type there.'
              : 'Next, you’ll see the new conversation. No model work starts until you send a message.'}
          </p>
        </div>
      </form>
    </section>
  );
}
