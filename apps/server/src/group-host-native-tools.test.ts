import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { groupEntityIdSchema, groupOperationIdSchema, type GroupContext } from '@dock/shared';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { GroupEventRepository } from './group-events.js';
import { GROUP_PRIVATE_EVIDENCE_TOOL } from './group-evidence-private.js';
import { GROUP_HOST_EVIDENCE_TOOL, registerGroupHostEvidence } from './group-host-native-tools.js';
import {
  GROUP_EVIDENCE_ORIGINAL_TOOL,
  createGroupEvidenceOriginal,
} from './group-evidence-original.js';
import { groupNativeReadingNames } from './group-native-reading-names.js';

it('ordinary native tools retain their catalog and private evidence uses only the exact current group context', async () => {
  mkdirSync('data/tests', { recursive: true });
  const root = mkdtempSync('data/tests/host-group-evidence-');
  const store = new Store(join(root, 'dock.sqlite'));
  const provider = vi.fn(async () => {
    throw new Error('No provider in this dispatch check');
  });
  const runtime = new Runtime(store, root, 'never-native', provider);
  const events = new GroupEventRepository(join(root, 'events.sqlite'));
  try {
    const project = store.register(root, 'Native evidence scope', '');
    const privateAgent = store.addAgent({
      projectId: project.id,
      parentId: null,
      taskId: null,
      name: 'Private',
      role: 'manager',
      cwd: root,
      provider: 'codex',
    });
    const sharedAgent = store.addAgent({
      projectId: project.id,
      parentId: null,
      taskId: null,
      name: 'Shared',
      role: 'manager',
      cwd: root,
      provider: 'codex',
    });
    const member = events.createGroup('Scope');
    const context = (visibility: 'shared' | 'private'): GroupContext =>
      events.createContext({
        groupId: member.groupId,
        memberId: member.memberId,
        installationId: member.installationId,
        visibility,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
    const privateContext = context('private'),
      sharedContext = context('shared');
    store.setSetting(`group:host-native-agent:${privateAgent.id}`, { context: privateContext });
    store.setSetting(`group:host-native-agent:${sharedAgent.id}`, { context: sharedContext });
    const invoke = vi.fn(async (_raw, scope: GroupContext) => ({
      content: [
        { type: 'text' as const, text: JSON.stringify({ privateContext: scope.sessionId }) },
      ],
    }));
    registerGroupHostEvidence(runtime, (scope) => [
      { ...GROUP_PRIVATE_EVIDENCE_TOOL, invoke: (raw) => invoke(raw, scope) },
    ]);
    const catalog = (agent: typeof privateAgent) => runtime['tools'](agent).map((t) => t.name);
    expect(catalog(privateAgent)).toContain('dock_inspect');
    expect(catalog(privateAgent)).toContain('dock_checkpoint');
    expect(catalog(privateAgent)).toContain(GROUP_HOST_EVIDENCE_TOOL);
    expect(catalog(privateAgent).length).toBeLessThanOrEqual(20);
    expect(new Set(catalog(privateAgent)).size).toBe(catalog(privateAgent).length);
    expect(catalog(sharedAgent)).toContain('dock_delegate');
    expect(catalog(sharedAgent)).toContain(GROUP_HOST_EVIDENCE_TOOL);
    const run = store.enqueue(privateAgent.id, randomUUID(), 'Private evidence read');
    store.updateRun(run.id, { status: 'running' });
    store.setSetting(`group:host-native-run:${run.id}`, {
      requestId: randomUUID(),
      intent: 'ask',
      context: privateContext,
    });
    expect(await runtime.tool(privateAgent.id, randomUUID(), GROUP_HOST_EVIDENCE_TOOL, {})).toEqual(
      { privateContext: privateContext.sessionId },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    store.setSetting(`group:host-native-run:${run.id}`, {
      requestId: randomUUID(),
      intent: 'ask',
      context: sharedContext,
    });
    await expect(
      runtime.tool(privateAgent.id, randomUUID(), GROUP_HOST_EVIDENCE_TOOL, {}),
    ).rejects.toThrow('original admitted group turn');
    store.updateRun(run.id, { status: 'completed' });
    await expect(
      runtime.tool(privateAgent.id, randomUUID(), GROUP_HOST_EVIDENCE_TOOL, {}),
    ).rejects.toThrow('admitted group turn');
    expect(invoke).toHaveBeenCalledTimes(1);
    const sharedRun = store.enqueue(sharedAgent.id, randomUUID(), 'Shared evidence read');
    store.updateRun(sharedRun.id, { status: 'running' });
    store.setSetting(`group:host-native-run:${sharedRun.id}`, {
      requestId: randomUUID(),
      intent: 'ask',
      context: sharedContext,
    });
    expect(await runtime.tool(sharedAgent.id, randomUUID(), GROUP_HOST_EVIDENCE_TOOL, {})).toEqual({
      privateContext: sharedContext.sessionId,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(provider).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
    events.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['shared', 'private'] as const)(
  'direct %s Group reads expose only two readers and revalidate exact turn, context and membership',
  async (visibility) => {
    mkdirSync('data/tests', { recursive: true });
    const root = mkdtempSync('data/tests/direct-group-evidence-');
    const store = new Store(join(root, 'dock.sqlite'));
    const provider = vi.fn(async () => {
      throw new Error('No native process in this fixture');
    });
    const runtime = new Runtime(store, root, 'never-native', provider);
    const events = new GroupEventRepository(join(root, 'events.sqlite'));
    try {
      const project = store.register(root, 'Retained managed', '');
      const agent = store.addAgent({
        projectId: project.id,
        parentId: null,
        taskId: null,
        name: 'Direct Group',
        role: 'manager',
        cwd: root,
        provider: 'codex',
        executionMode: 'direct',
      });
      const personal = store.addAgent({
        projectId: project.id,
        parentId: null,
        taskId: null,
        name: 'Personal direct',
        role: 'manager',
        cwd: root,
        provider: 'codex',
        executionMode: 'direct',
      });
      const member = events.createGroup('Fixture');
      const context = events.createContext({
        groupId: member.groupId,
        memberId: member.memberId,
        installationId: member.installationId,
        visibility,
        provider: 'codex',
        nativeSessionId: randomUUID(),
      });
      const scope = (ctx = context) => ({
        groupId: ctx.groupId,
        memberId: ctx.memberId,
        installationId: ctx.installationId,
        visibility: ctx.visibility,
        source: {
          sessionId: ctx.sessionId,
          provider: ctx.provider,
          nativeSessionId: ctx.nativeSessionId,
          messageId: randomUUID(),
        },
        causalRefs: [],
      });
      const publicContext =
        visibility === 'shared'
          ? context
          : events.createContext({
              groupId: member.groupId,
              memberId: member.memberId,
              installationId: member.installationId,
              visibility: 'shared',
              provider: 'codex',
              nativeSessionId: randomUUID(),
            });
      const privateContext =
        visibility === 'private'
          ? context
          : events.createContext({
              groupId: member.groupId,
              memberId: member.memberId,
              installationId: member.installationId,
              visibility: 'private',
              provider: 'codex',
              nativeSessionId: randomUUID(),
            });
      const append = (ctx: GroupContext, text: string) =>
        events.append(events.trustedHostScope(scope(ctx)), {
          operationId: groupOperationIdSchema.parse(randomUUID()),
          entityId: groupEntityIdSchema.parse(randomUUID()),
          expectedRevision: 0,
          category: 'Finding',
          condensedText: 'Fixture evidence',
          original: { kind: 'inline', text },
          evidenceRefs: [],
          corrects: null,
        }).event;
      const sharedOriginal = append(publicContext, '  Exact shared evidence 🧬\n');
      const privateOriginal = append(privateContext, 'Private source must stay private');
      let release: (() => void) | undefined;
      let held: Promise<void> | undefined;
      const queries = vi.fn(async (bound: GroupContext) => {
        events.trustedHostScope(scope());
        await held;
        events.trustedHostScope(scope());
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ visibility: bound.visibility, sessionId: bound.sessionId }),
            },
          ],
        };
      });
      const reader = {
        context,
        enrollmentHandle: context.installationId,
        revalidate: async () => {
          events.trustedHostScope(scope());
        },
        readShared: async (q: Parameters<GroupEventRepository['feed']>[1]) =>
          events.feed(events.trustedHostScope(scope()), q),
        original: async (eventId: string) => {
          const value = events.expand(events.trustedHostScope(scope()), eventId);
          if (value.event.scope.visibility !== 'shared')
            throw new Error('Private evidence unavailable');
          return { eventId: value.event.eventId, text: value.original };
        },
      };
      registerGroupHostEvidence(runtime, (bound) => [
        { ...GROUP_PRIVATE_EVIDENCE_TOOL, invoke: async () => queries(bound) },
        {
          ...GROUP_EVIDENCE_ORIGINAL_TOOL,
          invoke: async (raw) => ({
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(await createGroupEvidenceOriginal(async () => reader)(raw)),
              },
            ],
          }),
        },
      ]);
      store.setSetting(`group:host-native-agent:${agent.id}`, { context });
      expect(runtime['tools'](agent).map((tool) => tool.name)).toEqual(groupNativeReadingNames);
      expect(runtime['tools'](personal)).toEqual([]);
      expect(store.agent(project.managerId).executionMode).toBe('managed');
      const run = store.enqueue(agent.id, randomUUID(), 'Exact Group Ask');
      store.updateRun(run.id, { status: 'running' });
      const marker = { requestId: randomUUID(), intent: 'ask', context };
      store.setSetting(`group:host-native-run:${run.id}`, marker);
      await expect(
        runtime.tool(personal.id, randomUUID(), groupNativeReadingNames[0], {}),
      ).rejects.toThrow('admitted group turn');
      await expect(runtime.tool(agent.id, randomUUID(), 'dock_delegate', {})).rejects.toThrow(
        'coordination tools',
      );
      await expect(
        runtime.tool(agent.id, randomUUID(), GROUP_HOST_EVIDENCE_TOOL, {}),
      ).rejects.toThrow('coordination tools');
      expect(await runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[0], {})).toEqual({
        visibility,
        sessionId: context.sessionId,
      });
      expect(
        await runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[1], {
          eventId: sharedOriginal.eventId,
          offset: 0,
          limit: 100,
        }),
      ).toMatchObject({ text: '  Exact shared evidence 🧬\n', nextOffset: null });
      await expect(
        runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[1], {
          eventId: privateOriginal.eventId,
          offset: 0,
          limit: 100,
        }),
      ).rejects.toThrow(/evidence unavailable/i);
      store.setSetting(`group:host-native-run:${run.id}`, {
        ...marker,
        context: { ...context, sessionId: randomUUID() },
      });
      await expect(
        runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[0], {}),
      ).rejects.toThrow('original admitted group turn');
      expect(queries).toHaveBeenCalledOnce();
      store.setSetting(`group:host-native-run:${run.id}`, marker);
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const late = runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[0], {});
      await vi.waitFor(() => expect(queries).toHaveBeenCalledTimes(2));
      store.updateRun(run.id, { status: 'completed' });
      release!();
      await expect(late).rejects.toThrow('no longer current');
      store.updateRun(run.id, { status: 'running' });
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const changed = runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[0], {});
      await vi.waitFor(() => expect(queries).toHaveBeenCalledTimes(3));
      store.setSetting(`group:host-native-run:${run.id}`, { ...marker, requestId: randomUUID() });
      release!();
      await expect(changed).rejects.toThrow('no longer current');
      store.setSetting(`group:host-native-run:${run.id}`, marker);
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const revoked = runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[0], {});
      await vi.waitFor(() => expect(queries).toHaveBeenCalledTimes(4));
      events.revokeMember(member.groupId, member.memberId);
      release!();
      await expect(revoked).rejects.toThrow();
      held = undefined;
      await expect(
        runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[0], {}),
      ).rejects.toThrow();
      await expect(
        runtime.tool(agent.id, randomUUID(), groupNativeReadingNames[1], {
          eventId: sharedOriginal.eventId,
          offset: 0,
          limit: 8,
        }),
      ).rejects.toThrow();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      events.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
