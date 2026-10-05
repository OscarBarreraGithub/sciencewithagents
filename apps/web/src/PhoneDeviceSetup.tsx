import { useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { phoneStatusSchema } from '@dock/shared';
import { api } from './api';

export function HomeScreenGuide() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return (
    <section className="phone-install-guide" aria-label="Home Screen instructions">
      {standalone && <p role="status">You’re already using the app shortcut.</p>}
      <p>Pair in your browser first, then add this paired page. No App Store download is needed.</p>
      <details>
        <summary>On a laptop or desktop</summary>
        <p>
          This shortcut opens the connected computer’s app. Jobs run on that computer, not on this
          laptop. You do not need to install the sciencewithagents server here.
        </p>
        <h3>Mac · Safari</h3>
        <ol>
          <li>Open this paired page in Safari.</li>
          <li>
            Choose <strong>Share → Add to Dock</strong>, then <strong>Add</strong>.
          </li>
          <li>Open sciencewithagents from your Dock or Applications folder.</li>
        </ol>
        <h3>Mac, Windows or Linux · Chrome</h3>
        <ol>
          <li>Open this paired page in Chrome.</li>
          <li>
            Choose <strong>⋮ → Cast, save and share → Install page as app</strong>, then{' '}
            <strong>Install</strong>.
          </li>
        </ol>
        <p>You can also bookmark this address and keep using the browser.</p>
      </details>
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

/** Installation help after secure pairing; completion does not grant access. */
export function PhoneDeviceSetup({
  refresh,
  onboarding = false,
}: {
  refresh: () => Promise<unknown>;
  onboarding?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!onboarding) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
  }, [onboarding]);
  const complete = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      phoneStatusSchema.parse(await api('/phone/setup/complete', { setupComplete: true }));
      await refresh();
    } catch {
      await refresh().catch(() => {});
      setError('We could not confirm setup finished. Check your connection and try again.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const content = (
    <>
      {onboarding ? (
        <>
          <Smartphone size={32} aria-hidden="true" />
          <h1 ref={heading} tabIndex={-1}>
            Add sciencewithagents to your device
          </h1>
        </>
      ) : (
        <h3>Add sciencewithagents to your device</h3>
      )}
      <p>Your device is paired. It stays connected when you close and reopen the app.</p>
      <HomeScreenGuide />
      {onboarding && (
        <>
          <p>You can open your workspace now, whether you added an icon or prefer the browser.</p>
          <button className="primary" disabled={busy} onClick={() => void complete()}>
            {busy ? 'Saving…' : 'Open my workspace'}
          </button>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        Remove this device from Phone access on your computer to revoke its connection. Losing
        browser data can require pairing again.
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
