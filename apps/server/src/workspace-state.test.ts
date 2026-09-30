import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDraft, WorkspaceDraftSubmission, WorkspaceUpdate } from '@dock/shared';
import { Store } from './store.js';
import { WorkspaceState } from './workspace-state.js';

let root: string, store: Store, workspace: WorkspaceState, agentId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-workspace-'));
  store = new Store(join(root, 'dock.sqlite'));
  agentId = store.register(root, 'Workspace fixture', '').managerId;
  workspace = new WorkspaceState(store);
});
afterEach(() => {
  if (store.db.isOpen) store.close();
  rmSync(root, { recursive: true, force: true });
});
const register = (label = 'Desktop') => workspace.register({ key: randomUUID(), label }).client.id;
const change = (clientId: string, action: WorkspaceUpdate['action']) =>
  workspace.update(clientId, {
    key: randomUUID(),
    hostId: workspace.hostId,
    revision: workspace.snapshot(clientId).client.revision,
    action,
  });
const save = (clientId: string, text: string, target = agentId) =>
  workspace.saveDraft(clientId, target, {
    key: randomUUID(),
    hostId: workspace.hostId,
    revision: workspace.drafts(clientId, target).own.revision,
    action: { kind: 'save', text },
  }).state.own;
const token = (draft: WorkspaceDraft): WorkspaceDraftSubmission => ({
  hostId: workspace.hostId,
  clientId: draft.clientId,
  revision: draft.revision,
  deliveryKey: draft.deliveryKey!,
});
const submit = (draft: WorkspaceDraft, requestKey = randomUUID()) =>
  store.transaction(() => {
    const key = workspace.reserveSubmission(
      draft.agentId,
      token(draft),
      requestKey,
      draft.text.trim(),
    );
    return store.enqueue(draft.agentId, key, draft.text.trim());
  });

describe('host-local conflict-safe workspaces', () => {
  it('registers generated identities with durable exact receipts and rejects altered retries', () => {
    const input = { key: randomUUID(), label: 'My phone' };
    const first = workspace.register(input),
      head = store.head;
    expect(first.client.id).not.toBe(input.key);
    expect(workspace.register(input)).toEqual(first);
    expect(store.head).toBe(head);
    expect(() => workspace.register({ ...input, label: 'Another phone' })).toThrow('retry key');
    expect(() => workspace.snapshot(randomUUID())).toThrow('not registered');
  });

  it('restores five open conversations and exact selection after restart without enqueuing work', () => {
    const browser = register(),
      projectId = store.agent(agentId).projectId;
    const agents = [
      agentId,
      ...Array.from(
        { length: 4 },
        (_, index) => store.addManager(projectId, `Module ${index}`, `Scope ${index}`).id,
      ),
    ];
    for (const id of agents) change(browser, { kind: 'open', agentId: id });
    const before = workspace.snapshot(browser),
      originalAgents = store.agents();
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    workspace = new WorkspaceState(store);
    expect(workspace.snapshot(browser)).toEqual(before);
    expect(new Set(workspace.openAgentIds())).toEqual(new Set(agents));
    expect(store.agents()).toEqual(originalAgents);
    expect(store.runs()).toEqual([]);
    expect(store.entries(agentId)).toEqual([]);
  });

  it('uses revisions across tabs while keeping separate computers and browser selections isolated', () => {
    const desktop = register(),
      phone = register('Phone');
    const stale = {
      key: randomUUID(),
      hostId: workspace.hostId,
      revision: 0,
      action: { kind: 'close' as const, agentId },
    };
    change(desktop, { kind: 'open', agentId });
    expect(workspace.update(desktop, stale).status).toBe('conflict');
    expect(workspace.snapshot(desktop).client.selectedAgentId).toBe(agentId);
    expect(workspace.snapshot(phone).client.selectedAgentId).toBeNull();
    expect(() => workspace.update(phone, { ...stale, hostId: randomUUID() })).toThrow(
      'different computer',
    );
    expect(() => change(desktop, { kind: 'open', agentId: randomUUID() })).toThrow();
  });

  it('copies open views only after explicit source-revision confirmation and never removes history or drafts on close', () => {
    const desktop = register(),
      phone = register('Phone');
    change(desktop, { kind: 'open', agentId });
    const source = workspace.snapshot(desktop).client;
    change(desktop, { kind: 'rename', label: 'My computer' });
    expect(
      change(phone, { kind: 'adopt', sourceClientId: desktop, sourceRevision: source.revision })
        .status,
    ).toBe('conflict');
    change(phone, {
      kind: 'adopt',
      sourceClientId: desktop,
      sourceRevision: workspace.snapshot(desktop).client.revision,
    });
    save(phone, 'Keep this unfinished idea');
    change(phone, { kind: 'close', agentId });
    expect(workspace.snapshot(phone).client.openAgentIds).toEqual([]);
    expect(workspace.snapshot(desktop).client.openAgentIds).toEqual([agentId]);
    expect(workspace.drafts(phone, agentId).own.text).toBe('Keep this unfinished idea');
    expect(store.agent(agentId).id).toBe(agentId);
  });
});

