import { useEffect, useState } from 'react';
import { notificationStatusSchema, type NotificationStatus } from '@dock/shared';
import { api, apiScope } from './api';
import './notification-settings.css';

const workerUrl = '/notifications-sw.js';
type Support = 'supported' | 'home-screen' | 'unsupported' | 'insecure';

function support(): Support {
  const ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!window.isSecureContext) return 'insecure';
  // iOS and iPadOS 16.4+ deliver web push only to apps opened from the Home Screen.
  if (ios && !standalone) return 'home-screen';
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    ? 'supported'
    : 'unsupported';
}
const keyBytes = (value: string) => {
  const raw = atob(
    value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '='),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};
async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration('/');
  return (await registration?.pushManager.getSubscription()) ?? null;
}
const deviceLabel = () =>
  /iPhone/.test(navigator.userAgent)
    ? 'iPhone'
    : /iPad/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(navigator.userAgent)
        ? 'Android phone'
        : 'Computer browser';

export function NotificationSettings() {
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [deviceOn, setDeviceOn] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unavailable'>(
    'Notification' in window ? Notification.permission : 'unavailable',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const supported = support();
  const refresh = async () => {
    setStatus(notificationStatusSchema.parse(await api('/notifications')));
    if (supported === 'supported') setDeviceOn(!!(await currentSubscription()));
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const act = async (action: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const done = await action();
      if (done) setMessage(done);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  const enable = () => {
    // Ask from this click only; iOS refuses permission prompts outside a user gesture.
    const asked = Notification.requestPermission();
    void act(async () => {
      const result = await asked;
      setPermission(result);
      if (result !== 'granted') return;
      await navigator.serviceWorker.register(workerUrl, { scope: '/' });
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(status!.publicKey!),
        }));
      await api('/notifications/subscribe', { ...subscription.toJSON(), label: deviceLabel() });
      return 'Notifications are on for this device.';
    });
  };
  const disable = () =>
    act(async () => {
      const subscription = await currentSubscription();
      if (subscription) {
        await api('/notifications/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      return 'Notifications are off for this device.';
    });
  const otherComputer = apiScope() !== 'local';
  const mine = status?.subscriptions.some((item) => item.mine) ?? false;
  return (
    <section className="phone-settings-panel notification-settings" aria-label="Notifications">
      <h3>Notifications</h3>
      <p>
        Get a phone or browser notification when a project you choose stops and needs you: an
        approval, a decision, or work that stopped. Notifications name the project and the kind of
        stop only. Details stay in the app.
      </p>
      <p className="notification-settings-note">
        At most one per project every 10 minutes. Quick fixes by a manager, routine retries and
        normal usage waits do not notify you.
      </p>
      {otherComputer && (
        <p className="notification-settings-note" role="note">
          Notifications come from the computer this browser connects to. Projects on the selected
          computer are not included.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!status ? (
        <p>Checking notifications…</p>
      ) : !status.available ? (
        <p>Notifications are not available on this computer entry.</p>
      ) : (
        <>
          <h4>This device</h4>
          {supported === 'home-screen' ? (
            <p>
              Add sciencewithagents to your Home Screen, open it from there, then return here.
              iPhone and iPad need iOS 16.4 or later.
            </p>
          ) : supported === 'insecure' ? (
            <p>Open the app from its secure address to use notifications.</p>
          ) : supported === 'unsupported' ? (
            <p>This browser cannot receive notifications from this app.</p>
          ) : permission === 'denied' ? (
            <p role="alert">
              Notifications are blocked for this app. Allow them in your browser or device settings,
              then return here.
            </p>
          ) : deviceOn && mine ? (
            <div className="notification-settings-actions">
              <p>On for this device.</p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api('/notifications/test', {});
                    return 'Test sent. It can take a moment to arrive.';
                  })
                }
              >
                Send a test
              </button>
              <button className="secondary" disabled={busy} onClick={() => void disable()}>
                Turn off on this device
              </button>
            </div>
          ) : (
            <button disabled={busy} onClick={enable}>
              Turn on notifications on this device
            </button>
          )}
          <h4>What notifies you</h4>
          <label className="notification-toggle">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                void act(async () => {
                  await api('/notifications/enabled', { enabled });
                });
              }}
            />
            Send notifications from this computer
          </label>
          {status.projects.length === 0 ? (
            <p>No projects yet.</p>
          ) : (
            <ul className="notification-projects" aria-label="Projects that can notify you">
              {status.projects.map((project) => (
                <li key={project.id}>
                  <label className="notification-toggle">
                    <input
                      type="checkbox"
                      checked={project.enabled}
                      disabled={busy || !status.enabled}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        void act(async () => {
                          await api('/notifications/project', { projectId: project.id, enabled });
                        });
                      }}
                    />
                    {project.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {status.subscriptions.length + status.otherSubscriptions > 0 && (
            <>
              <h4>Devices receiving notifications</h4>
              <ul className="notification-devices">
                {status.subscriptions.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.label}
                      {item.mine ? ' (this sign-in)' : ''}
                      {item.lastFailureAt && !item.lastSuccessAt ? ' · not delivered yet' : ''}
                    </span>
                    {!item.mine && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api('/notifications/remove', { id: item.id });
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
                {status.otherSubscriptions > 0 && (
                  <li>
                    {status.otherSubscriptions} other device
                    {status.otherSubscriptions === 1 ? '' : 's'}. Manage them on this computer.
                  </li>
                )}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
