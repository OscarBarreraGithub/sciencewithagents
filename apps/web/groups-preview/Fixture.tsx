import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  agentSchema,
  detailSchema,
  entrySchema,
  groupEventSchema,
  groupFeedCursorSchema,
  groupIdSchema,
  groupMemberSchema,
  groupSessionIdSchema,
  groupCategorySchema,
  type Agent,
  type Entry,
  type GroupEvent,
  type GroupFeedQuery,
  type GroupFeedPage,
} from '@dock/shared';
import { Conversation, Composer } from '../src/Conversation';
import type { SharedDraft } from '../src/useWorkspaceState';
import { GroupsLanding, GroupsWorkspace, type GroupRead, type GroupSummary } from '../src/groups';
import '../src/styles.css';
import './fixture.css';

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const date = '2026-10-06T04:00:00.000Z';
const groups: GroupSummary[] = [
  {
    id: groupIdSchema.parse(uuid(1)),
    name: 'River observations',
    members: 6,
    sync: 'Synthetic snapshot',
  },
  {
    id: groupIdSchema.parse(uuid(2)),
    name: '星の研究 · رصد النجوم',
    members: 5,
    sync: 'Synthetic snapshot',
  },
];
const member = groupMemberSchema.parse({
  groupId: groups[0].id,
  memberId: uuid(10),
  installationId: uuid(11),
  displayName: 'Amina · أمينة',
  active: true,
});
const names = ['Amina · أمينة', 'José', '李明', 'Noor\u202e\u0007', 'Zoë', 'अनन्या'];
export const exactOriginal = (index: number, group: number) =>
  index === 0
    ? `  Can we compare the river readings?\n\nKeep the original spacing.\tأمينة · 李明\nControl evidence: \u202e literal.\n${'Long source with evidence '.repeat(220)}\n${'x'.repeat(800)}\n  `
    : `Original ${index + 1} from project ${group + 1}.\n\tKeep this evidence exactly.  `;
