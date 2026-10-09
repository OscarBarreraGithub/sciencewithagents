import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { GroupContext } from '@dock/shared';
import { Runtime } from './runtime.js';
import { Store } from './store.js';
import { GroupEventRepository } from './group-events.js';
import { GROUP_PRIVATE_EVIDENCE_TOOL } from './group-evidence-private.js';
import { GROUP_HOST_EVIDENCE_TOOL, registerGroupHostEvidence } from './group-host-native-tools.js';

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
