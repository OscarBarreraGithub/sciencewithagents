import { useRef, useState } from 'react';
import { RefreshCw, PlugZap, Download, ArrowUpRight } from 'lucide-react';
import { providerMaintenanceStateSchema, setupStatusSchema, type ProviderId } from '@dock/shared';
import { api } from '../api';
import { useReading } from './useHomeData';
export function ProviderActions({
  provider,
  showQuarkLink = true,
}: {
  provider: ProviderId;
  showQuarkLink?: boolean;
}) {
  const reading = useReading(
    `/providers/${provider}/maintenance`,
    providerMaintenanceStateSchema.parse,
  );
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const updateKey = useRef<string | null>(null);
  async function act(action: 'refresh' | 'check' | 'update') {
    if (busy) return;
    setBusy(action);
    setMessage('');
    setError('');
    try {
      if (action === 'refresh') {
        await api('/capacity/refresh', { provider });
        setMessage(
          'Usage refreshed. If the provider is unavailable, the last reading stays labelled.',
        );
        window.dispatchEvent(new Event('swa:refresh-home'));
      }
      if (action === 'check') {
        const state = setupStatusSchema.parse(
          await api('/providers/check', { provider, key: crypto.randomUUID() }),
        );
        const account = state.accounts.find((a) => a.provider === provider);
        const catalog = state.policy.catalogs.find((c) => c.provider === provider);
        setMessage(
          account?.state === 'signed-in' || account?.state === 'custom'
            ? catalog?.error
              ? 'Sign-in works. Model discovery needs another try in Welcome.'
              : 'Connected. Your existing sign-in and model catalog are ready.'
            : 'Connection needs attention. Open Welcome to sign in or repair setup. Your chats are retained.',
        );
      }
      if (action === 'update') {
        updateKey.current ??= crypto.randomUUID();
        const result = providerMaintenanceStateSchema.parse(
          await api('/providers/update', { provider, key: updateKey.current }),
        );
        setMessage(result.message);
        updateKey.current = null;
        reading.retry();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect. Try again.');
    } finally {
      setBusy('');
    }
  }
  const update = reading.data;
  return (
    <div className="provider-actions">
      <button disabled={!!busy} onClick={() => void act('refresh')}>
        <RefreshCw size={14} />
        {busy === 'refresh' ? 'Refreshing…' : 'Refresh usage'}
      </button>
      <button disabled={!!busy} onClick={() => void act('check')}>
        <PlugZap size={14} />
        {busy === 'check' ? 'Checking…' : 'Check connection'}
      </button>
      <button
        disabled={!!busy || update?.state === 'waiting' || update?.state === 'updating'}
        onClick={() => void act('update')}
      >
        <Download size={14} />
        {busy === 'update' || update?.state === 'updating'
          ? 'Checking for updates…'
          : update?.state === 'waiting'
            ? 'Update waiting for active work'
            : 'Check & install updates'}
      </button>
      {showQuarkLink && (
        <a href="#/work">
          Open QUARK <ArrowUpRight size={13} />
        </a>
      )}
      {(message || update?.checkedAt) && <p role="status">{message || update?.message}</p>}
      {update && !['idle', 'waiting', 'updating'].includes(update.state) && message && (
        <p role="status">{update.message}</p>
      )}
      {error && <p role="alert">{error}</p>}
      {(error ||
        message.includes('attention') ||
        message.includes('another try') ||
        update?.state === 'needs-help') && (
        <div className="provider-recovery">
          <a href="#/welcome">
            Open connection setup <ArrowUpRight size={13} />
          </a>
          <details>
            <summary>Terminal help</summary>
            <p>On this computer, check the installed provider and its sign-in:</p>
            <pre>
              {provider === 'claude'
                ? 'claude --version\nclaude auth status'
                : 'codex --version\ncodex login status'}
            </pre>
            {update?.command && (
              <>
                <p>Retry the installed provider’s update:</p>
                <pre>{update.command}</pre>
              </>
            )}
            <p>If one AI account still works, give its agent this request:</p>
            <pre>
              Diagnose my {provider} connection in sciencewithagents. Preserve my account,
              conversations and project files. Check the installed CLI, existing sign-in and model
              discovery. Repair the connection where possible, then verify it in Welcome. Tell me if
              a browser login is required.
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
