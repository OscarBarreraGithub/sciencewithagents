import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Smartphone } from 'lucide-react';
import { Button } from '../ui/Button';
import {
  groupPhoneHostRequestSchema,
  groupPhoneHostViewSchema,
  type GroupPhoneHostRequest,
  type GroupPhoneHostView,
} from '@dock/shared/dist/group-phone-host.js';
import { api, apiScope } from '../api';
import './group-phone-panel.css';

export function GroupPhonePanel({
  handle,
  request,
}: {
  handle: string;
  request?: (input: GroupPhoneHostRequest) => Promise<unknown>;
}) {
  const [view, setView] = useState<GroupPhoneHostView | null>(null);
  const [label, setLabel] = useState('My phone');
  const [allowPost, setAllowPost] = useState(false);
  const [pending, setPending] = useState<GroupPhoneHostRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0),
    inFlight = useRef(false);
  const storageKey = `swa:${apiScope()}:group-phone:${handle}`;
  async function control(input: GroupPhoneHostRequest) {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setBusy(true);
    if (input.action !== 'status') setMessage('');
    try {
      if (input.action !== 'status') {
        localStorage.setItem(storageKey, JSON.stringify(input));
        setPending(input);
      }
      const result = groupPhoneHostViewSchema.parse(
        await (request ? request(input) : api('/groups/phone', input)),
      );
      if (generation.current !== current) return;
      setView((previous) =>
        input.action === 'status' && previous?.link
          ? { ...result, link: previous.link, expiresAt: previous.expiresAt }
          : result,
      );
      if (input.action !== 'status') {
        localStorage.removeItem(storageKey);
        setPending(null);
        setMessage(
          input.action === 'pair'
            ? 'Open this one-use link on your phone within 10 minutes.'
            : 'Phone connection revoked.',
        );
      }
    } catch (error) {
      if (generation.current === current)
        setMessage(error instanceof Error ? error.message : 'Phone connections are unavailable.');
    } finally {
      if (generation.current === current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    generation.current++;
    inFlight.current = false;
    setView(null);
    setBusy(false);
    setMessage('');
    setAllowPost(false);
    setUnreadable(false);
    let saved: GroupPhoneHostRequest | null = null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        if (raw.length >= 4096) throw new Error('Saved request is too large');
        const input = groupPhoneHostRequestSchema.parse(JSON.parse(raw));
        if (input.action === 'status' || input.handle !== handle)
          throw new Error('Saved request does not match this group');
        saved = input;
      }
    } catch {
      setUnreadable(true);
      setMessage(
        'A saved phone request could not be read. No request was sent. Stop retrying it before creating another request.',
      );
    }
    setPending(saved);
    void control({ action: 'status', handle });
    return () => {
      generation.current++;
    };
    // The selected saved group defines this request lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, storageKey]);
  return (
    <section className="group-phone-panel" aria-label="Phone access">
      <h3>
        <Smartphone size={22} aria-hidden="true" />
        Read this group on your phone
      </h3>
      <p>
        Connect directly to the hosted group, even while your computer is closed. Reading and
        sending human messages use no model.
      </p>
      <label>
        Phone name
        <input
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy || !!pending || unreadable}
        />
      </label>
      <label className="group-phone-check">
        <input
          type="checkbox"
          checked={allowPost}
          onChange={(e) => setAllowPost(e.target.checked)}
          disabled={busy || !!pending || unreadable}
        />
        Allow this phone to send human messages
      </label>
      <p>
        Read-only is the default. This permission does not start Claude, run commands, or approve
        files, and is independent of automatic sharing being paused. Revoke the connection below to
        stop phone access.
      </p>
      <div className="group-phone-controls">
        <Button
          type="button"
          variant="primary"
          isDisabled={busy || !!pending || unreadable || !label.trim()}
          onPress={() =>
            void control({
              action: 'pair',
              handle,
              key: crypto.randomUUID(),
              label: label.trim(),
              allowPost,
            })
          }
        >
          Connect a phone
        </Button>
        <Button
          type="button"
          isDisabled={busy}
          onPress={() => void control({ action: 'status', handle })}
        >
          Refresh connections
        </Button>
      </div>
      {(pending || unreadable) && (
        <div className="group-phone-saved">
          <p>A phone request is saved. Check it using the same request before making another.</p>
          {pending && (
            <Button type="button" isDisabled={busy} onPress={() => void control(pending)}>
              Check saved phone request
            </Button>
          )}
          <Button
            type="button"
            isDisabled={busy}
            onPress={() => {
              try {
                localStorage.removeItem(storageKey);
                setPending(null);
                setUnreadable(false);
                setMessage(
                  'Stopped further retries. A link already created expires after 10 minutes; an accepted revocation remains in effect.',
                );
              } catch {
                setMessage('The saved request could not be removed from this browser.');
              }
            }}
          >
            Stop retrying request
          </Button>
        </div>
      )}
      {view?.link && (
        <div className="group-phone-link">
          <QRCodeSVG
            value={view.link}
            size={200}
            level="M"
            marginSize={3}
            title="One-use phone connection link"
          />
          <p>
            Scan with your phone camera. This link grants access to your group; keep it private.
            After connecting, bookmark the group page on your phone.
          </p>
          <p>
            Expires{' '}
            {view.expiresAt ? new Date(view.expiresAt).toLocaleTimeString() : 'in 10 minutes'}. If
            it has expired, create a new link.
          </p>
          <Button
            type="button"
            onPress={() =>
              void navigator.clipboard
                .writeText(view.link!)
                .then(() => setMessage('Phone link copied.'))
                .catch(() =>
                  setMessage('This browser could not copy the link. Scan the QR code instead.'),
                )
            }
          >
            Copy phone link
          </Button>
        </div>
      )}
      {view && (
        <ul className="group-phone-devices">
          {view.devices.map((device) => (
            <li key={device.id}>
              <span>
                <strong>{device.label}</strong>
                <span>
                  {device.state === 'revoked'
                    ? 'Revoked'
                    : device.allowPost
                      ? 'Read and send human messages'
                      : 'Read-only'}
                </span>
              </span>
              {device.state === 'active' && (
                <Button
                  type="button"
                  isDisabled={busy || !!pending || unreadable}
                  onPress={() =>
                    void control({
                      action: 'revoke',
                      handle,
                      key: crypto.randomUUID(),
                      deviceId: device.id,
                    })
                  }
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
