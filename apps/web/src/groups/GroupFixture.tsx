import { GroupChat } from './GroupChat';
import { useCallback, useEffect, useState } from 'react';
import { groupFeedPageSchema, type GroupEvent, type GroupFeedQuery } from '@dock/shared';
import {
  groupFixtureCreateSchema,
  groupFixtureListSchema,
  groupFixtureErrorSchema,
  groupFixtureOriginalResultSchema,
  groupFixtureCatchUpSchema,
  groupFixtureOpenSchema,
  type GroupFixtureOpen,
  type GroupFixtureSummary,
} from '@dock/shared/dist/group-fixture.js';
import { ApiError } from '../api';
import { GroupsLanding } from './GroupsLanding';
import { GroupsWorkspace } from './GroupsWorkspace';
import type { GroupRead } from './types';
import './group-fixture.css';

class FixtureHttpError extends ApiError {
  constructor(status: number, message: string) {
    super(message, status);
  }
}

async function request(path: string, body?: unknown, signal?: AbortSignal, token?: string) {
  const response = await fetch(`/api/group-fixture/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new FixtureHttpError(response.status, groupFixtureErrorSchema.parse(value).error);
  return value;
}
const errorText = (value: unknown) =>
  value instanceof Error ? value.message : 'Test host unavailable. Retry when it is running.';

export function GroupFixture() {
  const [groups, setGroups] = useState<
    GroupRead<readonly GroupFixtureSummary[]> | { kind: 'loading' }
  >({ kind: 'loading' });
  const [selected, setSelected] = useState<GroupFixtureOpen | null>(null);
  const [openError, setOpenError] = useState('');
  const [large, setLarge] = useState(false);
  const [feedRevision, setFeedRevision] = useState(0);
  const changed = useCallback(() => setFeedRevision((n) => n + 1), []);
  const privateChanged = useCallback(() => {}, []);
  const load = useCallback(async () => {
    try {
      const token = new URLSearchParams(location.hash.slice(1)).get('fixture');
      if (token) {
        await request('connect', {}, undefined, token);
        history.replaceState(null, '', location.pathname);
      }
      const result = groupFixtureListSchema.parse(await request('groups'));
      setGroups({ kind: 'ready', value: result.groups });
    } catch (reason) {
      setGroups({ kind: 'error', message: errorText(reason) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.documentElement.style.fontSize = large ? '150%' : '';
    return () => {
      document.documentElement.style.fontSize = '';
    };
  }, [large]);
  const open = async (handle: string) => {
    try {
      setSelected(groupFixtureOpenSchema.parse(await request('open', { handle })));
      setOpenError('');
    } catch (reason) {
      setOpenError(errorText(reason));
    }
  };
  const shared = selected?.shared.handle;
  const privateHandle = selected?.private.handle;
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
        return { kind: 'error' as const, message: errorText(reason) };
      }
    },
    [shared, feedRevision],
  );
  const loadOriginal = useCallback(
    async (event: GroupEvent, signal: AbortSignal) => {
      try {
        return {
          kind: 'ready' as const,
          value: groupFixtureOriginalResultSchema.parse(
            await request('original', { handle: shared, eventId: event.eventId }, signal),
          ),
        };
      } catch (reason) {
        return { kind: 'error' as const, message: errorText(reason) };
      }
    },
    [shared],
  );
  const catchUp = useCallback(
    async (signal: AbortSignal) => {
      try {
        return {
          kind: 'ready' as const,
          value: groupFixtureCatchUpSchema.parse(
            await request('catch-up', { handle: privateHandle }, signal),
          ).text,
        };
      } catch (reason) {
        return { kind: 'error' as const, message: errorText(reason) };
      }
    },
    [privateHandle],
  );
  return (
    <div className="group-fixture-root">
      <details className="group-fixture-status">
        <summary>Local test host · fake replies · no cloud sync</summary>
        <p>
          One local owner. Deterministic feed excerpts and catch-up; no LLM condensation.
          Invitations, another installation, cloud hosting, native tools and real providers are
          unavailable. This does not establish production privacy.
        </p>
        <label>
          <input type="checkbox" checked={large} onChange={(e) => setLarge(e.target.checked)} />
          150% text
        </label>
      </details>
      {openError && <p role="alert">{openError}</p>}
      <div className="group-fixture-surface">
        {!selected ? (
          <GroupsLanding
            groups={groups}
            onRetry={() => void load()}
            onOpen={(id) => {
              if (groups.kind === 'ready') {
                const value = groups.value.find((g) => g.id === id);
                if (value) void open(value.handle);
              }
            }}
            onCreate={async (input) => {
              const storage = 'swa:group-fixture:create';
              const saved = localStorage.getItem(storage);
              const pending = saved
                ? groupFixtureOpenInput(JSON.parse(saved), input)
                : { ...input, key: crypto.randomUUID() };
              localStorage.setItem(storage, JSON.stringify(pending));
              const result = groupFixtureOpenSchema.parse(await request('create', pending));
              localStorage.removeItem(storage);
              setSelected(result);
              void load();
            }}
            onJoin={async () => {
              throw new Error(
                'Invitations and cloud joining are unavailable in this local test host.',
              );
            }}
          />
        ) : (
          <GroupsWorkspace
            group={selected.group}
            memberId={selected.member.memberId}
            members={[selected.member]}
            access="authorized"
            sharedChat={{
              groupId: selected.group.id,
              memberId: selected.member.memberId,
              sessionId: selected.shared.context.sessionId,
              visibility: 'shared',
              draftIdentity: selected.shared.handle,
              content: (
                <GroupChat
                  key={selected.shared.handle}
                  request={request}
                  slot={selected.shared}
                  onChanged={changed}
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
                <GroupChat
                  key={selected.private.handle}
                  request={request}
                  slot={selected.private}
                  onChanged={privateChanged}
                />
              ),
            }}
            loadPage={loadPage}
            loadOriginal={loadOriginal}
            catchUp={catchUp}
            onBack={() => {
              setSelected(null);
              void load();
            }}
          />
        )}
      </div>
    </div>
  );
}
function groupFixtureOpenInput(
  saved: unknown,
  input: { projectName: string; displayName: string },
) {
  const parsed = groupFixtureCreateSchema.parse(saved);
  if (parsed.projectName !== input.projectName || parsed.displayName !== input.displayName)
    throw new Error(
      'A create acknowledgement is pending. Retry the same project/name before creating another.',
    );
  return parsed;
}
