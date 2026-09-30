import { useEffect, useRef, useState } from 'react';
import {
  frontdeskStatusSchema,
  type FrontdeskSave,
  type FrontdeskSettings as Settings,
  type FrontdeskStatus,
  type Project,
} from '@dock/shared';
import { api } from './api';
import { Modal } from './Modal';
import './FrontdeskSettings.css';

type Draft = Pick<Settings, 'visibleProjectIds' | 'preferences' | 'priorities' | 'commitments'>;
const empty: Draft = { visibleProjectIds: [], preferences: '', priorities: '', commitments: '' };
const draftOf = (settings: Settings): Draft => ({
  visibleProjectIds: settings.visibleProjectIds,
  preferences: settings.preferences,
  priorities: settings.priorities,
  commitments: settings.commitments,
});

export function FrontdeskSettings({
  projects,
  close,
  embedded = false,
  open,
}: {
  projects: Project[];
  close: () => void;
  embedded?: boolean;
  open: (agentId: string) => void;
}) {
  const [saved, setSaved] = useState<FrontdeskStatus | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [comparison, setComparison] = useState<FrontdeskStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const pending = useRef<FrontdeskSave | null>(null);
  const choices = projects.filter((project) => project.id !== saved?.projectId);
  const names = new Map(projects.map((project) => [project.id, project.name]));

  function adopt(value: FrontdeskStatus) {
    setSaved(value);
    setDraft(draftOf(value.settings));
    setComparison(null);
    pending.current = null;
  }
  useEffect(() => {
    active.current = true;
    setBusy(true);
    void api('/frontdesk')
      .then((raw) => {
        if (active.current) adopt(frontdeskStatusSchema.parse(raw));
      })
      .catch((cause) => {
        if (active.current)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not read assistant settings. Try again.',
          );
      })
      .finally(() => {
        if (active.current) setBusy(false);
      });
    return () => {
      active.current = false;
    };
  }, []);

  async function reload() {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const latest = frontdeskStatusSchema.parse(await api('/frontdesk'));
      if (!active.current) return;
      if (!saved || JSON.stringify(draft) === JSON.stringify(draftOf(latest.settings)))
        adopt(latest);
      else setComparison(latest);
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not reload settings. Your edits are still here.',
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save() {
    if (busy || !saved || comparison) return;
    setBusy(true);
    setError('');
    setMessage('');
    const input = { ...draft, expectedRevision: saved.settings.revision };
    if (
      !pending.current ||
      JSON.stringify({ ...pending.current, key: undefined }) !==
        JSON.stringify({ ...input, key: undefined })
    )
      pending.current = { ...input, key: crypto.randomUUID() };
    try {
      const receipt = frontdeskStatusSchema.parse(
        await api('/frontdesk/settings', pending.current),
      );
      const current = frontdeskStatusSchema.parse(await api('/frontdesk'));
      if (!active.current) return;
      pending.current = null;
      if (current.settings.revision !== receipt.settings.revision) {
        setComparison(current);
        setError(
          'Your save was received, and another device then saved a newer version. Review the saved settings before making another change.',
        );
      } else {
        adopt(current);
        setMessage('Assistant settings saved. These apply to its next turn; no message was sent.');
      }
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not confirm the save. Your edits are still here. Retry or reload the saved settings.',
        );
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <Modal
      embedded={embedded}
      title="Assistant settings"
      close={close}
      className="frontdesk-settings"
    >
      <p>
        Choose what your personal assistant may know. It explains status and passes your requests to
        project managers; those managers and their workers do the work.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!saved ? (
        <>
          <p role="status">
            {busy ? 'Reading assistant settings…' : 'Assistant settings are not available yet.'}
          </p>
          {!busy && (
            <button className="secondary" onClick={() => void reload()}>
              Try reading settings again
            </button>
          )}
        </>
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy || Boolean(comparison)}>
              <legend>Projects on this computer</legend>
              <p className="muted">
                Nothing is shared by default. Selecting a project lets this computer’s selected
                provider account read its saved evidence and send requests to its managers.
              </p>
              {choices.length === 0 ? (
                <p>Add a project when you want your assistant to help with it.</p>
              ) : (
                choices.map((project) => (
                  <label className="checkbox-label" key={project.id}>
                    <input
                      type="checkbox"
                      checked={draft.visibleProjectIds.includes(project.id)}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          visibleProjectIds: event.target.checked
                            ? [...value.visibleProjectIds, project.id]
                            : value.visibleProjectIds.filter((id) => id !== project.id),
                        }))
                      }
                    />
                    {project.name}
                  </label>
                ))
              )}
              <label>
                How should your assistant work with you?
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={draft.preferences}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, preferences: event.target.value }))
                  }
                  placeholder="For example: keep updates concise and explain unfamiliar terms."
                />
              </label>
              <label>
                Current priorities
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={draft.priorities}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, priorities: event.target.value }))
                  }
                  placeholder="What matters most right now?"
                />
              </label>
              <label>
                Commitments to remember
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={draft.commitments}
                  onChange={(event) =>
                    setDraft((value) => ({ ...value, commitments: event.target.value }))
                  }
                  placeholder="Promises, dates or follow-ups you want it to remember when you talk."
                />
              </label>
              <p className="muted">
                This is editable memory for your conversations, not a reminder timer, automatic task
                schedule or separately trained model.
              </p>
            </fieldset>
            <button className="primary" disabled={busy || Boolean(comparison)}>
              {busy ? 'Saving…' : 'Save assistant settings'}
            </button>
          </form>
          {comparison && (
            <section aria-label="Saved settings comparison">
              <h3>Review the saved version</h3>
              <p>
                Your unsaved edits remain above. Choose which version to keep before saving again.
              </p>
              <p>
                Shared projects:{' '}
                {comparison.settings.visibleProjectIds
                  .map((id) => names.get(id) ?? 'Saved project')
                  .join(', ') || 'None'}
              </p>
              <p>Preferences: {comparison.settings.preferences || 'None saved'}</p>
              <p>Priorities: {comparison.settings.priorities || 'None saved'}</p>
              <p>Commitments: {comparison.settings.commitments || 'None saved'}</p>
              <button
                className="secondary"
                onClick={() => {
                  adopt(comparison);
                  setError('');
                  setMessage('The saved version is shown. No settings were changed.');
                }}
              >
                Use saved settings
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setSaved(comparison);
                  setComparison(null);
                  pending.current = null;
                  setError('');
                  setMessage('Your edits are ready to save over the version you reviewed.');
                }}
              >
                Keep my edits
              </button>
            </section>
          )}
          <button className="secondary" disabled={busy} onClick={() => void reload()}>
            Reload latest saved settings
          </button>
          {saved.agentId && (
            <button className="secondary" onClick={() => open(saved.agentId!)}>
              Open your assistant
            </button>
          )}
          <p className="muted">{saved.notice}</p>
        </>
      )}
    </Modal>
  );
}
