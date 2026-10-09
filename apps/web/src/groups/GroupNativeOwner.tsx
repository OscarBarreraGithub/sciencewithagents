import { useEffect, useState } from 'react';
import {
  groupNativeOwnerStatusSchema,
  type GroupNativeOwnerInput,
  type GroupNativeOwnerStatus,
} from '@dock/shared/dist/group-native-owner.js';
import { OwnerTerminal } from '../OwnerTerminal';
import { apiScope } from '../api';
import type { GroupChatClient } from './GroupChat';
import './group-native-owner.css';
import type { GroupHostChat } from '@dock/shared/dist/group-host.js';

/** This panel sends opaque saved handles only; host setup never accepts browser paths or commands. */
export function GroupNativeOwner({
  handle,
  requestId,
  request,
  onChanged,
  onManagedCoordination,
  executionMode,
  requestPendingConsent,
  requestState,
  requestText,
}: {
  handle: string;
  requestId?: string;
  request: GroupChatClient;
  onChanged: () => void;
  onManagedCoordination?: (available: boolean | undefined) => void;
  executionMode?: 'host' | 'isolated';
  requestPendingConsent?: boolean;
  requestState?: NonNullable<GroupHostChat['nativeRequests']>[number]['state'];
  requestText?: string;
}) {
  const [status, setStatus] = useState<GroupNativeOwnerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [terminal, setTerminal] = useState<string | null>(null);
  const hostMode = (status?.executionMode ?? executionMode) === 'host';
  const storageKey = `swa:${apiScope()}:native-owner:${handle}:${requestId ?? 'acceptance'}`;
  async function control(action: GroupNativeOwnerInput['action'], kind?: 'explicit' | 'crash') {
    setBusy(true);
    setError('');
    try {
      let body: unknown = {
        handle,
        action,
        ...(requestId &&
        ['status', 'sign-in', 'restart-sign-in', 'continue', 'reject', 'reconnect'].includes(action)
          ? { requestId }
          : {}),
        ...(kind ? { kind } : {}),
      };
      if (action !== 'status') {
        // Retain the exact operation across network failure/reload. An explicit
        // different action replaces it; the server never repeats lost-ack work.
        const saved = sessionStorage.getItem(storageKey);
        let prior: Record<string, unknown> | null = null;
        try {
          prior = saved ? (JSON.parse(saved) as Record<string, unknown>) : null;
        } catch {
          /* invalid local receipt */
        }
        const signature = JSON.stringify(body);
        body =
          prior?.signature === signature
            ? prior.body
            : { ...(body as object), key: crypto.randomUUID() };
        sessionStorage.setItem(storageKey, JSON.stringify({ signature, body }));
      }
      const value = groupNativeOwnerStatusSchema.parse(await request('native-owner', body));
      setStatus(value);
      onManagedCoordination?.(value.managedCoordination);
      if (value.terminalId && action === 'sign-in') setTerminal(value.terminalId);
      if (action !== 'status') sessionStorage.removeItem(storageKey);
      onChanged();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Native owner setup unavailable. Check the saved context before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setStatus(null);
    setConsent(false);
    void control('status');
  }, [handle, requestId]);
  if (hostMode)
    return (
      <details className="group-native-owner" open={Boolean(requestId)}>
        <summary>{requestId ? 'This agent request' : 'My agent on this computer'}</summary>
        <p role="status">{status?.message ?? 'Checking local agent access…'}</p>
        <p>
          Uses this computer’s existing sign-in and native tools. Shared and private chats keep
          separate histories; agents retain normal access to this computer. Private content is not
          automatically shared.
        </p>
        {requestId && requestText && (
          <p>
            <strong>Request:</strong> {requestText.slice(0, 240)}
          </p>
        )}
        {requestPendingConsent && (
          <p>
            Enable access, then continue this exact saved request. Ask and Work use your provider
            allowance.
          </p>
        )}
        <div className="group-native-owner-actions">
          {(error || !status || requestState === 'unknown' || requestState === 'blocked') && (
            <button disabled={busy} onClick={() => void control('status')}>
              {requestId ? 'Check this request' : 'Refresh agent access'}
            </button>
          )}
          {status && !status.hostEnabled && (
            <button disabled={busy} onClick={() => void control('prepare')}>
              Enable agents on this computer
            </button>
          )}
          {requestId &&
            requestPendingConsent &&
            status?.hostEnabled &&
            status.state !== 'pending' && (
              <button disabled={busy} onClick={() => void control('continue')}>
                Continue this request
              </button>
            )}
          {requestId &&
            requestState &&
            requestState !== 'completed' &&
            status &&
            !['stopped', 'rejected', 'verified'].includes(status.state) && (
              <button disabled={busy} onClick={() => void control('reject')}>
                Cancel this request
              </button>
            )}
        </div>
        {requestId && (
          <p>
            Cancellation targets this local request. It does not withdraw shared messages or undo
            completed changes.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    );
  if (terminal)
    return (
      <OwnerTerminal
        key={terminal}
        fixedSessionId={terminal}
        computer="Isolated group sign-in"
        onBack={() => {
          setTerminal(null);
          void control('status');
        }}
      />
    );
  return (
    <details className="group-native-owner" open={Boolean(requestId)}>
      <summary>{requestId ? 'Authorize this saved agent request' : 'Native agent setup'}</summary>
      <p role="status">{status?.message ?? 'Checking this saved context…'}</p>
      {status && (
        <p>
          This chat runs in its own Linux workspace with separate provider sign-in. Native shell,
          browser tools, skills, hooks and integrations configured there stay available. Personal
          credentials are not copied; macOS desktop control and host-only tools are unavailable.
          Shared and private chats authorize separately.
        </p>
      )}
      {status && (
        <label>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          I authorize provider sign-in and{' '}
          {requestId ? 'this saved request.' : 'the setup checks I choose.'}
        </label>
      )}
      {status?.device && (
        <p>
          Open{' '}
          <a href={status.device.verificationUrl} target="_blank" rel="noreferrer">
            native Codex authorization
          </a>{' '}
          and enter <strong>{status.device.userCode}</strong>. This code is temporary and stays out
          of group messages.
        </p>
      )}
      <div className="group-native-owner-actions">
        <button disabled={busy} onClick={() => void control('status')}>
          Check sign-in
        </button>
        {status?.state === 'signed-out' && (
          <button disabled={busy || !consent} onClick={() => void control('sign-in')}>
            Sign in to {status.provider === 'claude' ? 'Claude' : 'Codex'}
          </button>
        )}
        {requestId && status?.canReconnect && (
          <button disabled={busy || !consent} onClick={() => void control('reconnect')}>
            Reconnect saved request
          </button>
        )}
        {status?.canRetrySignIn && (
          <button disabled={busy || !consent} onClick={() => void control('restart-sign-in')}>
            Retry sign-in
          </button>
        )}
        {status?.terminalId && (
          <button disabled={busy} onClick={() => setTerminal(status.terminalId!)}>
            Resume Claude sign-in
          </button>
        )}
        {requestId && status?.state === 'authenticated' && (
          <button disabled={busy || !consent} onClick={() => void control('continue')}>
            Continue saved request
          </button>
        )}
        {status?.setupId && !['stopped', 'rejected', 'unknown'].includes(status.state) && (
          <button disabled={busy} onClick={() => void control('reject')}>
            Decline and stop this context
          </button>
        )}
      </div>
      {!requestId && (
        <details>
          <summary>Advanced setup-agent checks</summary>
          <div className="group-native-owner-actions">
            {status?.configured && !status.productionReady && !status.setupId && (
              <button disabled={busy || !consent} onClick={() => void control('prepare')}>
                Prepare isolated context
              </button>
            )}
            {status?.state === 'authenticated' && (
              <button disabled={busy || !consent} onClick={() => void control('verify-tools')}>
                Check native tools (uses allowance)
              </button>
            )}
            {status?.state === 'verified' && (
              <>
                <button
                  disabled={busy || !consent}
                  onClick={() => void control('verify-stop', 'explicit')}
                >
                  Check Stop
                </button>
                <button
                  disabled={busy || !consent}
                  onClick={() => void control('verify-stop', 'crash')}
                >
                  Check crash cleanup
                </button>
              </>
            )}
            {status?.state === 'stopped' && (
              <button disabled={busy || !consent} onClick={() => void control('approve')}>
                Finish verified setup
              </button>
            )}
          </div>
          <p>
            Before first use, check native tools and verify that background processes stop safely.
            Use one fresh shared chat and one fresh private chat for the two stop checks. Your setup
            agent must also record the independent source review. Missing checks keep native work
            unavailable.
          </p>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
