import { useCallback, useEffect, useRef, useState } from 'react';
import { GroupFeed } from './GroupFeed';
import { DisplayName } from './DisplayName';
import type { GroupRead, GroupsWorkspaceProps } from './types';
import './groups.css';

export function GroupsWorkspace(props: GroupsWorkspaceProps) {
  // Remount synchronously: no frame contains the previous group's/session's evidence.
  const identity = `${props.group.id}:${props.memberId}:${props.sharedChat.sessionId}:${props.privateAside?.sessionId ?? ''}:${props.access}`;
  return <Workspace key={identity} {...props} />;
}
function Workspace(props: GroupsWorkspaceProps) {
  const { group, memberId, sharedChat, privateAside, access, onBack } = props;
  const [revoked, setRevoked] = useState('');
  const onRevoked = useCallback((message: string) => setRevoked(message), []);
  const [panel, setPanel] = useState<'feed' | 'chat'>('chat');
  const [aside, setAside] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const [catchReading, setCatchReading] = useState<GroupRead<string> | { kind: 'loading' }>({
    kind: 'loading',
  });
  const [catchAttempt, setCatchAttempt] = useState(0);
  const privateButton = useRef<HTMLButtonElement>(null);
  const chatHeading = useRef<HTMLHeadingElement>(null);
  const catchButton = useRef<HTMLButtonElement>(null);
  const catchHeading = useRef<HTMLHeadingElement>(null);
  const feedTab = useRef<HTMLButtonElement>(null);
  const chatTab = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!catchingUp || props.catchUpView) return;
    const controller = new AbortController();
    let alive = true;
    setCatchReading({ kind: 'loading' });
    catchHeading.current?.focus();
    void props
      .catchUp(controller.signal)
      .then((result) => {
        if (!alive) return;
        if (result.kind === 'revoked') onRevoked(result.message);
        else setCatchReading(result);
      })
      .catch((reason: unknown) => {
        if (alive)
          setCatchReading({
            kind: 'error',
            message: reason instanceof Error ? reason.message : 'Catch-up unavailable. Retry.',
          });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [catchingUp, catchAttempt, props.catchUp, props.catchUpView, onRevoked]);
  const closeCatchUp = () => {
    setCatchingUp(false);
    requestAnimationFrame(() => catchButton.current?.focus({ preventScroll: true }));
  };
  const closePrivate = () => {
    setAside(false);
    requestAnimationFrame(() => privateButton.current?.focus({ preventScroll: true }));
  };
  const validSlot = (slot: typeof sharedChat) =>
    slot.groupId === group.id && slot.memberId === memberId && Boolean(slot.draftIdentity);
  const valid =
    validSlot(sharedChat) &&
    sharedChat.visibility === 'shared' &&
    (!privateAside ||
      (validSlot(privateAside) &&
        privateAside.visibility === 'private' &&
        privateAside.sessionId !== sharedChat.sessionId &&
        privateAside.draftIdentity !== sharedChat.draftIdentity));
  if (access === 'revoked' || revoked)
    return (
      <main className="groups-unavailable">
        <button onClick={onBack}>Back to groups</button>
        <h1>Group access revoked</h1>
        <p role="alert">
          {revoked || 'Shared evidence and chat are unavailable. Ask a member about access.'}
        </p>
      </main>
    );
  if (!valid)
    return (
      <main className="groups-unavailable">
        <button onClick={onBack}>Back to groups</button>
        <h1>Chat unavailable</h1>
        <p role="alert">
          The host must provide distinct authorized shared and private session/draft identities.
        </p>
      </main>
    );
  const selectPanel = (value: typeof panel, focusTab = false) => {
    setPanel(value);
    if (focusTab) (value === 'feed' ? feedTab : chatTab).current?.focus();
  };
  return (
    <main
      className="groups-workspace"
      onKeyDown={(event) => {
        const target = event.target;
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          !(target instanceof Element) ||
          !event.currentTarget.contains(target) ||
          target.closest('dialog, [role="dialog"], [role="alertdialog"]')
        )
          return;
        // Portals/nested dialogs own their dismissal. Only dismiss the active workspace layer.
        if (catchingUp || aside) {
          event.preventDefault();
          if (catchingUp) closeCatchUp();
          else closePrivate();
        }
      }}
    >
      <header className="groups-workspace-heading">
        <button className="secondary" onClick={onBack} aria-label="Back to groups">
          ←
        </button>
        <div>
          <h1>
            <DisplayName value={group.name} />
          </h1>
          <details className="groups-member-list">
            <summary>
              {props.members.length} {props.members.length === 1 ? 'member' : 'members'}
            </summary>
            <ul>
              {props.members.map((member) => (
                <li key={member.installationId}>
                  <DisplayName value={member.displayName} />
                </li>
              ))}
            </ul>
          </details>
        </div>
        {props.onManage && (
          <button
            className="secondary"
            aria-label="Manage"
            title="Manage group"
            onClick={props.onManage}
          >
            ⋯
          </button>
        )}
        {props.onInvite && (
          <button className="secondary" aria-label="Invite people" onClick={props.onInvite}>
            Invite
          </button>
        )}
      </header>
      <div className="groups-navigation">
        <div
          className="groups-tabs"
          role="tablist"
          aria-label="Group panels"
          onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              selectPanel(
                event.key === 'Home'
                  ? 'feed'
                  : event.key === 'End'
                    ? 'chat'
                    : panel === 'feed'
                      ? 'chat'
                      : 'feed',
                true,
              );
            }
          }}
        >
          <button
            ref={feedTab}
            id="groups-feed-tab"
            role="tab"
            aria-selected={panel === 'feed'}
            tabIndex={panel === 'feed' ? 0 : -1}
            aria-controls="groups-feed-panel"
            onClick={() => selectPanel('feed')}
          >
            Shared feed
          </button>
          <button
            ref={chatTab}
            id="groups-chat-tab"
            role="tab"
            aria-selected={panel === 'chat'}
            tabIndex={panel === 'chat' ? 0 : -1}
            aria-controls="groups-chat-panel"
            onClick={() => selectPanel('chat')}
          >
            {aside ? 'Private to you' : 'Shared chat'}
          </button>
        </div>
        <div className="groups-actions" hidden={panel !== 'chat' || catchingUp}>
          {aside ? (
            <button className="secondary" onClick={closePrivate}>
              Back to shared chat
            </button>
          ) : (
            <button
              ref={privateButton}
              className="secondary"
              disabled={!privateAside}
              onClick={() => {
                setAside(true);
                requestAnimationFrame(() => chatHeading.current?.focus());
              }}
            >
              Private to you
            </button>
          )}
          <button
            ref={catchButton}
            aria-label="What mattered since last visit?"
            className="secondary"
            onClick={() => {
              setCatchingUp(true);
            }}
          >
            Catch up
          </button>
        </div>
      </div>
      <div className="groups-columns">
        <section
          id="groups-feed-panel"
          className="groups-feed-panel"
          hidden={panel !== 'feed'}
          role="tabpanel"
          aria-labelledby="groups-feed-tab"
        >
          <GroupFeed
            group={group}
            members={props.members}
            loadPage={props.loadPage}
            loadOriginal={props.loadOriginal}
            refreshable={props.refreshableFeed}
            onRevoked={onRevoked}
          />
        </section>
        <section
          id="groups-chat-panel"
          className="groups-chat-panel chat-pane"
          hidden={panel !== 'chat'}
          role="tabpanel"
          aria-labelledby="groups-chat-tab"
        >
          <header className="groups-panel-heading" hidden={catchingUp} inert={catchingUp}>
            <h2 ref={chatHeading} tabIndex={-1}>
              {aside ? 'Private to you' : (props.chatTitle ?? 'Shared chat')}
            </h2>
            <p>
              {aside
                ? (props.privateDescription ??
                  'Saved on this computer; excluded from the shared feed.')
                : (props.sharedDescription ?? 'Messages you send here are shared with this group.')}
            </p>
            {!privateAside && (
              <p>Private to you unavailable until a separate session is provided.</p>
            )}
          </header>
          {catchingUp &&
            (props.catchUpView ? (
              props.catchUpView(closeCatchUp)
            ) : (
              <section className="groups-catch-up" aria-label="Private catch-up">
                <h3 ref={catchHeading} tabIndex={-1}>
                  Private catch-up
                </h3>
                <p>
                  Shown only in your panel. Request privacy must be enforced by the host. Coverage
                  and evidence come from the host.
                </p>
                {catchReading.kind === 'loading' ? (
                  <p role="status">Loading catch-up…</p>
                ) : catchReading.kind === 'ready' ? (
                  <p className="groups-exact-text">{catchReading.value}</p>
                ) : (
                  <div role="status">
                    <p>{catchReading.message}</p>
                    <button onClick={() => setCatchAttempt((n) => n + 1)}>Retry catch-up</button>
                  </div>
                )}
                <button onClick={closeCatchUp}>Back to conversation</button>
              </section>
            ))}
          <div
            className="groups-chat-slot"
            key={aside ? privateAside!.sessionId : sharedChat.sessionId}
            hidden={catchingUp}
            inert={catchingUp}
          >
            {aside ? privateAside!.content : sharedChat.content}
          </div>
        </section>
      </div>
    </main>
  );
}
