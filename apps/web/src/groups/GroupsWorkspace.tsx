import { useRef, useState } from 'react';
import { DisplayName } from './DisplayName';
import type { GroupChatMode, GroupsWorkspaceProps } from './types';
import './groups.css';

export function GroupsWorkspace(props: GroupsWorkspaceProps) {
  // Neither another group's transcript nor a retained private session is reused.
  const identity = `${props.group.id}:${props.memberId}:${props.sharedChat.sessionId}:${props.access}`;
  return <Workspace key={identity} {...props} />;
}
function Workspace(props: GroupsWorkspaceProps) {
  const { group, memberId, sharedChat, access, onBack } = props;
  const [mode, setMode] = useState<GroupChatMode>('group');
  const groupTab = useRef<HTMLButtonElement>(null);
  const managerTab = useRef<HTMLButtonElement>(null);
  const valid =
    sharedChat.groupId === group.id &&
    sharedChat.memberId === memberId &&
    sharedChat.visibility === 'shared' &&
    Boolean(sharedChat.draftIdentity);
  if (access === 'revoked' || !valid)
    return (
      <main className="groups-unavailable">
        <button onClick={onBack}>Back to groups</button>
        <h1>{access === 'revoked' ? 'Group access revoked' : 'Group chat unavailable'}</h1>
        <p role="alert">
          {access === 'revoked'
            ? 'Ask a member about access.'
            : 'The host must provide an authorized shared conversation for this group.'}
        </p>
      </main>
    );
  const select = (value: GroupChatMode, focus = false) => {
    setMode(value);
    if (focus) (value === 'group' ? groupTab : managerTab).current?.focus();
  };
  return (
    <main className="groups-workspace">
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
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            select(
              event.key === 'Home'
                ? 'group'
                : event.key === 'End'
                  ? 'manager'
                  : mode === 'group'
                    ? 'manager'
                    : 'group',
              true,
            );
          }}
        >
          <button
            ref={groupTab}
            id="groups-chat-tab"
            role="tab"
            aria-selected={mode === 'group'}
            tabIndex={mode === 'group' ? 0 : -1}
            aria-controls="groups-chat-panel"
            onClick={() => select('group')}
          >
            Group chat
          </button>
          <button
            ref={managerTab}
            id="groups-manager-tab"
            role="tab"
            aria-selected={mode === 'manager'}
            tabIndex={mode === 'manager' ? 0 : -1}
            aria-controls="groups-chat-panel"
            onClick={() => select('manager')}
          >
            My group agent
          </button>
        </div>
        {props.contributionControl && (
          <div className="groups-actions group-contribution-control">
            {props.contributionControl}
          </div>
        )}
      </div>
      <div className="groups-columns">
        <section
          id="groups-chat-panel"
          className="groups-chat-panel chat-pane"
          role="tabpanel"
          aria-labelledby={mode === 'group' ? 'groups-chat-tab' : 'groups-manager-tab'}
        >
          <div className="groups-chat-slot" key={sharedChat.sessionId}>
            {typeof sharedChat.content === 'function'
              ? sharedChat.content(mode)
              : sharedChat.content}
          </div>
        </section>
      </div>
    </main>
  );
}
