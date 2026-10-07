import type { ReactNode } from 'react';
import type {
  GroupEvent,
  GroupFeedPage,
  GroupFeedQuery,
  GroupId,
  GroupMember,
  GroupMemberId,
  GroupSessionId,
} from '@dock/shared';

export type GroupRead<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'offline'; message: string }
  | { kind: 'revoked'; message: string }
  | { kind: 'error'; message: string };
export type GroupSummary = { id: GroupId; name: string; members: number; sync: string };
export type GroupsLandingProps = {
  initialInvitation?: string;
  setupCodeRequired?: boolean;
  onNewSetupCode?: () => void;
  groups: GroupRead<readonly GroupSummary[]> | { kind: 'loading' };
  onOpen: (id: GroupId) => void;
  onCreate: (input: {
    projectName: string;
    displayName: string;
    setupCode?: string;
  }) => Promise<void>;
  onJoin: (input: { invitation: string; displayName: string }) => Promise<void>;
  onRetry: () => void;
};
/** Supplied by an authenticated host. Labels and initials confer no authority. */
export type GroupChatSlot = {
  groupId: GroupId;
  memberId: GroupMemberId;
  sessionId: GroupSessionId;
  visibility: 'shared' | 'private';
  draftIdentity: string;
  content: ReactNode;
};
export type GroupsWorkspaceProps = {
  chatTitle?: string;
  privateDescription?: string;
  sharedDescription?: string;
  refreshableFeed?: boolean;
  group: GroupSummary;
  memberId: GroupMemberId;
  members: readonly GroupMember[];
  access: 'authorized' | 'revoked';
  sharedChat: GroupChatSlot;
  privateAside: GroupChatSlot | null;
  loadPage: (query: GroupFeedQuery, signal: AbortSignal) => Promise<GroupRead<GroupFeedPage>>;
  loadOriginal: (
    event: GroupEvent,
    signal: AbortSignal,
  ) => Promise<GroupRead<{ eventId: GroupEvent['eventId']; text: string }>>;
  catchUp: (signal: AbortSignal) => Promise<GroupRead<string>>;
  catchUpView?: (close: () => void) => ReactNode;
  onBack: () => void;
};
