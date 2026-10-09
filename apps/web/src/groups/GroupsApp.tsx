import { DisplayName } from './DisplayName';
import { GroupReports } from './GroupReports';
import { GroupHostedExport } from './GroupHostedExport';
import { GroupWorkFolder } from './GroupWorkFolder';
import { GroupLocalVisibility } from './GroupLocalVisibility';
import { GroupContributionMode } from './GroupContributionMode';
import { GroupLocalReceiptStorage } from './GroupLocalReceiptStorage';
import { GroupSetupPrompt } from './GroupSetupPrompt';
import { GroupJoinReceipt } from './GroupJoinReceipt';
import { GroupGitPanel } from './GroupGitPanel';
import { GroupNativeGitPanel } from './GroupNativeGitPanel';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { groupFeedPageSchema, type GroupEvent, type GroupFeedQuery } from '@dock/shared';
import * as contracts from '@dock/shared/dist/group-host.js';
import { api, apiScope, ApiError } from '../api';
import { GroupsLanding } from './GroupsLanding';
import { GroupsWorkspace } from './GroupsWorkspace';
import { GroupChat } from './GroupChat';
import { GroupActionsBoard } from './GroupActionsBoard';
import { Modal } from '../Modal';
import type { GroupChatMode } from './GroupChat';
import { GroupDocumentScope, GroupDocumentHost } from './GroupDocumentLink';
import PdfReader from '../PdfReader';
import {
  initialGroupInvitation,
  groupInvitationRevision,
  clearGroupInvitation,
  groupInvitationUrl,
} from './group-invitation';
import type { GroupRead } from './types';
import './group-host.css';
import { GROUP_POLLING, startGroupPolling } from './group-polling';
import { groupPollingUpdates, observeGroupUpdates } from './group-updates';
const request = (path: string, body?: unknown, signal?: AbortSignal) =>
  api(path === 'groups' ? '/groups' : `/groups/${path}`, body, signal);
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : 'Groups unavailable. Reconnect and retry.';
const canReplaceSetupCode = (reason: unknown) =>
  reason instanceof ApiError &&
  (reason.code === 'GROUP_BETA_CREATION_EXPIRED' || reason.code === 'GROUP_BETA_CODE_USED');
