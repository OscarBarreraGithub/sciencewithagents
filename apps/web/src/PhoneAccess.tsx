import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Smartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { phoneCodeSchema, phoneStatusSchema, type PhoneStatus } from '@dock/shared';
import { api, ApiError } from './api';
import { Modal } from './Modal';
import { PairedPhoneGate } from './PairedPhoneGate';
import { pairingLink, readPairingCode } from './pairing-link';
import { HomeScreenGuide, PhoneDeviceSetup } from './PhoneDeviceSetup';
import { PhoneConnectionSetup } from './PhoneConnectionSetup';

const PhoneMode = createContext<'local' | 'remote'>('local');
export const usePhoneMode = () => useContext(PhoneMode);
const PhoneLockAvailable = createContext(false);
export const usePhoneLockAvailable = () => useContext(PhoneLockAvailable);
const readStatus = async () => phoneStatusSchema.parse(await api('/phone/status'));

/** No private workspace is mounted on a remote device before enrollment succeeds. */
export function PhoneGate({
  children,
  initialPairingCode = '',
}: {
  children: ReactNode;
  initialPairingCode?: string;
}) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [localConnection, setLocalConnection] = useState<{ url: string | null } | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState(initialPairingCode);
  const [pairingScan, setPairingScan] = useState({ code: initialPairingCode });
  const [setupStep, setSetupStep] = useState<'code' | 'name'>(initialPairingCode ? 'name' : 'code');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    // A phone browser may reuse an existing tab for a scanned fragment-only URL.
    const scanned = () => {
      const value = readPairingCode();
      if (!value || busyRef.current) return;
      setPairingScan({ code: value });
      setCode(value);
      setSetupStep('name');
      setError('');
    };
    window.addEventListener('hashchange', scanned);
    return () => window.removeEventListener('hashchange', scanned);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const value = await readStatus();
      setStatus(value);
      setLocalConnection(null);
      setError('');
      return value;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'LOCAL_UNLOCK_REQUIRED') {
        setStatus(null);
        let url: string | null = null;
        try {
          const target = new URL(e.reconnectUrl ?? '');
          if (
            target.protocol === 'http:' &&
            /^swa-[a-f0-9]{24}\.localhost$/.test(target.hostname) &&
            target.port === location.port &&
            !target.username &&
            !target.password &&
            !target.hash &&
            target.pathname === '/local-access/restore' &&
            [...target.searchParams.keys()].every((key) => ['recover', 'source'].includes(key))
          ) {
            const route = location.hash.startsWith('#/')
              ? location.hash
              : new URLSearchParams(location.search).has('mirror')
                ? '#/vscode'
                : '';
            target.hash = route;
            url = target.href;
          }
        } catch {
          /* Invalid targets never become navigation links. */
        }
        setLocalConnection({ url });
        if (url) location.replace(url);
      }
      setError(e instanceof Error ? e.message : 'Could not connect.');
      return null;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const recheck = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const expired = () => {
      setStatus((value) => (value?.mode === 'remote' ? { ...value, paired: false } : value));
      void refresh();
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('dock:authentication-required', expired);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('dock:authentication-required', expired);
    };
  }, [refresh]);
  if (localConnection)
    return (
      <main className="phone-gate">
        <section className="phone-card">
          <Smartphone size={32} aria-hidden="true" />
          <h1>Open your workspace</h1>
          <p>Open the installed sciencewithagents app on this computer to connect your browser.</p>
          <p>
            Your saved drafts stay in this tab. Reconnect it after opening the app; pending messages
            will not be resent.
          </p>
          <div className="phone-actions">
            <a href="sciencewithagents://open">Open desktop app</a>
            {localConnection.url && <a href={localConnection.url}>Reconnect this tab</a>}
            <button className="secondary" onClick={() => void refresh()}>
              Check connection
            </button>
          </div>
          <p className="muted">
            If the button does not open the app, open sciencewithagents from Applications, then
            return here.
          </p>
        </section>
      </main>
    );
  if (status?.mode === 'remote' && status.authentication === 'paired')
    return (
      <PhoneMode.Provider value="remote">
        <PhoneLockAvailable.Provider value={true}>
          <PairedPhoneGate
            status={status}
            refresh={refresh}
            connectionError={error}
            pairingScan={pairingScan}
          >
            {children}
          </PairedPhoneGate>
        </PhoneLockAvailable.Provider>
      </PhoneMode.Provider>
    );
  if (status && (status.mode === 'local' || status.paired))
    return <PhoneMode.Provider value={status.mode}>{children}</PhoneMode.Provider>;
  return (
    <main className="phone-gate">
      <section className="phone-card">
        <Smartphone size={32} aria-hidden="true" />
        <h1>
          {!status
            ? 'Connect to sciencewithagents'
            : setupStep === 'name'
              ? 'Name your phone'
              : 'Enter pairing code'}
        </h1>
        <p>Your agents and history stay on your computer. It needs to be awake and online.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {status && (
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
                setSetupStep('name');
                return;
              }
              if (!name.trim()) {
                setError('Enter a nickname for this phone.');
                return;
              }
              busyRef.current = true;
              setBusy(true);
              setError('');
              void (async () => {
                try {
                  await api('/phone/pair', { code, name });
                  setCode('');
                  await refresh();
                } catch (e) {
                  // A response may have been lost after the cookie was set. Inspect; never replay pairing.
                  const value = await refresh();
                  if (!value?.paired) {
                    setSetupStep('code');
                    setError(e instanceof Error ? e.message : 'Could not connect this device.');
                  }
                } finally {
                  busyRef.current = false;
                  setBusy(false);
                }
              })();
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
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
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
              {setupStep === 'code' ? 'Continue' : busy ? 'Connecting…' : 'Connect this device'}
            </button>
            {setupStep === 'name' && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setSetupStep('code');
                  setError('');
                }}
              >
                Use a different code
              </button>
            )}
          </form>
        )}
        <div className="phone-actions">
          <button className="secondary" onClick={() => void refresh()}>
            Check connection
          </button>
          <a href="/">Sign in again</a>
        </div>
        <p className="muted">
          After connecting, add this page to your home screen. If the installed app asks again, pair
          it there too.
        </p>
      </section>
    </main>
  );
}

