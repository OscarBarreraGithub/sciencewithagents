import { useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { phoneStatusSchema, type PhoneStatus } from '@dock/shared';
import { api } from './api';

export function HomeScreenGuide() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return (
    <section className="phone-install-guide" aria-label="Home Screen instructions">
      {standalone && <p role="status">You’re already using the Home Screen app.</p>}
      <p>Pair in your browser first, then add this paired page. No App Store download is needed.</p>
      <h3>iPhone or iPad · Safari</h3>
      <ol>
        <li>Tap Share (the square with an upward arrow). It may be inside the More menu.</li>
        <li>
          Scroll down and choose <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Keep <strong>Open as Web App</strong> on if shown, then tap <strong>Add</strong>.
        </li>
        <li>Open the new sciencewithagents icon from your Home Screen.</li>
      </ol>
      <h3>Android · Chrome</h3>
      <ol>
        <li>Tap the three-dot menu beside the address bar.</li>
        <li>
          Choose <strong>Install and create shortcut → Install</strong>,{' '}
          <strong>Install app</strong>, or <strong>Add to Home screen</strong>, depending on your
          version.
        </li>
        <li>Follow the prompt, then open the new sciencewithagents icon.</li>
      </ol>
      <p className="muted">
        You can also keep using this browser. Your computer must stay awake, online and running
        sciencewithagents.
      </p>
      <details>
        <summary>Still seeing the old app icon?</summary>
        <p>
          Open this address in Safari or Chrome and reload it, then add it to your Home Screen
          again. The icon should show the little drawn alien. Open the new shortcut and check that
          it connects before removing the old one. Keep your browser data and passkey.
        </p>
      </details>
      <details>
        <summary>Already added an icon, or the icon asks to pair again?</summary>
        <p>
          An icon added before pairing does not automatically inherit later Safari sign-in. Return
          to this paired browser and add a new icon. If your phone does not transfer the connection,
          keep using this browser or pair the Home Screen app from your computer. Do not clear this
          browser’s data.
        </p>
      </details>
    </section>
  );
}

function LockChoice({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="phone-lock-choice" disabled={disabled}>
      <legend>App lock</legend>
      <label>
        <input type="radio" name="phone-lock" checked={value} onChange={() => onChange(true)} />
        <span>
          Ask for Face ID or screen lock
          <small>
            Use your phone’s verification when reopening, returning to the app, or after 15 minutes.
            Recommended on shared devices.
          </small>
        </span>
      </label>
      <label>
        <input type="radio" name="phone-lock" checked={!value} onChange={() => onChange(false)} />
        <span>
          Stay signed in
          <small>
            No routine Face ID prompt. Anyone using your unlocked phone or browser can access your
            agents and projects.
          </small>
        </span>
      </label>
    </fieldset>
  );
}

/** Server-owned preference; neither local storage nor the install UI grants access. */
export function PhoneDeviceSetup({
  status,
  refresh,
  onboarding = false,
}: {
  status: PhoneStatus;
  refresh: () => Promise<unknown>;
  onboarding?: boolean;
}) {
  const [requireUnlock, setRequireUnlock] = useState(status.requireUnlock);
  const [step, setStep] = useState<'lock' | 'install'>('lock');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!onboarding) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [onboarding, step]);
  const save = async (complete = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const next = phoneStatusSchema.parse(
        await api('/phone/preferences', {
          requireUnlock,
          ...(complete ? { setupComplete: true } : {}),
        }),
      );
      setRequireUnlock(next.requireUnlock);
      window.dispatchEvent(new Event('dock:phone-preferences-changed'));
      await refresh();
      if (onboarding && !complete) setStep('install');
      else setSaved(true);
    } catch {
      // The reply may have been lost after saving. Reconcile server status; never
      // silently repeat a security change or claim an install actually happened.
      await refresh().catch(() => {});
      setError(
        'We could not confirm the change. Check your connection and try saving again. If the app locks, unlock it first.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const content = (
    <>
      {onboarding && (
        <>
          <Smartphone size={32} aria-hidden="true" />
          <p className="muted">Phone setup · {step === 'lock' ? '1' : '2'} of 2</p>
          <h1 ref={heading} tabIndex={-1}>
            {step === 'lock'
              ? 'Make this phone yours'
              : 'Add sciencewithagents to your Home Screen'}
          </h1>
        </>
      )}
      {(!onboarding || step === 'lock') && (
        <>
          <p>Your phone is paired with no scheduled expiry. Choose how you want to open the app.</p>
          <LockChoice
            value={requireUnlock}
            disabled={busy}
            onChange={(value) => {
              setRequireUnlock(value);
              setSaved(false);
            }}
          />
          <p className="muted">
            Your saved passkey stays available. Lock app or turning phone access off requires
            verification next time, even with Stay signed in. You can change this choice in Phone
            access.
          </p>
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : onboarding ? 'Continue' : 'Save lock preference'}
          </button>
        </>
      )}
      {(!onboarding || step === 'install') && (
        <>
          {!onboarding && <h3>Add sciencewithagents to your Home Screen</h3>}
          <HomeScreenGuide />
          {onboarding && (
            <>
              <p>
                You can open your workspace now, whether you added an icon or prefer the browser.
              </p>
              <button className="primary" disabled={busy} onClick={() => void save(true)}>
                {busy ? 'Saving…' : 'Open my workspace'}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setStep('lock')}>
                Back to app lock
              </button>
            </>
          )}
        </>
      )}
      {saved && <p role="status">Lock preference saved for this paired device.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        Closing the app, restarting your computer, or an expired unlock does not unpair this phone.
        Removing the device or losing browser data can require pairing again.
      </p>
    </>
  );
  return onboarding ? (
    <main className="phone-gate">
      <section className="phone-card">{content}</section>
    </main>
  ) : (
    content
  );
}
