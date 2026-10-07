import { GroupReports } from './GroupReports';
import { GroupSetupPrompt } from './GroupSetupPrompt';
import { GroupJoinReceipt } from './GroupJoinReceipt';
import { GroupGitPanel } from './GroupGitPanel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { groupFeedPageSchema, type GroupEvent, type GroupFeedQuery } from '@dock/shared';
import * as contracts from '@dock/shared/dist/group-host.js';
import { api, apiScope, ApiError } from '../api';
import { GroupsLanding } from './GroupsLanding';
import { GroupsWorkspace } from './GroupsWorkspace';
import { GroupChat } from './GroupChat';
import { GroupActionsBoard } from './GroupActionsBoard';
import { GroupCatchup } from './GroupCatchup';
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
function GroupConversation({
  slot,
  onChanged,
  nativeControlsTarget,
  onAuthorizationRequired,
  sharedHandle,
  executionMode,
}: {
  slot: contracts.GroupHostSlot;
  onChanged: () => void;
  nativeControlsTarget: HTMLDivElement | null;
  onAuthorizationRequired: () => void;
  sharedHandle: string;
  executionMode?: 'host' | 'isolated';
}) {
  return (
    <GroupDocumentScope handle={slot.handle} sharedHandle={sharedHandle}>
      <GroupChat
        slot={slot}
        executionMode={executionMode}
        request={request}
        onChanged={onChanged}
        nativeControlsTarget={nativeControlsTarget}
        onAuthorizationRequired={onAuthorizationRequired}
      />
      <GroupDocumentHost reader={PdfReader} />
    </GroupDocumentScope>
  );
}
export function GroupsApp({ route }: { route: string }) {
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
  const [service, setService] = useState('Loading Groups configuration…');
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
    confirmation: string;
  } | null>(null);
  const [feedWriterNotice, setFeedWriterNotice] = useState('');
  const [feedRevision, setFeedRevision] = useState(0);
  const [invite, setInvite] = useState('');
  const [inviteCopy, setInviteCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inviteText = useRef<HTMLTextAreaElement>(null);
  const membersPanel = useRef<HTMLDetailsElement>(null);
  const requestsHeading = useRef<HTMLHeadingElement>(null);
  const [requests, setRequests] = useState<{ requestId: string; displayName: string }[]>([]);
  const [requestsError, setRequestsError] = useState('');
  const [requestsRevision, setRequestsRevision] = useState(0);
  const [approvalNotice, setApprovalNotice] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [approvalId, setApprovalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [nativeControlsTarget, setNativeControlsTarget] = useState<HTMLDivElement | null>(null);
  const authorizationRequired = useCallback(() => setControlsOpen(true), []);
  const changed = useCallback(() => setFeedRevision((n) => n + 1), []);
  const privateChanged = useCallback(() => {}, []);
  const load = useCallback(async () => {
    if (!active.current || listRead.current) return;
    const controller = new AbortController();
    listRead.current = controller;
    try {
      const value = contracts.groupHostListSchema.parse(
        await request('groups', undefined, controller.signal),
      );
      if (controller.signal.aborted) return;
      setList(value.groups);
      setService(value.service.message);
      setServiceConfigured(value.service.configured);
      setSetupCodeRequired(value.service.setupCodeRequired ?? false);
      setNative(
        value.native.authState === 'per-context'
          ? `${value.native.message} Sign-in is checked separately for each isolated group context.`
          : value.native.message,
      );
      setListError('');
    } catch (reason) {
      if (!controller.signal.aborted) setListError(message(reason));
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
  const handle = route.split('/')[1];
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
    setInvite('');
    setInviteCopy('idle');
    setRequests([]);
    setError('');
    setRequestsError('');
    setApprovalNotice('');
    setApprovalId('');
    setConfirmation('');
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
  // This existing host capability is creator-only. Members must not poll an
  // endpoint they cannot read. These bounded reads never launch a model.
  const creatorHandle = selected?.feedWriter?.canSelect ? selected.group.handle : undefined;
  useEffect(() => {
    if (!creatorHandle) return;
    let controller: AbortController | undefined;
    const refresh = async () => {
      if (document.hidden || controller) return;
      const read = new AbortController();
      controller = read;
      try {
        const value = contracts.groupHostPendingSchema.parse(
          await request('pending', { handle: creatorHandle }, read.signal),
        );
        if (read.signal.aborted) return;
        setRequests(value.requests);
        setRequestsError('');
      } catch (reason) {
        if (!read.signal.aborted) setRequestsError(message(reason));
      } finally {
        if (controller === read) controller = undefined;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
      controller?.abort();
    };
  }, [creatorHandle, requestsRevision]);
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
    <div className="group-host-root">
      {!selected && listError && <p role="alert">{listError}</p>}
      {error && <p role="alert">{error}</p>}
      {joinNotice && (
        <p role="status" className="group-host-notice">
          {joinNotice}
        </p>
      )}
      {!selected ? (
        <GroupsLanding
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
          groups={
            list
              ? { kind: 'ready', value: list }
              : listError
                ? { kind: 'error', message: listError }
                : { kind: 'loading' }
          }
          onRetry={() => void load()}
          onOpen={(id) => {
            const group = list?.find((v) => v.id === id);
            if (group) location.hash = `#/groups/${group.handle}`;
          }}
          onCreate={async (input) => {
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
            location.hash = `#/groups/${value.group.handle}`;
            void load();
          }}
          onJoin={async (input) => {
            const consumedInvitation = initialGroupInvitation();
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
            if (initialGroupInvitation() === consumedInvitation) {
              clearGroupInvitation();
              setInvitation(null);
            }
            setJoinNotice('');
            setJoinReceipt({
              handle: value.group.handle,
              name: value.group.name,
              confirmation: value.confirmation,
            });
            void load();
          }}
          initialInvitation={invitation ?? undefined}
          invitationRevision={invitationRevision}
        />
      ) : (
        <>
          <details
            key={selected.group.handle}
            className="group-host-controls"
            open={controlsOpen}
            onToggle={(event) => setControlsOpen(event.currentTarget.open)}
          >
            <summary>Group controls</summary>
            <details className="group-host-members" ref={membersPanel} hidden={!creatorHandle}>
              <summary>Invitations and approval</summary>
              {approvalNotice && <p role="status">{approvalNotice}</p>}
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
                    setInviteCopy('idle');
                  })
                }
              >
                {invite ? 'Create a fresh invitation' : 'Create invitation'}
              </button>
              {invite && (
                <>
                  <label>
                    Invitation (expires in 15 minutes)
                    <textarea
                      ref={inviteText}
                      aria-label="Invitation (expires in 15 minutes)"
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
                  <p>
                    They give this invitation to their setup agent, then open{' '}
                    <strong>Groups → Join by invitation</strong> in their own app. They send you a
                    confirmation code; select their name in the requests below, and paste that code
                    to approve them.
                  </p>
                </>
              )}
              {creatorHandle && (
                <>
                  <h3 ref={requestsHeading}>
                    Join requests{requests.length > 0 ? ` · ${requests.length}` : ''}
                  </h3>
                  <button disabled={busy} onClick={() => setRequestsRevision((value) => value + 1)}>
                    Refresh join requests
                  </button>
                  {requestsError && (
                    <p role="alert">Could not check join requests: {requestsError}</p>
                  )}
                  {!requests.length && !requestsError && (
                    <p>No pending requests. This updates automatically.</p>
                  )}
                  {requests.map((r) => (
                    <label key={r.requestId}>
                      <input
                        type="radio"
                        name="request"
                        checked={approvalId === r.requestId}
                        onChange={() => setApprovalId(r.requestId)}
                      />
                      {r.displayName}
                    </label>
                  ))}
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
                        Remove enrollment: {m.displayName}
                      </button>
                    ))}
                  {!!requests.length && (
                    <>
                      <label>
                        Exact confirmation code from the member
                        <input
                          value={confirmation}
                          autoComplete="off"
                          onChange={(e) => setConfirmation(e.target.value)}
                          maxLength={64}
                        />
                      </label>
                      <button
                        disabled={busy || !approvalId || confirmation.length !== 64}
                        onClick={() =>
                          void act(async () => {
                            const hash = Array.from(
                              new Uint8Array(
                                await crypto.subtle.digest(
                                  'SHA-256',
                                  new TextEncoder().encode(confirmation),
                                ),
                              ),
                            )
                              .map((v) => v.toString(16).padStart(2, '0'))
                              .join('');
                            const operation = pending(`approve:${selected.group.handle}`, {
                              requestId: approvalId,
                              hash,
                            });
                            await request('approve', {
                              handle: selected.group.handle,
                              key: operation.key,
                              requestId: approvalId,
                              confirmation,
                            });
                            operation.clear();
                            const approvedName =
                              requests.find((r) => r.requestId === approvalId)?.displayName ??
                              'Member';
                            setApprovalNotice(
                              `${approvedName} approved. They can now open the group.`,
                            );
                            setConfirmation('');
                            setRequests((items) => items.filter((r) => r.requestId !== approvalId));
                            setApprovalId('');
                            setRequestsRevision((value) => value + 1);
                            setSelected(
                              contracts.groupHostOpenSchema.parse(
                                await request('open', { handle: selected.group.handle }),
                              ),
                            );
                          })
                        }
                      >
                        Approve exact enrollment
                      </button>
                    </>
                  )}
                </>
              )}
            </details>
            {selected.native.executionMode !== 'host' && (
              <>
                <details className="group-host-members group-host-actions">
                  <summary>Shared work and actions</summary>
                  <GroupActionsBoard key={selected.shared.handle} handle={selected.shared.handle} />
                </details>
                <GroupGitPanel key={selected.shared.handle} handle={selected.shared.handle} />
                <GroupReports key={selected.shared.handle} handle={selected.shared.handle} />
              </>
            )}
            <details className="group-host-members">
              <summary>Shared feed agent</summary>
              <p>
                The creator chooses the computer that condenses shared sources. Originals stay
                available, and pending summaries resume when that computer reconnects.
              </p>
              <p role="status">{selected.feedWriter?.message}</p>
              {selected.feedWriter?.canSelect && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const operation = pending(`feed-writer:${selected.group.handle}`, {});
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
                  Use this computer for the shared feed
                </button>
              )}
              {feedWriterNotice && <p role="status">{feedWriterNotice}</p>}
            </details>
            <div ref={setNativeControlsTarget} />
          </details>
          <div className="group-host-workspace">
            <GroupsWorkspace
              pendingRequests={requests.length}
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
                        if (requests.length)
                          requestsHeading.current?.scrollIntoView({ block: 'start' });
                      });
                    }
                  : undefined
              }
              refreshableFeed
              chatTitle="Shared chat"
              privateDescription="Saved on this computer. Private history, drafts and files are not automatically shared."
              sharedDescription="Messages you send here are shared with this group. Each person uses their own agent."
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
                content: (
                  <GroupConversation
                    slot={selected.shared}
                    executionMode={selected.native.executionMode}
                    sharedHandle={selected.shared.handle}
                    onChanged={changed}
                    nativeControlsTarget={nativeControlsTarget}
                    onAuthorizationRequired={authorizationRequired}
                  />
                ),
              }}
              privateAside={{
                groupId: selected.group.id,
                memberId: selected.member.memberId,
                sessionId: selected.private.context.sessionId,
                visibility: 'private',
                draftIdentity: selected.private.handle,
                content: (
                  <GroupConversation
                    slot={selected.private}
                    executionMode={selected.native.executionMode}
                    sharedHandle={selected.shared.handle}
                    onChanged={privateChanged}
                    nativeControlsTarget={nativeControlsTarget}
                    onAuthorizationRequired={authorizationRequired}
                  />
                ),
              }}
              loadPage={loadPage}
              loadOriginal={loadOriginal}
              catchUp={catchUp}
              catchUpView={(close) => (
                <GroupCatchup
                  handle={selected.private.handle}
                  onClose={close}
                  members={selected.members.map((member) => ({
                    id: member.memberId,
                    name: member.displayName,
                  }))}
                />
              )}
              onBack={() => {
                location.hash = '#/groups';
                void load();
              }}
            />
          </div>
        </>
      )}
      {!selected && (
        <details className="group-host-recovery">
          <summary>Recover an interrupted request</summary>
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
                  if (value.confirmation)
                    setJoinReceipt({
                      handle: value.group.handle,
                      name: value.group.name,
                      confirmation: value.confirmation,
                    });
                  else location.hash = `#/groups/${value.group.handle}`;
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
      {!selected && <GroupSetupPrompt initiallyOpen={serviceConfigured === false} />}
      {!selected && (
        <details className="group-host-status">
          <summary>Connection details</summary>
          <p>{service}</p>
          <p>{native}</p>
          <a href="#/welcome">Open setup checks</a>
        </details>
      )}
    </div>
  );
}