describe('draft handoff and submission receipts', () => {
  it('retains concurrent per-device drafts and refuses stale tab saves without leaking draft text to events', () => {
    const desktop = register(),
      phone = register('Phone');
    const first = save(desktop, 'Desktop confidential draft');
    save(phone, 'Phone confidential draft');
    const input = {
      key: randomUUID(),
      hostId: workspace.hostId,
      revision: 0,
      action: { kind: 'save', text: 'Stale overwrite' },
    };
    const result = workspace.saveDraft(desktop, agentId, input);
    expect(result.status).toBe('conflict');
    expect(result.state.own.text).toBe(first.text);
    expect(result.state.others[0]?.text).toBe('Phone confidential draft');
    expect(workspace.saveDraft(desktop, agentId, input)).toEqual(result);
    const events = JSON.stringify(
      store.events().filter((event) => event.type.startsWith('workspace.')),
    );
    expect(events).not.toContain('confidential');
  });

  it('recovers a lost save acknowledgement and a clear tombstone exactly once across restart', () => {
    const client = register();
    const input = {
      key: randomUUID(),
      hostId: workspace.hostId,
      revision: 0,
      action: { kind: 'save', text: 'One copy only' },
    };
    const saved = workspace.saveDraft(client, agentId, input);
    const cleared = save(client, '');
    const head = store.head;
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    workspace = new WorkspaceState(store);
    expect(workspace.saveDraft(client, agentId, input)).toEqual(saved);
    expect(workspace.drafts(client, agentId).own).toEqual(cleared);
    expect(store.head).toBe(head);
    expect(() =>
      workspace.saveDraft(client, agentId, {
        ...input,
        action: { kind: 'save', text: 'Different' },
      }),
    ).toThrow('retry key');
  });

  it('validates the exact other-device revision before copying and keeps the source unchanged', () => {
    const desktop = register(),
      phone = register('Phone');
    const old = save(desktop, 'First');
    const latest = save(desktop, 'Updated');
    const input = {
      key: randomUUID(),
      hostId: workspace.hostId,
      revision: 0,
      action: { kind: 'copy', sourceClientId: desktop, sourceRevision: old.revision },
    };
    expect(workspace.saveDraft(phone, agentId, input).status).toBe('conflict');
    const copied = workspace.saveDraft(phone, agentId, {
      ...input,
      key: randomUUID(),
      action: { ...input.action, sourceRevision: latest.revision },
    }).state.own;
    expect(copied.text).toBe(latest.text);
    expect(copied.deliveryKey).toBe(latest.deliveryKey);
    expect(workspace.drafts(desktop, agentId).own).toEqual(latest);
    expect(store.runs()).toEqual([]);
  });

  it('submits one copied draft once across devices, different browser receipt keys, clears and restart', () => {
    const desktop = register(),
      phone = register('Phone');
    const original = save(desktop, '  Please do this once  ');
    const copied = workspace.saveDraft(phone, agentId, {
      key: randomUUID(),
      hostId: workspace.hostId,
      revision: 0,
      action: { kind: 'copy', sourceClientId: desktop, sourceRevision: original.revision },
    }).state.own;
    const requestA = randomUUID(),
      requestB = randomUUID();
    const run = submit(original, requestA);
    expect(submit(copied, requestB)).toEqual(run);
    expect(workspace.drafts(phone, agentId).own.submitted).toBe(true);
    save(desktop, '');
    save(phone, '');
    store.close();
    store = new Store(join(root, 'dock.sqlite'));
    workspace = new WorkspaceState(store);
    expect(submit(original, requestA)).toEqual(run);
    expect(submit(copied, requestB)).toEqual(run);
    expect(store.runs()).toHaveLength(1);
    expect(workspace.receiptKey(agentId, requestB)).toBe(original.deliveryKey);
    expect(workspace.receiptKey(randomUUID(), requestB)).toBe(requestB);
    expect(() => submit(original)).toThrow('draft changed');
  });

  it('rejects stale, foreign-host, mismatched-text and altered-mode sends without any run', () => {
    const client = register();
    const first = save(client, 'Original');
    const latest = save(client, 'Edited');
    expect(() => submit(first)).toThrow('draft changed');
    expect(() =>
      store.transaction(() =>
        workspace.reserveSubmission(
          agentId,
          { ...token(latest), hostId: randomUUID() },
          randomUUID(),
          latest.text,
        ),
      ),
    ).toThrow('different computer');
    expect(() =>
      store.transaction(() =>
        workspace.reserveSubmission(agentId, token(latest), randomUUID(), 'Substituted'),
      ),
    ).toThrow('draft changed');
    expect(store.runs()).toEqual([]);
    submit(latest);
    expect(() =>
      store.transaction(() =>
        workspace.reserveSubmission(agentId, token(latest), randomUUID(), latest.text, 'steer'),
      ),
    ).toThrow('different action');
  });

  it('rolls back a reserved delivery if enqueue fails, and an edited copy gets its own deliberate delivery', () => {
    const client = register(),
      first = save(client, 'First action');
    expect(() =>
      store.transaction(() => {
        workspace.reserveSubmission(agentId, token(first), randomUUID(), first.text);
        throw new Error('Fixture enqueue failure');
      }),
    ).toThrow('Fixture');
    expect(workspace.drafts(client, agentId).own.submitted).toBe(false);
    submit(first);
    const next = save(client, 'Second deliberate action');
    expect(next.deliveryKey).not.toBe(first.deliveryKey);
    submit(next);
    expect(store.runs()).toHaveLength(2);
  });
});
it('pages retained draft versions across restart and restores a version without altering original send receipts', () => {
  const browser = register(),
    phone = register('Phone');
  save(phone, 'Private phone draft');
  for (let n = 1; n <= 23; n++) save(browser, `Version ${n}`);
  const sent = workspace.drafts(browser, agentId).own;
  const sendKey = randomUUID();
  submit(sent, sendKey);
  save(browser, '');
  const first = workspace.draftHistory(browser, agentId);
  expect(first.versions).toHaveLength(20);
  expect(first.versions[0]?.text).toBe('');
  expect(first.versions.some((version) => version.text === 'Private phone draft')).toBe(false);
  expect(first.nextBefore).toBe(5);
  const rest = workspace.draftHistory(browser, agentId, first.nextBefore!);
  expect(rest.versions.map((version) => version.text)).toEqual([
    'Version 4',
    'Version 3',
    'Version 2',
    'Version 1',
  ]);
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  workspace = new WorkspaceState(store);
  expect(workspace.draftHistory(browser, agentId)).toEqual(first);
  save(browser, rest.versions.at(-1)!.text);
  expect(workspace.drafts(browser, agentId).own.text).toBe('Version 1');
  expect(store.runs()).toHaveLength(1);
  expect(submit(sent, sendKey).id).toBe(store.runs()[0]?.id);
});
