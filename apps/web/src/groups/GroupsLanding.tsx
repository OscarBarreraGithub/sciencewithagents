import { useEffect, useRef, useState } from 'react';
import { groupDisplayNameSchema } from '@dock/shared';
import type { GroupsLandingProps } from './types';
import { DisplayName } from './DisplayName';
import { Modal } from '../Modal';
import { Users } from 'lucide-react';
import './groups.css';
import './groups-list.css';

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
  removedGroups,
  selectedId,
  query = '',
  onSetup,
  setupRequired = false,
}: GroupsLandingProps) {
  const [mode, setMode] = useState<'create' | 'join' | null>(initialInvitation ? 'join' : null);
  const [name, setName] = useState('');
  const [project, setProject] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [invitation, setInvitation] = useState(initialInvitation ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const currentInvitationRevision = useRef(invitationRevision);
  currentInvitationRevision.current = invitationRevision;
  const setupCodeInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!initialInvitation) return;
    setMode('join');
    setInvitation(initialInvitation);
    setError('');
  }, [initialInvitation, invitationRevision]);
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
    const submittedRevision = currentInvitationRevision.current;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      // The host owns validation/authentication and the resulting navigation.
      if (mode === 'create') {
        await onCreate({
          projectName: project,
          displayName: name,
          ...(setupCodeRequired ? { setupCode: setupCode.trim() } : {}),
        });
        if (submittedRevision === currentInvitationRevision.current) setMode(null);
      } else {
        await onJoin({ invitation, displayName: name });
        if (submittedRevision === currentInvitationRevision.current) {
          setMode(null);
          setInvitation('');
        }
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
    <div className="groups-chat-list">
      <div className="groups-list-actions">
        <button className="flow-button primary" onClick={() => setMode('create')}>
          New group
        </button>
        <button className="flow-button" onClick={() => setMode('join')}>
          Join group
        </button>
        {onSetup && (
          <button
            className="flow-button"
            aria-label="Group setup"
            title="Group setup"
            onClick={onSetup}
          >
            Setup
          </button>
        )}
      </div>
      {joinReceipt}
      <nav className="chat-list-scroll" aria-label="Group conversations">
        {groups.kind === 'loading' ? (
          <p className="chat-list-empty" role="status">
            Loading groups…
          </p>
        ) : groups.kind !== 'ready' ? (
          <div className="chat-list-empty" role="status">
            <p>{groups.message}</p>
            <button onClick={onRetry}>Retry groups</button>
          </div>
        ) : (
          <>
            {groups.value
              .filter((group) =>
                group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
              )
              .map((group) => (
                <button
                  key={group.id}
                  className={`flow-person chat-row group${selectedId === group.id ? ' selected' : ''}`}
                  aria-current={selectedId === group.id ? 'page' : undefined}
                  onClick={() => onOpen(group.id)}
                >
                  <span className="chat-row-icon manager" aria-hidden="true">
                    <Users size={17} />
                  </span>
                  <span className="chat-row-text">
                    <strong>
                      <DisplayName value={group.name} />
                    </strong>
                    <small>
                      {group.members} {group.members === 1 ? 'member' : 'members'}
                    </small>
                  </span>
                </button>
              ))}
            {!groups.value.length && (
              <p className="chat-list-empty">
                No shared chats yet. Join with an invitation or create a group.
              </p>
            )}
            {!!groups.value.length &&
              !groups.value.some((group) =>
                group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
              ) && <p className="chat-list-empty">No groups match your search.</p>}
          </>
        )}
        {removedGroups}
      </nav>
      {mode && (
        <Modal
          title={mode === 'create' ? 'New group' : 'Join a group'}
          className="groups-form-dialog"
          close={() => {
            if (!busy) {
              setMode(null);
              setError('');
            }
          }}
        >
          <form
            className="groups-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            noValidate
          >
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
            <p id="groups-name-note">The name other members will see.</p>
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
                <p>
                  Sharing files too? After creation, connect GitHub in Manage group → Shared files.
                </p>
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
            {mode === 'create' && setupRequired && onSetup && (
              <div className="groups-setup-needed">
                <p>Set up hosting once before creating your first group.</p>
                <button type="button" className="secondary" onClick={onSetup}>
                  Set up hosting
                </button>
              </div>
            )}
            <button className="primary" disabled={busy || (mode === 'create' && setupRequired)}>
              {busy ? 'Connecting…' : mode === 'create' ? 'Create group' : 'Join group'}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
