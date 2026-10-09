import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupInstallationIdSchema, type GroupContext } from '@dock/shared';
import { groupPromotionSourceSchema } from '@dock/shared/dist/group-promotion.js';
import { GroupEventRepository } from './group-events.js';
import { Store } from './store.js';
import { createGroupLocalSynthesis } from './group-local-synthesis.js';
import { publicationCanonical } from './group-publication-protocol.js';
import type { GroupPromotionSynthesisRequest } from './group-promotion.js';

let directory: string, store: Store, events: GroupEventRepository, context: GroupContext;
let projectId: string, managerId: string, enrollmentHandle: string, allowed: boolean;
const kick = vi.fn(),
  registerHelper = vi.fn();
const signal = () => new AbortController().signal;
const decision = {
  category: 'Idea',
  sentences: ['Compare the treatment arms using a blinded control.'],
  evidenceRefs: [],
};
const make = () =>
  createGroupLocalSynthesis({
    directory,
    runtime: { store, kick },
    events,
    resolveLocalContext: () => ({
      context,
      projectId,
      agentId: managerId,
      provider: 'claude',
      cwd: directory,
    }),
    registerHelper,
    authorize: async () => {
      if (!allowed) throw new Error('Membership revoked');
      return { context, enrollmentHandle, writerId: context.installationId };
    },
  });
function request(): GroupPromotionSynthesisRequest {
  const scope = {
    groupId: context.groupId,
    memberId: context.memberId,
    installationId: context.installationId,
    visibility: 'shared',
    causalRefs: [],
    source: {
      sessionId: context.sessionId,
      nativeSessionId: context.nativeSessionId,
      provider: context.provider,
      messageId: randomUUID(),
    },
  };
  const source = groupPromotionSourceSchema.parse({
    key: { groupId: context.groupId, sourceId: randomUUID(), version: '1' },
    writerId: context.installationId,
    scope,
    projectionScope: scope,
    kind: 'human',
    activity: 'substantive',
    contentMode: 'shared-content',
    original: {
      kind: 'inline',
      text: 'A blinded control would help compare the two treatment arms.',
    },
    evidenceRefs: [],
    correction: null,
    decision: null,
    synthesisAuthorized: true,
  });
  return {
    synthesisId: randomUUID(),
    identity: {
      key: source.key,
      sourceHash: createHash('sha256').update(publicationCanonical(source)).digest('hex'),
    },
    source,
    evidence: [],
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'group-local-summary-'));
  store = new Store(join(directory, 'store.sqlite'));
  events = new GroupEventRepository(join(directory, 'events.sqlite'));
  const project = store.register(directory, 'Shared fixture', '', 'claude', undefined, 'direct');
  projectId = project.id;
  managerId = project.managerId;
  const { displayName: _, ...member } = events.createGroup('Owner');
  context = events.createContext({
    ...member,
    visibility: 'shared',
    provider: 'owner',
    nativeSessionId: randomUUID(),
  });
  enrollmentHandle = randomUUID();
  allowed = true;
  kick.mockClear();
  registerHelper.mockClear();
});
afterEach(() => {
  events.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('queues one fresh native helper, preserves its receipt across reopen, and never replays a failed turn', async () => {
  const input = request(),
    adapter = make();
  expect(await adapter.submit(input, signal())).toEqual({ state: 'pending' });
  const [run] = store.runs();
  expect(store.agent(run.agentId)).toMatchObject({
    executionMode: 'managed',
    provider: 'claude',
    permission: 'read-only',
    parentId: null,
    threadId: null,
  });
  expect(run.agentId).not.toBe(managerId);
  expect(store.agent(managerId).executionMode).toBe('direct');
  expect(run.kind).toBe('delegation');
  expect(registerHelper).toHaveBeenCalledWith(
    run.agentId,
    context,
    enrollmentHandle,
    run.id,
    input.synthesisId,
  );
  await adapter.close();
  const reopened = make();
  expect(await reopened.submit(input, signal())).toEqual({ state: 'pending' });
  store.updateRun(run.id, { status: 'failed' });
  expect(await reopened.inspect(input.synthesisId, input.identity, signal())).toEqual({
    state: 'unknown',
  });
  expect(await reopened.submit(input, signal())).toEqual({ state: 'unknown' });
  expect(store.runs()).toHaveLength(1);
  expect(kick).toHaveBeenCalledTimes(1);
});

it('returns the exact structured summary only after completion and rechecks writer authority', async () => {
  const input = request(),
    adapter = make();
  await adapter.submit(input, signal());
  const [run] = store.runs();
  store.entry({
    id: randomUUID(),
    agentId: run.agentId,
    runId: run.id,
    kind: 'assistant',
    title: 'Assistant',
    phase: 'final',
    text: JSON.stringify(decision),
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  store.updateRun(run.id, { status: 'completed' });
  expect(await adapter.inspect(input.synthesisId, input.identity, signal())).toEqual({
    state: 'completed',
    identity: input.identity,
    decision,
  });
  allowed = false;
  await expect(adapter.inspect(input.synthesisId, input.identity, signal())).rejects.toThrow(
    'revoked',
  );
  expect(store.runs()).toHaveLength(1);
});

it('excludes private content before reading its body and refuses changed sources or extra evidence', async () => {
  const input = request(),
    adapter = make();
  const privateSource = {
    ...input.source,
    scope: { ...input.source.scope, visibility: 'private' as const },
  };
  const body = vi.fn(() => {
    throw new Error('Private body read');
  });
  Object.defineProperty(privateSource, 'original', { get: body });
  await expect(adapter.submit({ ...input, source: privateSource }, signal())).rejects.toThrow(
    'Only authorized shared',
  );
  expect(body).not.toHaveBeenCalled();
  await expect(
    adapter.submit(
      {
        ...input,
        source: { ...input.source, writerId: groupInstallationIdSchema.parse(randomUUID()) },
      },
      signal(),
    ),
  ).rejects.toThrow('source changed');
  const other = { ...input, evidence: [{ event: {} as never, original: 'private canary' }] };
  await expect(adapter.submit(other, signal())).rejects.toThrow('evidence changed');
  expect(store.runs()).toHaveLength(0);
});

it('does not publish unexpected tool-backed output or invented evidence', async () => {
  const input = request(),
    adapter = make();
  await adapter.submit(input, signal());
  const [run] = store.runs();
  store.entry({
    id: randomUUID(),
    agentId: run.agentId,
    runId: run.id,
    kind: 'assistant',
    title: 'Assistant',
    text: JSON.stringify({ ...decision, evidenceRefs: [randomUUID()] }),
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  store.updateRun(run.id, { status: 'completed' });
  expect(await adapter.inspect(input.synthesisId, input.identity, signal())).toEqual({
    state: 'unknown',
  });
  store.entry({
    id: randomUUID(),
    agentId: run.agentId,
    runId: run.id,
    kind: 'tool',
    title: 'Unexpected tool',
    text: '',
    status: 'complete',
    createdAt: new Date().toISOString(),
  });
  expect(await adapter.submit(input, signal())).toEqual({ state: 'unknown' });
  expect(store.runs()).toHaveLength(1);
});