export function PhoneSettings({
  close,
  embedded = false,
}: {
  close: () => void;
  embedded?: boolean;
}) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [code, setCode] = useState<ReturnType<typeof phoneCodeSchema.parse> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirmation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(
      () => setCode(null),
      Math.max(0, Date.parse(code.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [code]);
  useEffect(() => {
    if (status?.pending) confirmation.current?.scrollIntoView({ block: 'nearest' });
  }, [status?.pending?.id]);
  useEffect(() => {
    void readStatus()
      .then(setStatus)
      .catch((e) => setError(String(e.message)));
  }, []);
  useEffect(() => {
    if (status?.mode !== 'local' || !status.configured) return;
    let active = true;
    const timer = window.setInterval(() => {
      void readStatus()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [status?.mode, status?.configured]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      setStatus(await readStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const showPairing = !!(
    status?.enabled &&
    ['external', 'connected'].includes(status.connection) &&
    code &&
    Date.parse(code.expiresAt) > Date.now() &&
    !status.enrollmentInProgress &&
    !status.pending &&
    (status.authentication !== 'paired' || status.enrollmentOpen)
  );
  return (
    <Modal embedded={embedded} title="Phone access" close={close}>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!status ? (
        <>
          <p>Checking your connection setup…</p>
          {error && (
            <button className="secondary" disabled={busy} onClick={() => void act(async () => {})}>
              Try connection again
            </button>
          )}
        </>
      ) : status.mode === 'remote' ? (
        <>
          <p>
            This device is connected to your computer. Your agents keep working when you close this
            app.
          </p>
          <p>
            Manage connected devices and create connection codes from sciencewithagents on your
            computer.
          </p>
          {status.authentication === 'paired' && (
            <button
              className="secondary"
              onClick={() => window.dispatchEvent(new Event('dock:lock-phone'))}
            >
              Lock app
            </button>
          )}
          {status.authentication === 'paired' ? (
            <PhoneDeviceSetup
              status={status}
              refresh={async () => {
                setStatus(await readStatus());
              }}
            />
          ) : (
            <>
              <h3>Add to your home screen</h3>
              <HomeScreenGuide />
            </>
          )}
        </>
      ) : status.setupIssue ? (
        <>
          <p role="alert" className="form-error">
            {status.setupIssue === 'configuration'
              ? 'Phone settings need repair.'
              : 'The phone connection could not start on this computer.'}
          </p>
          <p>
            Your desktop is ready to use. Saved phone pairing is retained; phone access is closed
            until setup is repaired.
          </p>
          <p>
            {status.setupIssue === 'listener'
              ? 'Try the connection again. If it still cannot start, your setup agent can help while you keep using the desktop.'
              : 'Ask your setup agent to repair the connection, then reopen the app. Restoring the original settings keeps your existing pairing.'}
          </p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (status.setupIssue === 'listener') await api('/phone/reconnect', {});
              })
            }
          >
            {status.setupIssue === 'listener' ? 'Retry connection' : 'Check phone setup'}
          </button>
        </>
      ) : !status.configured ? (
        <PhoneConnectionSetup connected={async () => setStatus(await readStatus())} />
      ) : (
        <>
          {status.transport === 'tailscale' && (
            <p>
              Keep Tailscale connected on this computer and your phone. This address is private to
              your Tailscale network; your phone still needs its passkey.
            </p>
          )}
          <p>
            {status.enabled ? 'Phone access is on.' : 'Phone access is off.'} Your computer must
            stay awake and online.
          </p>
          {status.enabled && status.connection === 'connecting' && (
            <p role="status">Connecting your phone address… This can take a moment.</p>
          )}
          {status.enabled && status.connection === 'connected' && (
            <p role="status">Your phone connection is ready.</p>
          )}
          {status.enabled && status.connection === 'error' && (
            <>
              <p role="alert">
                The phone connection stopped. Check this computer’s internet connection and try
                again. Your agents and history are safe.
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api('/phone/reconnect', {});
                  })
                }
              >
                Reconnect phone access
              </button>
            </>
          )}
          {!status.enabled ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api('/phone/enabled', { enabled: true });
                })
              }
            >
              Turn on phone access
            </button>
          ) : (
            <>
              {status.authentication === 'paired' && (
                <>
                  <p role="status">
                    {status.pending
                      ? 'Your phone is waiting for confirmation.'
                      : status.enrollmentInProgress
                        ? 'Continue pairing on your phone.'
                        : status.enrollmentOpen
                          ? 'Pairing is open for one phone.'
                          : 'Pairing is closed to new devices.'}
                  </p>
                  {status.enrollmentInProgress && (
                    <p>
                      Finish saving the passkey on your phone, then confirm it here. If your phone
                      asks you to start again, choose Cancel pairing here first.
                    </p>
                  )}
                  {status.pending && (
                    <section className="phone-code" ref={confirmation}>
                      <p>
                        Confirm <strong>{status.pending.name}</strong> only if this number matches
                        your phone:
                      </p>
                      <strong>{status.pending.confirmation}</strong>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api('/phone/confirm', {
                              id: status.pending!.id,
                              confirmation: status.pending!.confirmation,
                            });
                            setCode(null);
                          })
                        }
                      >
                        Confirm this phone
                      </button>
                    </section>
                  )}
                  {(status.enrollmentOpen || status.enrollmentInProgress || status.pending) && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api('/phone/enrollment/close', {});
                          setCode(null);
                        })
                      }
                    >
                      Cancel pairing
                    </button>
                  )}
                </>
              )}
              {!status.pending && !status.enrollmentInProgress && !showPairing && (
                <p>
                  To pair a phone, choose <strong>Create a new code</strong>. The QR code and
                  instructions will appear here.
                </p>
              )}
              {!status.pending && !status.enrollmentInProgress && (
                <button
                  className="primary"
                  disabled={busy || !['external', 'connected'].includes(status.connection)}
                  onClick={() =>
                    void act(async () => {
                      // The server may replace the old code even if its response is lost.
                      setCode(null);
                      setCode(
                        phoneCodeSchema.parse(
                          await api('/phone/code', { key: crypto.randomUUID() }),
                        ),
                      );
                    })
                  }
                >
                  Create a new code
                </button>
              )}
              {showPairing && code && (
                <>
                  <p>
                    {status.authentication === 'paired'
                      ? 'Scan this QR with your phone’s camera, then give your phone a nickname. Continue in Safari or Chrome, save the passkey, then confirm the matching number here. Add to Home Screen after pairing.'
                      : 'Scan this QR on your phone and sign in, then give your phone a nickname.'}
                  </p>
                  <div className="phone-qr">
                    <a
                      href={pairingLink(status.origin!, code.code)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open phone pairing"
                    >
                      <QRCodeSVG
                        value={pairingLink(status.origin!, code.code)}
                        size={180}
                        marginSize={4}
                        title="Scan to fill your phone’s connection code"
                      />
                    </a>
                  </div>
                  <p className="phone-address">
                    Or open{' '}
                    <a href={status.origin!} target="_blank" rel="noreferrer">
                      {status.origin}
                    </a>{' '}
                    in your phone’s browser and type the code below. Scanning the QR code is
                    optional.
                  </p>
                  <div className="phone-code" aria-live="polite">
                    <strong>{code.code}</strong>
                    <small>
                      One use · 15 minutes to finish pairing · expires at{' '}
                      {new Date(code.expiresAt).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </small>
                  </div>
                  <p className="muted">
                    Scanning skips code entry; typing is only a fallback. This is a one-time
                    connection code, not a password to remember. Keep this QR and code private.{' '}
                    {status.authentication === 'paired'
                      ? 'Your phone still needs your confirmation on this computer.'
                      : 'Choose Connect this device on your phone to finish.'}
                  </p>
                </>
              )}
              <h3>Connected devices</h3>
              {!status.devices.some(
                (device) =>
                  !device.revokedAt &&
                  (!device.expiresAt || Date.parse(device.expiresAt) > Date.now()),
              ) && <p className="muted">No connected devices yet.</p>}
              <ul className="phone-devices">
                {status.devices
                  .filter(
                    (device) =>
                      !device.revokedAt &&
                      (!device.expiresAt || Date.parse(device.expiresAt) > Date.now()),
                  )
                  .map((device) => (
                    <li key={device.id}>
                      <span>{device.name}</span>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`/phone/devices/${device.id}/revoke`, {});
                          })
                        }
                      >
                        {status.authentication === 'paired' ? 'Remove device' : 'Disconnect'}
                      </button>
                    </li>
                  ))}
              </ul>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api('/phone/enabled', { enabled: false });
                    setCode(null);
                  })
                }
              >
                Turn off phone access
              </button>
              <p className="muted">
                {status.authentication === 'paired'
                  ? 'Turning this off pauses access and locks every phone, but keeps their pairing. Only Remove device forgets a phone.'
                  : 'Turning this off disconnects every device and invalidates their codes and access. Your agents and history are kept.'}
              </p>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
