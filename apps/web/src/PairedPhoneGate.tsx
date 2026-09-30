import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LockKeyhole, Smartphone } from 'lucide-react';
import {
  startRegistration,
  startAuthentication,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { PhoneStatus } from '@dock/shared';
import { api } from './api';
import { PhoneDeviceSetup } from './PhoneDeviceSetup';

const verificationNames = new Set([
  'AbortError',
  'ConstraintError',
  'InvalidStateError',
  'NotAllowedError',
  'NotSupportedError',
  'SecurityError',
  'TypeError',
  'UnknownError',
]);
const verificationCodes = new Set([
  'ERROR_CEREMONY_ABORTED',
  'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT',
  'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT',
  'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED',
  'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
  'ERROR_MALFORMED_PUBKEYCREDPARAMS',
  'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG',
  'ERROR_INVALID_DOMAIN',
  'ERROR_INVALID_RP_ID',
  'ERROR_INVALID_USER_ID_LENGTH',
  'ERROR_AUTHENTICATOR_GENERAL_ERROR',
]);
const expiredPreparation =
  'This pairing attempt has expired. Create a new code on your computer, then enter it here.';
const unsupportedPasskeys =
  'This browser cannot save a passkey. Open this address in an up-to-date Safari or Chrome browser and check that your phone has a screen lock and a passkey provider enabled.';
const uncertainFinish =
  'We could not confirm whether pairing finished. Check connection to look for the computer confirmation. Do not save another passkey for this attempt.';
function verificationError(error: unknown, unlocking = false) {
  // Only fixed diagnostic identifiers may leave the browser error. Never show its
  // message/cause/stack: extensions and authenticators can put private values there.
  const value =
    error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {};
  const name =
    typeof value.name === 'string' && verificationNames.has(value.name) ? value.name : '';
  const code =
    typeof value.code === 'string' && verificationCodes.has(value.code) ? value.code : '';
  const detail = [name, code].filter(Boolean).join(' · ') || 'Unclassified verification error';
  if (name === 'NotAllowedError' || name === 'AbortError')
    return {
      detail,
      message:
        'Your phone did not finish verification. It may have been cancelled, timed out, or unavailable. Check your phone’s passkey prompt and try again when ready.',
    };
  if (name === 'SecurityError')
    return {
      detail,
      message:
        'The browser rejected this address for passkeys. Open the exact secure phone address shown on your computer in Safari or Chrome. If it still fails, share the verification detail below so the setup can be checked.',
    };
  if (name === 'ConstraintError' || name === 'NotSupportedError')
    return {
      detail,
      message: unlocking
        ? 'This browser could not use your saved passkey. Open the same phone address in the browser or home-screen app where you paired it, then try unlocking again. Pairing is unchanged.'
        : unsupportedPasskeys,
    };
  if (name === 'InvalidStateError')
    return {
      detail,
      message: unlocking
        ? 'Your phone could not verify its saved passkey. Try unlocking again. Pairing is unchanged.'
        : 'Your phone reports that this passkey already exists. Check connection first. If this phone is not paired, use a new code from your computer.',
    };
  return {
    detail,
    message: unlocking
      ? 'Your phone could not be unlocked. Check connection, then try Unlock sciencewithagents again. Pairing is unchanged.'
      : 'The phone could not save its passkey. Try again, or open this address in an up-to-date Safari or Chrome browser. If it keeps failing, share the verification detail below.',
  };
}
const preparationMessages = new Set([
  'Pairing is closed. Create a new code on your computer.',
  'That code did not match. Check the code on your computer.',
  'This browser is already paired. Unlock it instead.',
  'Phone access is turned off on your computer.',
  'Pairing was cancelled. Create a new code.',
  expiredPreparation,
  unsupportedPasskeys,
]);
const codeErrors = new Set([
  'Pairing is closed. Create a new code on your computer.',
  'That code did not match. Check the code on your computer.',
  'Pairing was cancelled. Create a new code.',
  expiredPreparation,
]);
const unlockMessages = new Set([
  'This browser is not paired.',
  'Unlock expired. Try Unlock sciencewithagents again.',
  'Phone verification did not finish. Try Unlock sciencewithagents again.',
  'Device access changed. Try unlocking again.',
  'Phone access is turned off on your computer.',
]);
type PreparedRegistration = { options: PublicKeyCredentialCreationOptionsJSON; expiresAt: number };
// Deny-only intent, never a credential or a grant of access. A failed/offline
// manual lock must not be undone by reopening a remembered server session.
const manualLockKey = 'dock:phone-manually-locked';
function isManuallyLocked() {
  try {
    return localStorage.getItem(manualLockKey) === '1';
  } catch {
    return true;
  }
}

export function PairedPhoneGate({
  status,
  refresh,
  connectionError,
  pairingScan,
  children,
}: {
  status: PhoneStatus;
  refresh: () => Promise<PhoneStatus | null>;
  connectionError: string;
  pairingScan?: { code: string };
  children: ReactNode;
}) {
  const [sealed, setSealed] = useState(
    !(status.enrolled && status.paired && !status.requireUnlock && !isManuallyLocked()),
  );
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(pairingScan?.code ?? '');
  const [setupStep, setSetupStep] = useState<'code' | 'name'>(pairingScan?.code ? 'name' : 'code');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState('');
  const [prepared, setPrepared] = useState<PreparedRegistration | null>(null);
  const preparedRef = useRef<PreparedRegistration | null>(null);
  const [finishUncertain, setFinishUncertain] = useState(false);
  const busyRef = useRef(false);
  const locking = useRef<Promise<unknown>>(Promise.resolve());
  const requireUnlock = useRef(status.requireUnlock);
  const manuallyLocked = useRef(isManuallyLocked());
  const lockEpoch = useRef(0);
  const wasEnrolled = useRef(status.enrolled);
  requireUnlock.current = status.requireUnlock;
  useEffect(() => {
    if (wasEnrolled.current && !status.enrolled) {
      setSealed(true);
      setCode('');
      setSetupStep('code');
      setError(
        'This browser is no longer paired. Create a new code on your computer to connect again.',
      );
    }
    wasEnrolled.current = status.enrolled;
  }, [status.enrolled]);
  useEffect(() => {
    // Respond only to a new scan, not later status changes. Never replace a live
    // passkey ceremony or pending confirmation when a browser reuses this tab.
    if (
      !pairingScan?.code ||
      busyRef.current ||
      preparedRef.current ||
      finishUncertain ||
      status.pending ||
      status.enrolled
    )
      return;
    setCode(pairingScan.code);
    setSetupStep('name');
    setError('');
    setDiagnostic('');
  }, [pairingScan]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const lock = () => {
      revision++;
      lockEpoch.current++;
      setSealed(true);
      // Hiding the workspace is immediate. Server lock also terminates existing streams;
      // keepalive is best-effort on suspension, backed by server-side unlock expiry.
      locking.current = fetch('/api/phone/lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
        keepalive: true,
        redirect: 'error',
      })
        .then((response) => {
          if (!response.ok) throw new Error('Lock not confirmed');
        })
        .catch(() => {
          if (active && manuallyLocked.current)
            setError(
              'Your workspace is hidden, but the computer could not confirm the lock. Reconnect and check connection to retry. Until confirmed, the server session may still be active.',
            );
        });
    };
    const manualLock = () => {
      manuallyLocked.current = true;
      try {
        localStorage.setItem(manualLockKey, '1');
      } catch {
        setError(
          'Your workspace is hidden. This browser cannot remember a manual lock after closing. Keep this page open until the computer confirms the lock, or turn off phone access on your computer.',
        );
      }
      lock();
    };
    const hidden = () => {
      // Hide stale private UI even in remembered mode. Only the server's current
      // session can reopen it, but leaving the page need not revoke that session.
      revision++;
      lockEpoch.current++;
      setSealed(true);
      if (requireUnlock.current) lock();
    };
    const recheck = async () => {
      const attempt = ++revision;
      if (manuallyLocked.current) lock();
      await locking.current;
      const value = await refresh();
      if (
        active &&
        attempt === revision &&
        document.visibilityState === 'visible' &&
        !manuallyLocked.current &&
        value?.paired &&
        !value.requireUnlock
      )
        setSealed(false);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') hidden();
      else void recheck();
    };
    const expired = () => {
      revision++;
      setSealed(true);
    };
    const preferences = () => {
      void refresh();
    };
    const shown = () => {
      if (!requireUnlock.current) void recheck();
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== manualLockKey && event.key !== null) return;
      // Clearing storage cannot unlock a live view; only successful verification
      // in this page can retire a manual lock it already observed.
      if (isManuallyLocked()) {
        manuallyLocked.current = true;
        lock();
      }
    };
    if (requireUnlock.current || manuallyLocked.current) lock();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hidden);
    window.addEventListener('pageshow', shown);
    window.addEventListener('dock:lock-phone', manualLock);
    window.addEventListener('storage', storage);
    window.addEventListener('dock:authentication-required', expired);
    window.addEventListener('dock:phone-preferences-changed', preferences);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hidden);
      window.removeEventListener('pageshow', shown);
      window.removeEventListener('dock:lock-phone', manualLock);
      window.removeEventListener('storage', storage);
      window.removeEventListener('dock:authentication-required', expired);
      window.removeEventListener('dock:phone-preferences-changed', preferences);
    };
  }, [refresh]);
  useEffect(() => {
    if (status.enrolled || !status.pending) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [status.enrolled, status.pending?.id, refresh]);
  useEffect(() => {
    if (!status.pending && !status.enrolled) return;
    // A later connection check can resolve a lost finish response. Retire the
    // uncertainty notice once the server confirms the next enrollment stage.
    preparedRef.current = null;
    setPrepared(null);
    setFinishUncertain(false);
    setError('');
    setDiagnostic('');
  }, [status.pending?.id, status.enrolled]);
  useEffect(() => {
    if (sealed || !status.paired) return;
    let active = true;
    // An expired/revoked session closes streams on the server. Refresh the visible lock
    // too, even if no new private request is made. Offline state never grants an unlock.
    const timer = window.setInterval(() => {
      void refresh().then((value) => {
        if (active && !value?.paired) setSealed(true);
      });
    }, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sealed, status.paired, refresh]);
  useEffect(() => {
    if (!prepared) return;
    const timer = window.setTimeout(
      () => {
        preparedRef.current = null;
        setPrepared(null);
        setCode('');
        setSetupStep('code');
        if (!busyRef.current) setError(expiredPreparation);
      },
      Math.max(0, prepared.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [prepared]);
  const act = async (operation: () => Promise<void>, preparing = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setDiagnostic('');
    try {
      await locking.current;
      await operation();
    } catch (e) {
      // Inspect possible success instead of replaying registration or a signed assertion.
      await refresh();
      if (preparing) {
        if (e instanceof Error && codeErrors.has(e.message)) setSetupStep('code');
        setError(
          e instanceof Error && preparationMessages.has(e.message)
            ? e.message
            : 'The code could not be checked. Check connection, then try again. If the code was already accepted, create a new one on your computer.',
        );
      } else {
        if (e instanceof Error && unlockMessages.has(e.message)) setError(e.message);
        else {
          const failure = verificationError(e, true);
          setError(failure.message);
          setDiagnostic(failure.detail);
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const savePasskey = () => {
    const attempt = preparedRef.current;
    if (busyRef.current || !attempt) return;
    if (attempt.expiresAt <= Date.now()) {
      preparedRef.current = null;
      setPrepared(null);
      setCode('');
      setSetupStep('code');
      setError(expiredPreparation);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    setDiagnostic('');
    // Invoke WebAuthn directly in this click handler. In particular, do not await
    // locking.current or a network request before the browser sees the gesture.
    const ceremony = startRegistration({ optionsJSON: attempt.options });
    let finishing = false;
    void ceremony
      .then(async (response) => {
        finishing = true;
        // Once submitted, a credential/challenge must never be replayed, including
        // when the server accepted it but its response was lost.
        preparedRef.current = null;
        setPrepared(null);
        setFinishUncertain(true);
        await api('/phone/enroll/finish', response);
        const value = await refresh();
        if (value?.pending || value?.enrolled) setFinishUncertain(false);
        else setError(uncertainFinish);
      })
      .catch(async (failure: unknown) => {
        if (finishing) {
          const value = await refresh();
          if (value?.pending || value?.enrolled) setFinishUncertain(false);
          else setError(uncertainFinish);
          return;
        }
        const value = verificationError(failure);
        setError(attempt.expiresAt <= Date.now() ? expiredPreparation : value.message);
        setDiagnostic(value.detail);
      })
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  if (status.enrolled && status.paired && !sealed)
    return status.setupComplete ? (
      children
    ) : (
      <PhoneDeviceSetup status={status} refresh={refresh} onboarding />
    );
  return (
    <main className="phone-gate">
      <section className="phone-card">
        {status.enrolled ? (
          <LockKeyhole size={32} aria-hidden="true" />
        ) : (
          <Smartphone size={32} aria-hidden="true" />
        )}
        <h1>
          {status.enrolled
            ? 'Unlock sciencewithagents'
            : status.pending
              ? 'Confirm on your computer'
              : prepared
                ? 'Save a passkey'
                : finishUncertain
                  ? 'Check pairing'
                  : setupStep === 'name'
                    ? 'Name your phone'
                    : 'Enter pairing code'}
        </h1>
        <p>Your agents and history stay on your computer. It needs to be awake and online.</p>
        {(error || connectionError) && (
          <p className="form-error" role="alert">
            {error || connectionError}
          </p>
        )}
        {diagnostic && (
          <details>
            <summary>Verification detail</summary>
            <p style={{ overflowWrap: 'anywhere' }}>{diagnostic}</p>
          </details>
        )}
        {status.enrolled ? (
          <>
            <p>
              This phone is paired with no scheduled expiry. Use your phone’s Face ID, fingerprint
              or screen-lock verification to open your workspace.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const epoch = lockEpoch.current;
                  const options = (await api(
                    '/phone/unlock/options',
                    {},
                  )) as PublicKeyCredentialRequestOptionsJSON;
                  const result = await startAuthentication({ optionsJSON: options });
                  await api('/phone/unlock', result);
                  const value = await refresh();
                  if (
                    value?.paired &&
                    document.visibilityState === 'visible' &&
                    epoch === lockEpoch.current
                  ) {
                    manuallyLocked.current = false;
                    try {
                      localStorage.removeItem(manualLockKey);
                    } catch {
                      /* No authority in storage. */
                    }
                    setSealed(false);
                  }
                })
              }
            >
              {busy ? 'Unlocking…' : 'Unlock sciencewithagents'}
            </button>
            <p className="muted">
              Locking or closing the app does not unpair this phone. No GitHub or Cloudflare sign-in
              is needed. After unlocking, you can choose Stay signed in in Phone access to stop
              routine verification prompts.
            </p>
          </>
        ) : status.pending ? (
          <>
            <p>
              In Phone access on your computer, confirm that this number matches before approving:
            </p>
            <div className="phone-code">
              <strong>{status.pending.confirmation}</strong>
            </div>
            <p role="status">Waiting for your computer’s confirmation…</p>
            <p className="muted">No projects, conversations or terminals are accessible yet.</p>
          </>
        ) : prepared ? (
          <>
            <p>Your code was accepted. Tap Save passkey, then follow your phone’s prompt.</p>
            <button className="primary" disabled={busy} onClick={savePasskey}>
              {busy ? 'Saving passkey…' : 'Save passkey'}
            </button>
            <p className="muted">
              You can retry here without entering or creating another code while this attempt is
              still valid. Keep this page open. Your phone may close its prompt sooner; that does
              not necessarily mean the code expired.
            </p>
            <p className="muted">After saving, confirm the matching number on your computer.</p>
          </>
        ) : finishUncertain ? (
          <>
            <p>{uncertainFinish}</p>
            <p>
              If no confirmation appears after checking the connection, create a new code on your
              computer to start a new attempt.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setFinishUncertain(false);
                setCode('');
                setSetupStep('code');
                setError('');
                setDiagnostic('');
              }}
            >
              Enter a new code
            </button>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busyRef.current) return;
              if (setupStep === 'code') {
                if (!code.trim()) {
                  setError('Enter the pairing code from your computer.');
                  return;
                }
                setError('');
                setDiagnostic('');
                setSetupStep('name');
                return;
              }
              if (!name.trim()) {
                setError('Enter a nickname for this phone.');
                return;
              }
              void act(async () => {
                if (!window.PublicKeyCredential) throw new Error(unsupportedPasskeys);
                const requestedAt = Date.now();
                const options = (await api('/phone/enroll/options', {
                  code,
                  name,
                })) as PublicKeyCredentialCreationOptionsJSON;
                setCode('');
                // Only this document retains preparation. Reload never retries a
                // credential or silently starts a new enrollment.
                const remaining =
                  typeof options.timeout === 'number' && Number.isFinite(options.timeout)
                    ? Math.max(0, Math.min(options.timeout, 15 * 60_000))
                    : 60_000;
                const next = { options, expiresAt: requestedAt + remaining };
                if (next.expiresAt <= Date.now()) throw new Error(expiredPreparation);
                preparedRef.current = next;
                setPrepared(next);
              }, true);
            }}
          >
            {setupStep === 'code' ? (
              <>
                <p>
                  Enter the code shown in <strong>Phone access</strong> on your computer, or scan
                  its QR to skip this step.
                </p>
                <label>
                  Connection code
                  <input
                    key="pairing-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    maxLength={64}
                    required
                    disabled={busy}
                    autoFocus
                  />
                </label>
              </>
            ) : (
              <>
                <p>Choose a nickname so you can recognize this phone on your computer.</p>
                <label>
                  Phone nickname
                  <input
                    key="phone-nickname"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. My iPhone"
                    autoComplete="off"
                    maxLength={80}
                    required
                    disabled={busy}
                    autoFocus
                  />
                </label>
              </>
            )}
            <button className="primary" disabled={busy}>
              {busy ? 'Checking code…' : 'Continue'}
            </button>
            {setupStep === 'name' && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setSetupStep('code');
                  setError('');
                  setDiagnostic('');
                }}
              >
                Use a different code
              </button>
            )}
            <p className="muted">
              Your phone will offer to save a passkey. After confirmation, pairing closes to new
              devices.
            </p>
          </form>
        )}
        <div className="phone-actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (manuallyLocked.current) window.dispatchEvent(new Event('dock:lock-phone'));
              void refresh();
            }}
          >
            Check connection
          </button>
        </div>
        <p className="muted">
          {status.enrolled
            ? 'Pairing is complete. To add the app, use Safari → Share → Add to Home Screen, or Chrome → Install app.'
            : 'Finish pairing in this browser first. After computer confirmation, add this page to your home screen: Safari → Share → Add to Home Screen; Chrome → Install app.'}{' '}
          An icon added before pairing may need to be added again from this paired browser. Clearing
          app/browser data may require pairing again.
        </p>
      </section>
    </main>
  );
}