async function eventAt(index: number, group: number, session: string): Promise<GroupEvent> {
  const original = exactOriginal(index, group);
  const bytes = new TextEncoder().encode(original);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return groupEventSchema.parse({
    eventId: uuid(100 + group * 100 + index),
    sequence: index + 1,
    scope: {
      groupId: groups[group].id,
      memberId: uuid(10 + (index % 6)),
      installationId: uuid(11),
      visibility: 'shared',
      source: {
        sessionId: session,
        provider: 'owner',
        nativeSessionId: 'synthetic-only',
        messageId: `synthetic-message-${index}`,
      },
      causalRefs: index ? [uuid(100 + group * 100)] : [],
    },
    operationId: uuid(500 + index),
    entityId: uuid(600 + index),
    revision: 1,
    category: groupCategorySchema.options[index % 8],
    condensedText: [
      'Amina asked whether the upstream and downstream readings use the same calibration.',
      'José proposed a shared chart to compare the two sampling sites.',
      'The members decided to retain both raw readings before adjusting the chart.',
      '李明 asked the agent to document the sensor calibration method.',
      'Two sampling schedules overlap; the group needs to agree on a time.',
      'The downstream sensor needs a fresh battery before the next visit.',
      'Zoë found that the morning readings were consistently cooler.',
      'अनन्या prepared the comparison table for the next discussion.',
    ][index % 8],
    evidenceRefs: [],
    corrects: null,
    manifest: {
      bytes: bytes.length,
      sha256: digest,
      chunks: [{ index: 0, bytes: bytes.length, sha256: digest }],
    },
    recordedAt: date,
  });
}
function makeAgent(id: string, name: string): Agent {
  return agentSchema.parse({
    id,
    projectId: uuid(900),
    parentId: null,
    taskId: null,
    name,
    role: 'manager',
    status: 'idle',
    model: null,
    effort: 'low',
    permission: 'workspace-write',
    checkpoint: '',
    createdAt: date,
    updatedAt: date,
  });
}
function useSyntheticDraft(identity: string): SharedDraft {
  const [text, update] = useState(
    () => sessionStorage.getItem(`groups-preview:draft:${identity}`) ?? '',
  );
  const current = useRef(text);
  return {
    text,
    currentText: () => current.current,
    setText: (value) => {
      current.current = value;
      update(value);
      sessionStorage.setItem(`groups-preview:draft:${identity}`, value);
    },
    ready: true,
    state: null,
    saving: false,
    unsaved: false,
    error: '',
    conflict: false,
    flush: async () => null,
    retry: async () => null,
    copyDraft: async () => {},
    useSavedVersion: () => {},
    keepMyVersion: () => {},
    clearSent: async () => {},
  };
}
const scrollPositions = new Map<string, number>();
function SyntheticChat({
  identity,
  privateChat,
  failSend,
}: {
  identity: string;
  privateChat: boolean;
  failSend: boolean;
}) {
  const draft = useSyntheticDraft(identity);
  const agent = useMemo(
    () =>
      makeAgent(identity, privateChat ? 'Synthetic private session' : 'Synthetic group session'),
    [identity, privateChat],
  );
  const [entries, setEntries] = useState<Entry[]>(() => {
    const saved = sessionStorage.getItem(`groups-preview:entries:${identity}`);
    if (saved) return (JSON.parse(saved) as unknown[]).map((entry) => entrySchema.parse(entry));
    return [
      entrySchema.parse({
        id: `${identity}:intro`,
        agentId: agent.id,
        runId: null,
        kind: 'assistant',
        title: agent.name,
        text: privateChat
          ? 'This is a separate synthetic private conversation. No publication callback is connected.'
          : 'We can discuss the calibration question here. This preview does not run an agent or publish shared events.',
        status: 'complete',
        createdAt: date,
      }),
    ];
  });
  useEffect(() => {
    sessionStorage.setItem(`groups-preview:entries:${identity}`, JSON.stringify(entries));
  }, [identity, entries]);
  const [error, setError] = useState('');
  const chatDetail = useMemo(
    () => detailSchema.parse({ agent, entries, runs: [], hasMore: false }),
    [agent, entries],
  );
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current?.querySelector('.conversation');
    const saved = scrollPositions.get(identity);
    const remember = () => {
      if (element && element.clientHeight > 0) scrollPositions.set(identity, element.scrollTop);
    };
    const frame = requestAnimationFrame(() => {
      if (!element) return;
      element.scrollTop = saved ?? element.scrollHeight;
      // Notify the existing timeline that this host restored an earlier reading position.
      element.dispatchEvent(new Event('scroll'));
      element.addEventListener('scroll', remember);
      remember();
    });
    return () => {
      cancelAnimationFrame(frame);
      element?.removeEventListener('scroll', remember);
    };
  }, [identity]);
  return (
    <div className="fixture-chat" ref={container}>
      <Conversation
        key={identity}
        agent={agent}
        detail={chatDetail}
        approvals={[]}
        act={async (action) => {
          try {
            await action();
          } catch (reason) {
            setError(String(reason));
          }
        }}
      />
      {error && (
        <p className="fixture-error" role="alert">
          {error}
        </p>
      )}
      <Composer
        key={identity}
        agent={agent}
        workspace={null}
        disabled={false}
        draftOverride={draft}
        send={async (text) => {
          if (failSend)
            throw new Error('Synthetic send failed. Your draft is retained; retry Send.');
          setError('');
          setEntries((previous) => [
            ...previous,
            entrySchema.parse({
              id: crypto.randomUUID(),
              agentId: agent.id,
              runId: null,
              kind: 'user',
              title: 'You',
              text,
              status: 'complete',
              createdAt: date,
            }),
          ]);
        }}
        onError={setError}
        onCommand={() => setError('Native session commands are unavailable in this preview.')}
        onStop={() => setError('No agent is running.')}
        onHelp={() => setError('Synthetic preview: native commands are unavailable.')}
        messagePlaceholder={
          privateChat ? 'Message private synthetic session…' : 'Message group synthetic session…'
        }
      />
    </div>
  );
}
function Fixture() {
  const [selected, setSelected] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const [scenario, setScenario] = useState('ready');
  const [sourceFail, setSourceFail] = useState(true);
  const [wrongOriginal, setWrongOriginal] = useState(false);
  const [slow, setSlow] = useState(false);
  const [slowFeed, setSlowFeed] = useState(false);
  const [failSend, setFailSend] = useState(false);
  const [catchFail, setCatchFail] = useState(true);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    document.documentElement.style.fontSize = large ? '150%' : '';
  }, [large]);
  const scenarioState = useRef({ scenario, slowFeed, catchFail });
  scenarioState.current = { scenario, slowFeed, catchFail };
  const sourceState = useRef({ sourceFail, slow, wrongOriginal });
  sourceState.current = { sourceFail, slow, wrongOriginal };
  const groupIndex = selected ?? 0;
  const sessionId = groupSessionIdSchema.parse(uuid(1000 + groupIndex * 100 + generation * 2));
  const privateId = groupSessionIdSchema.parse(uuid(1001 + groupIndex * 100 + generation * 2));
  const loadPage = useCallback(
    async (query: GroupFeedQuery): Promise<GroupRead<GroupFeedPage>> => {
      const { scenario, slowFeed } = scenarioState.current;
      await new Promise((resolve) => setTimeout(resolve, slowFeed ? 1500 : 120));
      if (scenario === 'offline')
        return { kind: 'offline', message: 'Reconnect to load shared events.' };
      if (scenario === 'error')
        return { kind: 'error', message: 'Synthetic feed failure. Retry the same page.' };
      if (scenario === 'revoked-response')
        return { kind: 'revoked', message: 'Synthetic membership was revoked.' };
      const start = query.cursor?.after ?? 0;
      const total = scenario === 'empty' ? 0 : 32;
      const end = Math.min(start + query.limit, total);
      const events = await Promise.all(
        Array.from({ length: end - start }, (_, i) => eventAt(start + i, groupIndex, sessionId)),
      );
      return {
        kind: 'ready',
        value: {
          entries:
            scenario === 'private-page' || scenario === 'wrong-group-page'
              ? events.map((event) => ({
                  ...event,
                  scope: {
                    ...event.scope,
                    visibility:
                      scenario === 'private-page' ? ('private' as const) : ('shared' as const),
                    groupId:
                      scenario === 'wrong-group-page'
                        ? groups[1 - groupIndex].id
                        : event.scope.groupId,
                  },
                }))
              : events,
          watermark: total,
          continuation:
            end < total
              ? groupFeedCursorSchema.parse({
                  version: 2,
                  scopeKey: String(groupIndex + 1).repeat(64),
                  visibility: 'shared',
                  after: end,
                  watermark: total,
                })
              : null,
        },
      };
    },
    [groupIndex, sessionId],
  );
  const loadOriginal = useCallback(
    async (
      event: GroupEvent,
    ): Promise<GroupRead<{ eventId: GroupEvent['eventId']; text: string }>> => {
      // Deliberately ignores cancellation to verify the UI discards late responses.
      await new Promise((resolve) => setTimeout(resolve, sourceState.current.slow ? 1500 : 120));
      return sourceState.current.sourceFail
        ? { kind: 'error', message: 'Synthetic source interrupted.' }
        : {
            kind: 'ready',
            value: {
              eventId: event.eventId,
              text: sourceState.current.wrongOriginal
                ? exactOriginal(event.sequence - 1, groupIndex).replace('Can', 'May')
                : exactOriginal(event.sequence - 1, groupIndex),
            },
          };
    },
    [groupIndex],
  );
  const catchUp = useCallback(async (): Promise<GroupRead<string>> => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return scenarioState.current.catchFail
      ? { kind: 'error', message: 'Synthetic catch-up unavailable.' }
      : {
          kind: 'ready',
          value:
            'Synthetic example, limited to loaded shared evidence: the calibration question remains open. The members retained raw readings. No real summary was generated.',
        };
  }, []);
  return (
    <>
      <details className="fixture-controls">
        <summary>Synthetic preview controls · no agent execution</summary>
        <div>
          <label>
            Feed state
            <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {[
                'ready',
                'empty',
                'offline',
                'error',
                'revoked',
                'revoked-response',
                'private-page',
                'wrong-group-page',
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={sourceFail}
              onChange={(e) => setSourceFail(e.target.checked)}
            />
            Fail original
          </label>
          <label>
            <input
              type="checkbox"
              checked={wrongOriginal}
              onChange={(e) => setWrongOriginal(e.target.checked)}
            />
            Wrong original
          </label>
          <label>
            <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} />
            Slow original
          </label>
          <label>
            <input
              type="checkbox"
              checked={slowFeed}
              onChange={(e) => setSlowFeed(e.target.checked)}
            />
            Slow feed
          </label>
          <label>
            <input
              type="checkbox"
              checked={failSend}
              onChange={(e) => setFailSend(e.target.checked)}
            />
            Fail send
          </label>
          <label>
            <input
              type="checkbox"
              checked={catchFail}
              onChange={(e) => setCatchFail(e.target.checked)}
            />
            Fail catch-up
          </label>
          <label>
            <input type="checkbox" checked={large} onChange={(e) => setLarge(e.target.checked)} />
            Large text
          </label>
          <button onClick={() => setSelected(selected === 0 ? 1 : 0)}>Switch project</button>
          <button onClick={() => setGeneration((n) => n + 1)}>Replace sessions</button>
        </div>
      </details>
      <div className="fixture-surface">
        {selected === null ? (
          <GroupsLanding
            groups={
              scenario === 'empty'
                ? { kind: 'ready', value: [] }
                : scenario === 'offline' || scenario === 'error' || scenario === 'revoked'
                  ? { kind: scenario, message: 'Synthetic project list unavailable.' }
                  : { kind: 'ready', value: groups }
            }
            onOpen={(id) => setSelected(groups.findIndex((group) => group.id === id))}
            onRetry={() => setScenario('ready')}
            onCreate={async () => {
              throw new Error('Synthetic preview: setup is not connected. Your entries are kept.');
            }}
            onJoin={async () => {
              throw new Error(
                'Synthetic preview: joining is not connected. Your entries are kept.',
              );
            }}
          />
        ) : (
          <GroupsWorkspace
            group={groups[selected]}
            memberId={member.memberId}
            members={names.map((displayName, index) =>
              groupMemberSchema.parse({
                ...member,
                groupId: groups[selected].id,
                memberId: uuid(10 + index),
                displayName,
              }),
            )}
            access={scenario === 'revoked' ? 'revoked' : 'authorized'}
            sharedChat={{
              groupId: groups[selected].id,
              memberId: member.memberId,
              sessionId,
              visibility: 'shared',
              draftIdentity: sessionId,
              content: (
                <SyntheticChat identity={sessionId} privateChat={false} failSend={failSend} />
              ),
            }}
            privateAside={{
              groupId: groups[selected].id,
              memberId: member.memberId,
              sessionId: privateId,
              visibility: 'private',
              draftIdentity: privateId,
              content: <SyntheticChat identity={privateId} privateChat failSend={failSend} />,
            }}
            loadPage={loadPage}
            loadOriginal={loadOriginal}
            catchUp={catchUp}
            onBack={() => setSelected(null)}
          />
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
