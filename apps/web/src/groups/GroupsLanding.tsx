import { githubUsernameSchema } from '@dock/shared/dist/group-github.js';
import { apiScope, ApiError } from '../api';
import { groupJoinHandoffPrompt } from './group-join-prompt';
import { GroupCreationFolder, type CreationSelection } from './GroupCreationFolder';
import { useEffect, useId, useRef, useState } from 'react';
import { groupDisplayNameSchema, projectFolderSelectionSchema } from '@dock/shared';
import type { GroupsLandingProps } from './types';
import { DisplayName } from './DisplayName';
import { Modal } from '../Modal';
import { Button } from '../ui/Button';
import { Hash, Plus, Settings2, Users } from 'lucide-react';
import { CopyPrompt } from './GroupSetupPrompt';
import { groupCreationSetupPrompt } from './group-creation-prompt';
import './groups.css';
import './groups-list.css';

type CreationDraft = {
  name: string;
  project: string;
  choice: 'chat' | 'folder' | null;
  selection: CreationSelection | null;
  open: boolean;
  created?: string;
};
const draftKey = () => `swa:groups:${apiScope()}:creation-draft`;
function readDraft(): CreationDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey()) ?? 'null') as CreationDraft | null;
    if (
      value &&
      typeof value.name === 'string' &&
      typeof value.project === 'string' &&
      [null, 'chat', 'folder'].includes(value.choice)
    )
      return {
        ...value,
        selection: value.selection ? projectFolderSelectionSchema.parse(value.selection) : null,
      };
  } catch {}
  return { name: '', project: '', choice: null, selection: null, open: false };
}
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
  const scope = apiScope();
  const githubUsernameNote = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && apiScope() === scope;
  const [githubUsername, setGithubUsername] = useState(
    () => sessionStorage.getItem(`swa:groups:${scope}:join-github-username`) ?? '',
  );
  const [joinSetupNeeded, setJoinSetupNeeded] = useState(false);
  const [draft, setDraft] = useState(readDraft);
  const [folderPending, setFolderPending] = useState(
    () => !!sessionStorage.getItem(`swa:groups:${apiScope()}:creation-folder-pick`),
  );
  const saveDraft = (change: Partial<CreationDraft>) =>
    setDraft((old) => {
      const next = { ...old, ...change };
      if (!current()) return old;
      sessionStorage.setItem(`swa:groups:${scope}:creation-draft`, JSON.stringify(next));
      return next;
    });
  const [mode, setMode] = useState<'create' | 'join' | null>(() =>
    initialInvitation ? 'join' : draft.open ? 'create' : null,
  );
  const name = draft.name,
    project = draft.project;
  const pendingCreation = !!sessionStorage.getItem(`swa:groups:${apiScope()}:create`);

  const setName = (name: string) => saveDraft({ name });
  const setProject = (project: string) => saveDraft({ project });
  const readyContext = !!(
    groupDisplayNameSchema.safeParse(name).success &&
    project.trim() &&
    project.length <= 120 &&
    (draft.choice === 'chat' ||
      (draft.choice === 'folder' && !folderPending && draft.selection?.workspacePath))
  );
  const prompt = readyContext
    ? groupCreationSetupPrompt({
        displayName: name,
        projectName: project,
        selection: draft.choice === 'folder' ? draft.selection : null,
        folderSelected: draft.choice === 'folder',
        groupHandle: draft.created,
      })
    : null;
  const [setupCode, setSetupCode] = useState('');
  const [invitation, setInvitation] = useState(initialInvitation ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creationLocked = busy || !!draft.created || pendingCreation;
  const active = useRef(false);
  const entriesVersion = useRef(0);
  const currentInvitationRevision = useRef(invitationRevision);
  currentInvitationRevision.current = invitationRevision;
  const setupCodeInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const restore = () => {
      setDraft(readDraft());
      setMode(null);
    };
    window.addEventListener('swa:group-creation-recovered', restore);
    return () => window.removeEventListener('swa:group-creation-recovered', restore);
  }, []);
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
    if (mode === 'join' && !githubUsernameSchema.safeParse(githubUsername).success) {
      setError('Use a valid optional GitHub username, without @.');
      return;
    }
    if (mode === 'create' && (!readyContext || draft.created)) return;
    if (mode === 'create' && setupCodeRequired && !setupCode.trim()) {
      setError('Paste your beta setup code. Members join later with your invitation.');
      return;
    }
    const submittedRevision = currentInvitationRevision.current;
    const submittedEntries = entriesVersion.current;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      // The host owns validation/authentication and the resulting navigation.
      if (mode === 'create') {
        const created = await onCreate({
          projectName: project,
          displayName: name,
          ...(draft.choice === 'folder' ? { selectionKey: draft.selection!.key } : {}),
          ...(setupCodeRequired ? { setupCode: setupCode.trim() } : {}),
        });
        if (!current()) return;
        const completion = created
          ? JSON.parse(
              sessionStorage.getItem(`swa:groups:${scope}:creation-context:${created}`) ?? 'null',
            )
          : null;
        if (created && !completion)
          sessionStorage.setItem(
            `swa:groups:${scope}:creation-context:${created}`,
            JSON.stringify({ ...draft, created, open: false }),
          );
        if (submittedRevision === currentInvitationRevision.current)
          saveDraft({ ...draft, ...completion, created: created || undefined, open: false });
        if (submittedRevision === currentInvitationRevision.current) setMode(null);
      } else {
        await onJoin({
          invitation,
          displayName: name,
          ...(githubUsername.trim() ? { githubUsername: githubUsername.trim() } : {}),
        });
        if (!current()) return;
        setJoinSetupNeeded(false);
        if (submittedRevision === currentInvitationRevision.current) {
          setMode(null);
          setInvitation('');
        }
      }
    } catch (reason) {
      if (!current()) return;
      if (mode === 'join' && submittedEntries !== entriesVersion.current) return;
      if (mode === 'join')
        setJoinSetupNeeded(
          reason instanceof ApiError &&
            [
              'GROUP_SERVICE_REGISTRATION_REQUIRED',
              'GROUP_SETUP_REQUIRED',
              'GROUP_INVITATION_SERVICE_CHANGED',
              'GROUP_SERVICE_CHANGED',
            ].includes(reason.code ?? ''),
        );
      setError(
        reason instanceof Error ? reason.message : 'Could not continue. Your entries are kept.',
      );
    } finally {
      if (current()) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="groups-chat-list">
      <div className="groups-list-actions">
        <Button
          className="flow-button primary groups-new-button"
          variant="primary"
          aria-label="New group"
          onPress={() => {
            if (draft.created)
              saveDraft({
                name: '',
                project: '',
                choice: null,
                selection: null,
                created: undefined,
                open: true,
              });
            else saveDraft({ open: true });
            setMode('create');
          }}
        >
          <Plus size={18} aria-hidden="true" />
          <span>New group</span>
        </Button>
        <Button className="flow-button" onPress={() => setMode('join')}>
          Join group
        </Button>
        {onSetup && (
          <Button
            className="flow-button groups-setup-button"
            aria-label="Group setup"
            onPress={onSetup}
          >
            <Settings2 size={18} aria-hidden="true" />
          </Button>
        )}
      </div>
      {draft.created && (
        <button
          className="flow-button"
          type="button"
          onClick={() => {
            saveDraft({ open: true });
            setMode('create');
          }}
        >
          Continue group setup
        </button>
      )}
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
                    <Hash size={17} />
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
              <div className="chat-list-empty groups-list-empty">
                <Users size={28} aria-hidden="true" />
                <strong>No groups yet</strong>
                <p>Start a shared conversation, or join with an invitation.</p>
              </div>
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
              saveDraft({ open: false });
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
                disabled={mode === 'create' && creationLocked}
                value={name}
                maxLength={120}
                onChange={(event) => {
                  entriesVersion.current++;
                  setName(event.target.value);
                  setJoinSetupNeeded(false);
                }}
                aria-describedby="groups-name-note"
              />
            </label>
            <p id="groups-name-note">The name other members will see.</p>
            {mode === 'create' ? (
              <>
                <label>
                  Project name
                  <input
                    disabled={creationLocked}
                    value={project}
                    maxLength={120}
                    onChange={(event) => setProject(event.target.value)}
                  />
                </label>
                <fieldset disabled={creationLocked}>
                  <legend>How will this group work?</legend>
                  <label>
                    <input
                      type="radio"
                      name="group-files-choice"
                      checked={draft.choice === 'chat'}
                      onChange={() => saveDraft({ choice: 'chat' })}
                    />
                    Chat only — no GitHub
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="group-files-choice"
                      checked={draft.choice === 'folder'}
                      onChange={() => saveDraft({ choice: 'folder' })}
                    />
                    Use my intended work folder
                  </label>
                </fieldset>
                {draft.choice === 'folder' && (
                  <p>GitHub remains optional. Selecting a folder does not publish files.</p>
                )}
                {draft.choice === 'folder' && (
                  <GroupCreationFolder
                    selection={draft.selection}
                    disabled={creationLocked}
                    onPending={setFolderPending}
                    onSelection={(selection) => saveDraft({ selection })}
                  />
                )}
                {prompt ? (
                  <section
                    className="group-setup-choice group-create-guide"
                    aria-label="Set up with your agent"
                  >
                    <h3>Set up with your agent</h3>
                    <p>
                      {draft.created
                        ? 'Group created. Keep this prompt for remaining optional repository setup.'
                        : setupRequired
                          ? 'Setup pending — your choices are saved locally. Your agent can configure hosting; return here to finish creation when ready.'
                          : 'Hosting is ready. Create with these choices, or give the contextual prompt to your agent for remaining setup.'}
                    </p>
                    <p>
                      Copy to your existing agent in the intended folder. Copying makes no model
                      call and does not change its working directory.
                    </p>
                    <CopyPrompt
                      key={prompt}
                      label="Group creation setup prompt"
                      button="Copy group setup prompt"
                      text={prompt}
                    />
                  </section>
                ) : (
                  <p>
                    Enter both names and choose chat only or a folder to prepare your setup prompt.
                  </p>
                )}
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
                  onChange={(event) => {
                    entriesVersion.current++;
                    setInvitation(event.target.value);
                    setJoinSetupNeeded(false);
                  }}
                />
              </label>
            )}
            {mode === 'join' && (
              <>
                <label>
                  GitHub username (optional)
                  <input
                    autoComplete="off"
                    autoCapitalize="none"
                    aria-describedby={githubUsernameNote}
                    maxLength={39}
                    disabled={busy || !!sessionStorage.getItem(`swa:groups:${scope}:join`)}
                    value={githubUsername}
                    onChange={(event) => {
                      setGithubUsername(event.target.value);
                      sessionStorage.setItem(
                        `swa:groups:${scope}:join-github-username`,
                        event.target.value,
                      );
                    }}
                  />
                </label>
                <p id={githubUsernameNote}>
                  For shared files. Your username will be shared with group members; chat membership
                  does not grant repository access.
                </p>
              </>
            )}
            {mode === 'join' && joinSetupNeeded && (
              <section className="group-setup-choice" aria-label="Finish joining with your agent">
                <h3>Finish joining with your agent</h3>
                <p>
                  This computer needs a trusted service registration check. Give this private prompt
                  to your existing setup agent, then retry Join group here with the same invitation
                  and name. Copying does not run setup or contact the invitation’s service.
                </p>
                <CopyPrompt
                  key={JSON.stringify([name, invitation])}
                  label="Private join setup prompt"
                  button="Copy join handoff prompt"
                  text={groupJoinHandoffPrompt(name, invitation)}
                />
              </section>
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
            {mode === 'create' && !draft.created && setupRequired && onSetup && (
              <div className="groups-setup-needed">
                <p>Set up hosting once before creating your first group.</p>
                <button type="button" className="secondary" onClick={onSetup}>
                  Set up hosting
                </button>
              </div>
            )}
            <button
              className="primary"
              disabled={
                busy || (mode === 'create' && (setupRequired || !readyContext || !!draft.created))
              }
            >
              {busy
                ? 'Connecting…'
                : mode === 'create'
                  ? draft.created
                    ? 'Group created'
                    : 'Create group'
                  : 'Join group'}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