const readError = (reason: unknown): GroupRead<never> => ({
  kind: reason instanceof ApiError && reason.code === 'GROUP_REVOKED' ? 'revoked' : 'error',
  message: message(reason),
});
const pending = (action: string, input: unknown) => {
  const storage = `swa:groups:${apiScope()}:${action}`;
  const exact = JSON.stringify(input);
  const saved = JSON.parse(sessionStorage.getItem(storage) ?? 'null') as {
    input: string;
    key: string;
  } | null;
  if (saved && saved.input !== exact)
    throw new Error(
      'An acknowledgement is pending. Retry the same entries before starting another request.',
    );
  const result = saved ?? { input: exact, key: crypto.randomUUID() };
  sessionStorage.setItem(storage, JSON.stringify(result));
  return { key: result.key, clear: () => sessionStorage.removeItem(storage) };
};
function hasPendingSetup() {
  try {
    return ['create', 'join'].some((kind) =>
      sessionStorage.getItem(`swa:groups:${apiScope()}:${kind}`),
    );
  } catch {
    return false;
  }
}
function GroupConversation({
  slot,
  onChanged,
  nativeControlsTarget,
  onAuthorizationRequired,
  sharedHandle,
  executionMode,
  readOnly,
  mode,
  sharedFeed,
}: {
  slot: contracts.GroupHostSlot;
  onChanged: () => void;
  nativeControlsTarget: HTMLDivElement | null;
  onAuthorizationRequired: () => void;
  sharedHandle: string;
  executionMode?: 'host' | 'isolated';
  readOnly?: boolean;
  mode: GroupChatMode;
  sharedFeed: Pick<import('./types').GroupsWorkspaceProps, 'loadPage' | 'loadOriginal' | 'members'>;
}) {
  return (
    <GroupDocumentScope handle={slot.handle} sharedHandle={sharedHandle} readOnly={readOnly}>
      <GroupChat
        slot={slot}
        mode={mode}
        sharedFeed={sharedFeed}
        executionMode={executionMode}
        readOnly={readOnly}
        request={request}
        onChanged={onChanged}
        nativeControlsTarget={nativeControlsTarget}
        onAuthorizationRequired={onAuthorizationRequired}
      />
      <GroupDocumentHost reader={PdfReader} />
    </GroupDocumentScope>
  );
}
export function GroupsApp({
  route,
  listHeader,
  query,
}: {
  route: string;
  listHeader?: ReactNode;
  query?: string;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  useEffect(observeGroupUpdates, []);
  const [invitation, setInvitation] = useState(initialGroupInvitation);
  const [invitationRevision, setInvitationRevision] = useState(groupInvitationRevision);
  useEffect(() => {
    const update = () => {
      setInvitation(initialGroupInvitation());
      setInvitationRevision(groupInvitationRevision());
    };
    window.addEventListener('hashchange', update);
    update();
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const [list, setList] = useState<contracts.GroupHostSummary[] | null>(null);
  const [removed, setRemoved] = useState<contracts.GroupHostSummary[]>([]);
  const [service, setService] = useState('Loading Groups configuration…');
  const [localReceiptStorage, setLocalReceiptStorage] =
    useState<
      ReturnType<typeof contracts.groupHostListSchema.parse>['service']['localReceiptStorage']
    >();
  const [serviceConfigured, setServiceConfigured] = useState<boolean | null>(null);
  const [setupCodeRequired, setSetupCodeRequired] = useState(false);
  const [newSetupCodeAllowed, setNewSetupCodeAllowed] = useState(false);
  const [native, setNative] = useState('Checking agent availability…');
  const [selected, setSelected] = useState<contracts.GroupHostOpen | null>(null);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const listRead = useRef<AbortController | null>(null);
  const active = useRef(false);
  const [joinNotice, setJoinNotice] = useState('');
  const [joinReceipt, setJoinReceipt] = useState<{
    handle: string;
    name: string;
  } | null>(null);
  const [feedWriterNotice, setFeedWriterNotice] = useState('');
  const [feedRevision, setFeedRevision] = useState(0);
  const [invite, setInvite] = useState('');
  const [inviteExpiresAt, setInviteExpiresAt] = useState<number | null>(null);
  const controlsDialog = useRef<HTMLDialogElement>(null);
  const [inviteCopy, setInviteCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inviteText = useRef<HTMLTextAreaElement>(null);
  const membersPanel = useRef<HTMLDetailsElement>(null);
  const [membershipError, setMembershipError] = useState('');
  const [busy, setBusy] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [advancedLoaded, setAdvancedLoaded] = useState(false);
  const [gitLoaded, setGitLoaded] = useState(false);
  const [gitRevision, setGitRevision] = useState(0);
  const [gitConnectionTarget, setGitConnectionTarget] = useState<HTMLDivElement | null>(null);
  const [gitAdvancedTarget, setGitAdvancedTarget] = useState<HTMLDivElement | null>(null);
  const [nativeControlsTarget, setNativeControlsTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const dialog = controlsDialog.current;
    if (!dialog) return;
    if (controlsOpen && !dialog.open) dialog.showModal();
    else if (!controlsOpen && dialog.open) dialog.close();
  }, [controlsOpen, selected?.group.handle]);
  const authorizationRequired = useCallback(() => setControlsOpen(true), []);
  const changed = useCallback(() => setFeedRevision((n) => n + 1), []);
  const load = useCallback(async (force = false) => {
    if (!active.current || (listRead.current && !force)) return;
    if (force) listRead.current?.abort();
    const controller = new AbortController();
    listRead.current = controller;
    try {
      const value = contracts.groupHostListSchema.parse(
        await request('groups', undefined, controller.signal),
      );
      if (controller.signal.aborted) return;
      setList(value.groups);
      setRemoved(value.removed ?? []);
      setService(value.service.message);
      setLocalReceiptStorage(value.service.localReceiptStorage);
      setServiceConfigured(value.service.configured);
      setSetupCodeRequired(value.service.setupCodeRequired ?? false);
      setNative(
        value.native.authState === 'per-context'
          ? `${value.native.message} Sign-in is checked separately for each isolated group context.`
          : value.native.message,
      );
      setListError('');
      return value;
    } catch (reason) {
      if (!controller.signal.aborted) setListError(message(reason));
      if (force) throw reason;
    } finally {
      if (listRead.current === controller) listRead.current = null;
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      listRead.current?.abort();
      listRead.current = null;
    };
  }, [load]);
  const refreshLocalList = async () => {
    const value = await load(true);
    if (!value)
      throw new Error('The current Groups list could not be read. Check the saved change.');
    return value;
  };
  const handle = route.startsWith('chats/groups') ? route.split('/')[2] : route.split('/')[1];
  useEffect(() => {
    if (handle) return;
    const refresh = () => {
      if (!document.hidden) void load();
    };
    // The setup agent writes configuration outside this tab. Observe it until ready;
    // this is a local status read, not a provider launch or Cloudflare request.
    const timer = serviceConfigured !== true ? window.setInterval(refresh, 5000) : undefined;
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [handle, serviceConfigured, load]);
  useEffect(() => {
    let alive = true;
    setSelected(null);
    setControlsOpen(false);
    setAdvancedLoaded(false);
    setGitLoaded(false);
    setGitRevision(0);
    setInvite('');
    setInviteCopy('idle');
    setError('');
    if (!handle) return;
    void request('open', { handle })
      .then((raw) => {
        if (alive) setSelected(contracts.groupHostOpenSchema.parse(raw));
      })
      .catch((reason) => {
        if (alive) setError(message(reason));
      });
    return () => {
      alive = false;
    };
  }, [handle]);
  // Keep joined members current without launching a model or remounting chats.
  const localGroup =
    list?.find((group) => group.handle === selected?.group.handle) ?? selected?.group;
  const creatorHandle = selected?.feedWriter?.canSelect ? selected.group.handle : undefined;
  const membershipHandle = selected?.group.handle;
  useEffect(() => {
    if (!membershipHandle) return;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (document.hidden || controller) return;
      const read = new AbortController();
      controller = read;
      try {
        const value = contracts.groupHostOpenSchema.parse(
          await request('open', { handle: membershipHandle }, read.signal),
        );
        if (read.signal.aborted) return;
        setSelected(value);
        setMembershipError('');
      } catch (reason) {
        if (!read.signal.aborted) setMembershipError(message(reason));
      } finally {
        if (controller === read) controller = undefined;
      }
    };
    const stop = startGroupPolling(refresh, {
      idleMs: GROUP_POLLING.rosterMs,
      activeMs: GROUP_POLLING.rosterMs,
      immediate: false,
      updates: selected ? groupPollingUpdates(selected.member) : undefined,
    });
    return () => {
      stop();
      controller?.abort();
    };
  }, [membershipHandle]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (reason) {
      if (canReplaceSetupCode(reason)) setNewSetupCodeAllowed(true);
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  const shared = selected?.shared.handle,
    privateHandle = selected?.private.handle;
  const loadPage = useCallback(
    async (query: GroupFeedQuery, signal: AbortSignal) => {
      try {
        return {
          kind: 'ready' as const,
          value: groupFeedPageSchema.parse(
            await request('feed', { handle: shared, query }, signal),
          ),
        };
      } catch (reason) {
        return readError(reason);
      }
    },
    [shared, feedRevision],
  );
  const loadOriginal = useCallback(
    async (event: GroupEvent, signal: AbortSignal) => {
      try {
        return {
          kind: 'ready' as const,
          value: contracts.groupHostOriginalResultSchema.parse(
            await request('original', { handle: shared, eventId: event.eventId }, signal),
          ),
        };
      } catch (reason) {
        return readError(reason);
      }
    },
    [shared],
  );
  const catchUp = useCallback(
    async (signal: AbortSignal) => {
      try {
        return {
          kind: 'ready' as const,
          value: contracts.groupHostCatchUpSchema.parse(
            await request('catch-up', { handle: privateHandle }, signal),
          ).text,
        };
      } catch (reason) {
        return readError(reason);
      }
    },
    [privateHandle],
  );
  return (
    <section className={`flow-page main-chat groups-main-chat${handle ? ' has-selection' : ''}`}>
      <aside className="chat-list" aria-label="Conversations">
        {listHeader}
        <GroupsLanding
          selectedId={selected?.group.id}
          query={query}
          onSetup={() => setSetupOpen(true)}
          setupRequired={serviceConfigured === false}
          joinReceipt={
            joinReceipt && (
              <GroupJoinReceipt key={joinReceipt.handle} receipt={joinReceipt} onApproved={load} />
            )
          }
          setupCodeRequired={setupCodeRequired}
          onNewSetupCode={
            newSetupCodeAllowed
              ? () => {
                  // Offered only after a definitive service creation rejection.
                  // The old host receipt and bearer remain retained.
                  sessionStorage.removeItem(`swa:groups:${apiScope()}:create`);
                  setNewSetupCodeAllowed(false);
                  setError('');
                }
              : undefined
          }
          removedGroups={
            removed.length > 0 && (
              <details className="groups-removed-list">
                <summary>Removed groups ({removed.length})</summary>
                <p>Hidden only on this computer. Membership, messages and work are retained.</p>
                {removed.map((group) => (
                  <div key={group.handle} className="groups-removed-row">
                    <strong>
                      <DisplayName value={group.name} />
                    </strong>
                    <GroupLocalVisibility group={group} restore refresh={refreshLocalList} />
                  </div>
                ))}
              </details>
            )
          }
          groups={
            list
              ? {
                  kind: 'ready',
                  value: list.map((group) =>
                    selected?.group.id === group.id
                      ? { ...group, members: selected.members.length }
                      : group,
                  ),
                }
              : listError
                ? { kind: 'error', message: listError }
                : { kind: 'loading' }
          }
          onRetry={() => void load()}
          onOpen={(id) => {
            const group = list?.find((v) => v.id === id);
            if (group) location.hash = `#/chats/groups/${group.handle}`;
          }}
          onCreate={async (input) => {
            const submittedRevision = groupInvitationRevision();
            setNewSetupCodeAllowed(false);
            // Creation capabilities stay in memory until the authenticated host
            // receives them; tab recovery stores only the code's fingerprint.
            const setupCodeHash = input.setupCode
              ? Array.from(
                  new Uint8Array(
                    await crypto.subtle.digest(
                      'SHA-256',
                      new TextEncoder().encode(input.setupCode),
                    ),
                  ),
                )
                  .map((v) => v.toString(16).padStart(2, '0'))
                  .join('')
              : undefined;
            const operation = pending('create', {
              projectName: input.projectName,
              displayName: input.displayName,
              ...(setupCodeHash ? { setupCodeHash } : {}),
            });
            let value: contracts.GroupHostOpen;
            try {
              value = contracts.groupHostOpenSchema.parse(
                await request('create', { ...input, key: operation.key }),
              );
            } catch (reason) {
              // Local validation failed before any durable/network operation.
              // Correcting an invalid code can safely start a fresh attempt.
              if (reason instanceof ApiError && reason.code === 'GROUP_BETA_SETUP_INVALID')
                operation.clear();
              if (canReplaceSetupCode(reason)) setNewSetupCodeAllowed(true);
              throw reason;
            }
            operation.clear();
            if (groupInvitationRevision() === submittedRevision)
              location.hash = `#/chats/groups/${value.group.handle}`;
            void load();
          }}
          onJoin={async (input) => {
            const consumedInvitation = initialGroupInvitation();
            const submittedRevision = groupInvitationRevision();
            // Only the request identity/hash is retained in browser storage. Invitation secrets remain in memory until the authenticated host receives them.
            const hash = Array.from(
              new Uint8Array(
                await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.invitation)),
              ),
            )
              .map((v) => v.toString(16).padStart(2, '0'))
              .join('');
            const operation = pending('join', {
              displayName: input.displayName,
              invitationHash: hash,
            });
            let value: ReturnType<typeof contracts.groupHostJoinResultSchema.parse>;
            try {
              value = contracts.groupHostJoinResultSchema.parse(
                await request('join', { ...input, key: operation.key }),
              );
            } catch (reason) {
              // These failures occur before a durable join or network request.
              // Keep uncertain acknowledgements, but allow correcting bad input.
              if (
                reason instanceof ApiError &&
                ['INVALID_INVITATION', 'GROUP_SETUP_REQUIRED'].includes(reason.code ?? '')
              )
                operation.clear();
              throw reason;
            }
            operation.clear();
            const stillCurrent = groupInvitationRevision() === submittedRevision;
            if (stillCurrent && initialGroupInvitation() === consumedInvitation) {
              clearGroupInvitation();
              setInvitation(null);
            }
            setJoinNotice('');
            if (stillCurrent) {
              if (value.group.state === 'active')
                location.hash = `#/chats/groups/${value.group.handle}`;
              else setJoinReceipt({ handle: value.group.handle, name: value.group.name });
            }
            void load();
          }}
          initialInvitation={invitation ?? undefined}
          invitationRevision={invitationRevision}
        />
        {list && listError && (
          <div className="chat-list-empty" role="alert">
            <p>{listError}</p>
            <button className="flow-button" onClick={() => void load()}>
              Retry groups
            </button>
          </div>
        )}
      </aside>
      <div className="chat-pane">
        <div className="group-host-root">
          {!selected && listError && <p role="alert">{listError}</p>}
          {error && !controlsOpen && <p role="alert">{error}</p>}
          {selected && membershipError && (
            <p role="status">Members could not refresh: {membershipError}</p>
          )}
          {joinNotice && (
            <p role="status" className="group-host-notice">
              {joinNotice}
            </p>
          )}
          {handle && !selected ? (
            <div className="chat-pane-empty">
              <p role="status">{error ? 'This group could not open.' : 'Opening group…'}</p>
              <a href="#/chats/groups">Back to groups</a>
            </div>
          ) : !selected ? (
            <div className="chat-pane-empty">
              <h2>Choose a group</h2>
              <p>Chat together, or ask your agent to move the shared work forward.</p>
            </div>
          ) : (
            <>
              <dialog
                key={selected.group.handle}
                ref={controlsDialog}
                className="group-host-controls"
                aria-labelledby="group-controls-title"
                onCancel={() => setControlsOpen(false)}
                onClose={() => setControlsOpen(false)}
              >
                <div className="modal-heading">
                  <h2 id="group-controls-title">Manage group</h2>
                  <button className="secondary" onClick={() => setControlsOpen(false)}>
                    Done
                  </button>
                </div>
                {controlsOpen && error && <p role="alert">{error}</p>}
                <details className="group-host-members" ref={membersPanel} hidden={!creatorHandle}>
                  <summary>Invite people</summary>
                  <p>
                    Create an invitation and send it privately. The other person uses their own
                    sciencewithagents app and account. New users can start with the{' '}
                    <a
                      href="https://github.com/OscarBarreraGithub/sciencewithagents#groups-beta"
                      target="_blank"
                      rel="noreferrer"
                    >
                      setup guide
                    </a>
                    .
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const operation = pending(`invite:${selected.group.handle}`, {});
                        const value = contracts.groupHostInviteResultSchema.parse(
                          await request('invite', {
                            handle: selected.group.handle,
                            key: operation.key,
                          }),
                        );
                        operation.clear();
                        setInvite(groupInvitationUrl(value.fragment, location.origin));
                        setInviteExpiresAt(value.expiresAt);
                        setInviteCopy('idle');
                      })
                    }
                  >
                    {invite ? 'Create a fresh invitation' : 'Create invitation'}
                  </button>
                  {invite && (
                    <>
                      <label>
                        Invitation link
                        <textarea
                          ref={inviteText}
                          aria-label="Invitation link"
                          readOnly
                          value={invite}
                          rows={2}
                        />
                      </label>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(invite);
                            setInviteCopy('copied');
                          } catch {
                            inviteText.current?.focus();
                            inviteText.current?.select();
                            setInviteCopy('failed');
                          }
                        }}
                      >
                        {inviteCopy === 'copied' ? 'Invitation copied' : 'Copy invitation'}
                      </button>
                      {inviteCopy === 'failed' && (
                        <p role="status">
                          Copy did not work. The invitation is selected; copy it by hand.
                        </p>
                      )}
                      {inviteExpiresAt && (
                        <p>Valid until {new Date(inviteExpiresAt).toLocaleString()}.</p>
                      )}
                      <p>
                        They give this invitation to their setup agent, then open{' '}
                        <strong>Chats → Groups → Join group</strong> in their own app. The same link
                        can invite multiple people. No confirmation code or approval is needed.
                      </p>
                    </>
                  )}
                  {selected.members
                    .filter((m) => m.installationId !== selected.member.installationId)
                    .map((m) => (
                      <button
                        key={m.installationId}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const operation = pending(
                              `revoke:${selected.group.handle}:${m.installationId}`,
                              {},
                            );
                            await request('revoke', {
                              handle: selected.group.handle,
                              key: operation.key,
                              requestId: m.installationId,
                            });
                            operation.clear();
                            setSelected(
                              contracts.groupHostOpenSchema.parse(
                                await request('open', { handle: selected.group.handle }),
                              ),
                            );
                          })
                        }
                      >
                        Remove {m.displayName}
                      </button>
                    ))}
                </details>
                {selected.native.executionMode === 'host' && (
                  <GroupWorkFolder
                    key={`work-folder:${selected.shared.handle}`}
                    handle={selected.shared.handle}
                    onOpen={() => setGitLoaded(true)}
                    onBound={() => {
                      setGitLoaded(true);
                      setGitRevision((value) => value + 1);
                    }}
                    connection={<div ref={setGitConnectionTarget} />}
                  />
                )}
                {selected.native.executionMode === 'host' && (gitLoaded || advancedLoaded) && (
                  <GroupNativeGitPanel
                    key={`native-git:${selected.shared.handle}`}
                    handle={selected.shared.handle}
                    connectionTarget={gitConnectionTarget}
                    advancedTarget={gitAdvancedTarget}
                    refreshKey={gitRevision}
                  />
                )}
                <div ref={setNativeControlsTarget} />
                <GroupLocalVisibility
                  key={`local-visibility:${selected.group.handle}`}
                  group={localGroup ?? selected.group}
                  refresh={refreshLocalList}
                  onSettled={(current) => {
                    if (current.removed?.some((group) => group.handle === selected.group.handle)) {
                      setControlsOpen(false);
                      location.hash = '#/chats/groups';
                    }
                  }}
                />
                <details
                  className="group-host-members group-host-advanced"
                  onToggle={(event) => {
                    if (event.currentTarget.open) setAdvancedLoaded(true);
                  }}
                >
                  <summary>Advanced</summary>
                  <p>
                    Review shared action proposals, inspect repository details or make a private
                    backup. Ordinary messages and report reading do not need these controls.
                  </p>
                  {advancedLoaded && (
                    <>
                      {localReceiptStorage && (
                        <GroupLocalReceiptStorage storage={localReceiptStorage} />
                      )}
                      {selected.native.executionMode === 'host' && (
                        <details className="group-host-members">
                          <summary>Git sync and reviewed changes</summary>
                          <div ref={setGitAdvancedTarget} />
                        </details>
                      )}
                      <details className="group-host-members group-host-actions">
                        <summary>Review proposed shared actions</summary>
                        <p>
                          Your agent’s saved proposals are listed here. Review the exact instruction
                          before confirming work on its owner’s computer.
                        </p>
                        <GroupActionsBoard
                          key={`actions:${selected.shared.handle}`}
                          handle={selected.shared.handle}
                          actor={selected.member}
                        />
                      </details>
                      {selected.native.executionMode !== 'host' && (
                        <>
                          <GroupGitPanel
                            key={`git:${selected.shared.handle}`}
                            handle={selected.shared.handle}
                          />
                        </>
                      )}
                      <GroupReports
                        key={`reports:${selected.shared.handle}`}
                        handle={selected.shared.handle}
                      />
                      {creatorHandle && (
                        <GroupHostedExport
                          key={`hosted-export:${creatorHandle}`}
                          handle={creatorHandle}
                        />
                      )}
                      <details className="group-host-members">
                        <summary>Summary computer for older activity</summary>
                        <p>
                          Shared messages and reports arrive without this setting. This optional
                          older workflow summarizes retained activity on the selected computer and
                          uses that person’s provider allowance. It is separate from per-member
                          message summaries.
                        </p>
                        <p role="status">{selected.feedWriter?.message}</p>
                        {selected.feedWriter?.canSelect && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const operation = pending(
                                  `feed-writer:${selected.group.handle}`,
                                  {},
                                );
                                await request('feed-writer', {
                                  handle: selected.shared.handle,
                                  key: operation.key,
                                });
                                operation.clear();
                                setFeedWriterNotice(
                                  'This computer is the shared feed writer. Summaries wait while its agent is unavailable.',
                                );
                                setSelected(
                                  contracts.groupHostOpenSchema.parse(
                                    await request('open', { handle: selected.group.handle }),
                                  ),
                                );
                              })
                            }
                          >
                            Use my agent to summarize older activity
                          </button>
                        )}
                        {feedWriterNotice && <p role="status">{feedWriterNotice}</p>}
                      </details>
                    </>
                  )}
                </details>
              </dialog>
              <div className="group-host-workspace">
                <GroupsWorkspace
                  contributionControl={
                    <GroupContributionMode
                      key={`local-mode:${selected.group.handle}`}
                      group={localGroup ?? selected.group}
                      refresh={refreshLocalList}
                    />
                  }
                  onManage={() => setControlsOpen(true)}
                  onInvite={
                    creatorHandle
                      ? () => {
                          setControlsOpen(true);
                          if (membersPanel.current) membersPanel.current.open = true;
                          requestAnimationFrame(() => {
                            membersPanel.current?.parentElement?.scrollTo({ top: 0 });
                            membersPanel.current
                              ?.querySelector('summary')
                              ?.focus({ preventScroll: true });
                          });
                        }
                      : undefined
                  }
                  refreshableFeed
                  group={selected.group}
                  memberId={selected.member.memberId}
                  members={selected.members}
                  access="authorized"
                  sharedChat={{
                    groupId: selected.group.id,
                    memberId: selected.member.memberId,
                    sessionId: selected.shared.context.sessionId,
                    visibility: 'shared',
                    draftIdentity: selected.shared.handle,
                    content: (mode: GroupChatMode) => (
                      <GroupConversation
                        mode={mode}
                        sharedFeed={{ loadPage, loadOriginal, members: selected.members }}
                        slot={selected.shared}
                        readOnly={localGroup?.local?.mode === 'read-only'}
                        executionMode={selected.native.executionMode}
                        sharedHandle={selected.shared.handle}
                        onChanged={changed}
                        nativeControlsTarget={nativeControlsTarget}
                        onAuthorizationRequired={authorizationRequired}
                      />
                    ),
                  }}
                  privateAside={null}
                  loadPage={loadPage}
                  loadOriginal={loadOriginal}
                  catchUp={catchUp}
                  onBack={() => {
                    location.hash = '#/chats/groups';
                    void load();
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {setupOpen && (
        <Modal
          title="Group setup"
          className="group-host-controls group-setup-dialog"
          close={() => setSetupOpen(false)}
        >
          {error && <p role="alert">{error}</p>}
          {joinNotice && <p role="status">{joinNotice}</p>}
          <GroupSetupPrompt folderSetup={<GroupWorkFolder />} />
          {hasPendingSetup() && (
            <details className="group-host-recovery">
              <summary>Recover an interrupted request</summary>
              <p>
                Check whether your earlier create or join request finished without starting another.
              </p>
              <button
                onClick={() =>
                  void act(async () => {
                    for (const kind of ['create', 'join'] as const) {
                      const storage = `swa:groups:${apiScope()}:${kind}`;
                      const saved = JSON.parse(sessionStorage.getItem(storage) ?? 'null') as {
                        key: string;
                      } | null;
                      if (!saved) continue;
                      const value = contracts.groupHostResumeResultSchema.parse(
                        await request('resume', { key: saved.key, kind }),
                      );
                      sessionStorage.removeItem(storage);
                      if (value.group.state === 'pending')
                        setJoinReceipt({ handle: value.group.handle, name: value.group.name });
                      else location.hash = `#/chats/groups/${value.group.handle}`;
                      void load();
                      return;
                    }
                    setJoinNotice(
                      'No pending setup request in this tab. Create a group or paste an invitation.',
                    );
                  })
                }
              >
                Recover pending setup
              </button>
            </details>
          )}
          {
            <details className="group-host-status">
              <summary>Connection details</summary>
              <p>{service}</p>
              <p>{native}</p>
              <a className="flow-button" href="#/welcome">
                Open setup checks
              </a>
            </details>
          }
        </Modal>
      )}
    </section>
  );
}
