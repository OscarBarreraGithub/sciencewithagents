import { useEffect, useRef, useState } from 'react';
import { groupDisplayNameSchema } from '@dock/shared';
import type { GroupsLandingProps } from './types';
import { DisplayName } from './DisplayName';
import './groups.css';

export function GroupsLanding({
  groups,
  onOpen,
  onCreate,
  onJoin,
  onRetry,
  initialInvitation,
  invitationRevision = 0,
  setupCodeRequired = false,
  onNewSetupCode,
  joinReceipt,
}: GroupsLandingProps) {
  const [mode, setMode] = useState<'create' | 'join' | null>(initialInvitation ? 'join' : null);
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [invitation, setInvitation] = useState(initialInvitation ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const setupCodeInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!initialInvitation) return;
    setMode('join');
    setInvitation(initialInvitation);
    setError('');
  }, [initialInvitation, invitationRevision]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const submit = async () => {
    if (active.current || !mode) return;
    if (!groupDisplayNameSchema.safeParse(name).success) {
      setError('Type your display name (1–120 characters).');
      return;
    }
    if (mode === 'create' && (!project.trim() || project.length > 120)) {
      setError('Type a project name (1–120 characters).');
      return;
    }
    if (mode === 'join' && (!invitation.trim() || invitation.length > 4096)) {
      setError('Paste your invitation link.');
      return;
    }
    if (mode === 'create' && setupCodeRequired && !setupCode.trim()) {
      setError('Paste your beta setup code. Members join later with your invitation.');
      return;
    }
    active.current = true;
    setBusy(true);
    setError('');
    try {
      // The host owns validation/authentication and the resulting navigation.
      if (mode === 'create')
        await onCreate({
          projectName: project,
          displayName: name,
          ...(setupCodeRequired ? { setupCode: setupCode.trim() } : {}),
        });
      else {
        await onJoin({ invitation, displayName: name });
        setMode(null);
        setInvitation('');
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Could not continue. Your entries are kept.',
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="groups-landing">
      <header>
        <p className="groups-eyebrow">Sciencewithagents</p>
        <h1 ref={heading} tabIndex={-1}>
          Groups
        </h1>
        <p>Shared work, with your own agent alongside it.</p>
      </header>
      {!mode ? (
        <>
          <div className="groups-actions">
            <button className="primary" onClick={() => setMode('create')}>
              New project
            </button>
            <button className="secondary" onClick={() => setMode('join')}>
              Join by invitation
            </button>
          </div>
          {joinReceipt}
          <h2>Your projects</h2>
          {groups.kind === 'loading' ? (
            <p role="status">Loading projects…</p>
          ) : groups.kind !== 'ready' ? (
            <div role="status">
              <p>{groups.message}</p>
              <button onClick={onRetry}>Retry projects</button>
            </div>
          ) : groups.value.length === 0 ? (
            <p>No groups yet. Create a project or use an invitation.</p>
          ) : (
            <ul className="groups-projects">
              {groups.value.map((group) => (
                <li key={group.id}>
                  <button onClick={() => onOpen(group.id)}>
                    <strong>
                      <DisplayName value={group.name} />
                    </strong>
                    <span>
                      {group.members} {group.members === 1 ? 'member' : 'members'} · {group.sync}
                    </span>
                    <span aria-hidden="true">Open →</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form
          className="groups-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          noValidate
        >
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setMode(null);
              setError('');
              requestAnimationFrame(() => heading.current?.focus());
            }}
          >
            Back to groups
          </button>
          <h2>{mode === 'create' ? 'New project' : 'Join a project'}</h2>
          <label>
            Your display name
            <input
              autoFocus
              autoComplete="off"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              aria-describedby="groups-name-note"
            />
          </label>
          <p id="groups-name-note">
            Type the name members should see. A display name does not verify identity.
          </p>
          {mode === 'create' ? (
            <>
              <label>
                Project name
                <input
                  value={project}
                  maxLength={120}
                  onChange={(event) => setProject(event.target.value)}
                />
              </label>
              {setupCodeRequired && (
                <>
                  <label>
                    Beta setup code
                    <textarea
                      ref={setupCodeInput}
                      aria-label="Beta setup code"
                      value={setupCode}
                      maxLength={4096}
                      rows={3}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      onChange={(event) => setSetupCode(event.target.value)}
                      aria-describedby="groups-code-note"
                    />
                  </label>
                  <p id="groups-code-note">
                    Use the code from the beta operator to create one project. Members need only
                    your invitation.
                  </p>
                </>
              )}
            </>
          ) : (
            <label>
              Invitation link
              <input
                type="text"
                autoComplete="off"
                value={invitation}
                maxLength={4096}
                onChange={(event) => setInvitation(event.target.value)}
              />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          {mode === 'create' && setupCodeRequired && onNewSetupCode && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                onNewSetupCode();
                setSetupCode('');
                setError('');
                requestAnimationFrame(() => setupCodeInput.current?.focus());
              }}
            >
              Use a new setup code
            </button>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Waiting…' : mode === 'create' ? 'Continue setup' : 'Join group'}
          </button>
        </form>
      )}
    </main>
  );
}
