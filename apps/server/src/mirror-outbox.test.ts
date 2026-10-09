import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import type { MirrorQueuedAction, MirrorSend, MirrorState, MirrorResult } from '@dock/shared';
import { Store } from './store.js';
import { WorkspaceState } from './workspace-state.js';
import { MirrorOutbox } from './mirror-outbox.js';
import { VscodeMirrors, registerMirrorRoutes } from './vscode-mirror.js';
import { proxyPath } from './hosts.js';

let root: string, store: Store, queue: MirrorOutbox, client: string;
let state: MirrorState, sends: MirrorSend[], result: MirrorResult;
let read: () => Promise<MirrorState>, send: (input: MirrorSend) => Promise<MirrorResult>;
const target = { provider: 'codex' as const, threadId: 'same-thread' };
const transport = () => ({
  windows: async () => [
    { ...state, entries: undefined } as unknown as Omit<MirrorState, 'entries'>,
  ],
  read: async () => read(),
  send: async (_: string, input: MirrorSend) => {
    sends.push(input);
    return send(input);
  },
  receipt: () => result,
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dock-shared-queue-'));
  store = new Store(join(root, 'dock.sqlite'));
  client = new WorkspaceState(store).register({ key: randomUUID(), label: 'Owner browser' }).client
    .id;
  state = {
    windowId: randomUUID(),
    ...target,
    status: 'busy',
    title: 'Personal conversation',
    label: 'Editor',
    message: '',
    entries: [],
    canSteer: true,
    canQueue: true,
    steerToken: 'turn-one',
    stopToken: 'turn-one',
  };
  sends = [];
  result = { state: 'sent', message: 'Native acknowledgement' };
  read = async () => state;
  send = async () => result;
  queue = new MirrorOutbox(store, transport());
});
afterEach(() => {
  queue.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const enqueue = (text = 'Original owner prompt') => {
  store.transaction(() =>
    queue.enqueue(state, { key: randomUUID(), ...target, text, mode: 'queue' }),
  );
  return queue.list(target).items.at(-1)!;
};
const action = (
  id: string,
  kind: MirrorQueuedAction['action'],
  extra: Partial<MirrorQueuedAction> = {},
) =>
  queue.action(id, {
    key: randomUUID(),
    clientId: client,
    revision: queue.item(id).queueRevision,
    action: kind,
    ...extra,
  });

it('holds edited messages across restart, saves revision evidence, and requeues only explicitly', async () => {
  const row = enqueue();
  const edit = { key: randomUUID(), clientId: client, revision: 0, action: 'edit' as const };
  const held = await queue.action(row.id, edit);
  expect(await queue.action(row.id, edit)).toEqual(held);
  await action(row.id, 'save', { text: 'Revision one' });
  await action(row.id, 'save', { text: 'Revision two' });
  state.status = 'idle';
  delete state.steerToken;
  delete state.stopToken;
  await queue.pump();
  expect(sends).toEqual([]);
  queue.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  queue = new MirrorOutbox(store, transport());
  await queue.pump();
  expect(sends).toEqual([]);
  expect(queue.item(row.id)).toMatchObject({
    status: 'queued',
    text: row.text,
    queueEdit: { text: 'Revision two' },
  });
  const evidence = store.db
    .prepare('SELECT input,result FROM operations WHERE key LIKE ?')
    .all(`mirror-queue:${row.id}:%`);
  expect(JSON.stringify(evidence)).toContain('Revision one');
  expect(JSON.stringify(evidence)).toContain('Revision two');
  expect(
    JSON.parse(
      String(store.db.prepare('SELECT body FROM mirror_outbox WHERE id=?').get(row.id)!.body),
    ).acceptedText,
  ).toBe(row.text);
  expect(queue.receipt(row.id, edit.key).status).toBe('applied');
  await action(row.id, 'queue');
  await queue.pump();
  await queue.pump();
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ text: 'Revision two', threadId: target.threadId });
  expect(queue.item(row.id).status).toBe('completed');
});

it('uses revisions and explicit takeover across devices without silently releasing holds', async () => {
  const row = enqueue();
  await action(row.id, 'edit');
  const other = new WorkspaceState(store).register({ key: randomUUID(), label: 'Other phone' })
    .client.id;
  await expect(action(row.id, 'edit', { clientId: other })).rejects.toThrow('another browser');
  await action(row.id, 'takeover', { clientId: other });
  await expect(action(row.id, 'save', { text: 'Old device' })).rejects.toThrow('Hold this message');
  await expect(action(row.id, 'queue', { clientId: other, revision: 0 })).rejects.toThrow(
    'changed',
  );
  state.status = 'idle';
  await queue.pump();
  expect(sends).toEqual([]);
  await action(row.id, 'discard', { clientId: other });
  await queue.pump();
  expect(sends[0].text).toBe(row.text);
});

it('an edit that wins while native state is read prevents the pending dispatch claim', async () => {
  const row = enqueue();
  state.status = 'idle';
  let started = false;
  let release = () => {};
  read = () =>
    new Promise((resolve) => {
      started = true;
      release = () => resolve(state);
    });
  const dispatch = queue.pump();
  await expect.poll(() => started).toBe(true);
  await action(row.id, 'edit');
  release();
  await dispatch;
  expect(sends).toEqual([]);
  expect(queue.item(row.id).queueEdit).not.toBeNull();
});

it('a dispatch that claims first closes editing and never changes the submitted text', async () => {
  const row = enqueue();
  state.status = 'idle';
  let release = () => {};
  send = () =>
    new Promise((resolve) => {
      release = () => resolve(result);
    });
  const dispatch = queue.pump();
  await expect.poll(() => sends.length).toBe(1);
  await expect(action(row.id, 'edit')).rejects.toThrow('started delivery');
  release();
  await dispatch;
  expect(sends[0].text).toBe(row.text);
});

it('dispatches at the observed turn boundary even when native goal work immediately starts another turn', async () => {
  enqueue();
  await queue.pump();
  expect(sends).toEqual([]);
  state = { ...state, steerToken: 'turn-two', stopToken: 'turn-two' };
  await queue.pump();
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ mode: 'queue', text: 'Original owner prompt' });
  expect(sends[0].expectedTurnId).toBeUndefined();
  // Without a native queue, a subsequent busy turn is not silently steered.
  enqueue('Later message');
  state = { ...state, canQueue: false, steerToken: 'turn-three', stopToken: 'turn-three' };
  await queue.pump();
  expect(sends).toHaveLength(1);
  state.status = 'idle';
  await queue.pump();
  expect(sends).toHaveLength(2);
  expect(sends[1].mode).toBeUndefined();
});

it('steers a held individual Codex message once to the exact observed turn and refuses Claude steering', async () => {
  const row = enqueue();
  await action(row.id, 'edit');
  const steer = {
    key: randomUUID(),
    clientId: client,
    revision: queue.item(row.id).queueRevision,
    action: 'steer' as const,
    text: 'Revised steering',
  };
  expect((await queue.action(row.id, steer)).status).toBe('completed');
  expect((await queue.action(row.id, steer)).status).toBe('completed');
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ expectedTurnId: 'turn-one', text: steer.text });
  expect(queue.receipt(row.id, steer.key).status).toBe('applied');
  state.provider = 'claude';
  state.canSteer = false;
  store.transaction(() =>
    queue.enqueue(state, {
      key: randomUUID(),
      provider: 'claude',
      threadId: state.threadId!,
      text: 'Claude follow-up',
      mode: 'queue',
    }),
  );
  const claude = queue.list({ provider: 'claude', threadId: state.threadId! }).items[0];
  await action(claude.id, 'edit');
  await expect(action(claude.id, 'steer')).rejects.toThrow('Live steering is not enabled');
  expect(queue.list(target).items).toHaveLength(0);
});

it('lost dispatch/steering acknowledgements stay uncertain across restart and are never replayed', async () => {
  const row = enqueue();
  state.status = 'idle';
  result = { state: 'uncertain', message: 'No native acknowledgement.' };
  await queue.pump();
  await queue.pump();
  expect(sends).toHaveLength(1);
  expect(queue.item(row.id)).toMatchObject({ status: 'uncertain', deliveryKey: sends[0].key });
  queue.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  queue = new MirrorOutbox(store, transport());
  await queue.pump();
  expect(sends).toHaveLength(1);
  await expect(action(row.id, 'queue')).rejects.toThrow('started delivery');
  await expect(action(row.id, 'remove', { revision: 0 })).rejects.toThrow('changed');
  await action(row.id, 'remove');
  expect(queue.item(row.id).status).toBe('cancelled');
  state.status = 'busy';
  state.steerToken = 'turn-two';
  state.stopToken = 'turn-two';
  const next = enqueue('Another prompt');
  await action(next.id, 'edit');
  const steer = {
    key: randomUUID(),
    clientId: client,
    revision: queue.item(next.id).queueRevision,
    action: 'steer' as const,
  };
  const uncertain = await queue.action(next.id, steer);
  expect(uncertain).toMatchObject({ status: 'uncertain', queueEdit: { state: 'steering' } });
  await queue.action(next.id, steer);
  await queue.pump();
  expect(sends).toHaveLength(2);
  await expect(action(next.id, 'queue')).rejects.toThrow('started delivery');
});

it('a definite refusal blocks automatic attempts until explicit edit and requeue', async () => {
  const row = enqueue();
  state.status = 'idle';
  result = { state: 'not_sent', message: 'Native connection changed.' };
  await queue.pump();
  await queue.pump();
  expect(sends).toHaveLength(1);
  expect(queue.item(row.id).message).toContain('explicitly Save and queue');
  result = { state: 'sent', message: 'Native accepted' };
  await action(row.id, 'edit');
  await action(row.id, 'queue', { text: 'Confirmed retry wording' });
  await queue.pump();
  expect(sends).toHaveLength(2);
  expect(sends[1].key).not.toBe(sends[0].key);
  expect(sends[1].text).toBe('Confirmed retry wording');
});

it('binds durable outbox delivery to provider/thread across changed connection IDs and excludes other identities', async () => {
  enqueue();
  state = { ...state, windowId: randomUUID(), threadId: 'foreign-thread', status: 'idle' };
  await queue.pump();
  expect(sends).toEqual([]);
  expect(queue.list({ ...target, threadId: state.threadId! }).items).toHaveLength(0);
  state = { ...state, threadId: target.threadId, provider: 'claude' };
  await queue.pump();
  expect(sends).toEqual([]);
  state = { ...state, provider: 'codex' };
  await queue.pump();
  expect(sends).toHaveLength(1);
});

it('the existing mirror send route acknowledges durable app enqueue without touching native transport', async () => {
  let nativeWrites = 0;
  const daemon = {
    discover: async () => {},
    windows: () => [state],
    read: async () => state,
    send: async () => {
      nativeWrites++;
      return result;
    },
    control: async () => result,
    goal: async () => {
      throw new Error('Native goal is outside this queue fixture.');
    },
    goalAction: async () => {
      throw new Error('Native goal is outside this queue fixture.');
    },
    close: () => {},
  };
  state.source = 'codex-daemon';
  const mirrors = new VscodeMirrors(store, daemon);
  try {
    const input = { key: randomUUID(), ...target, mode: 'queue' as const, text: 'From the app' };
    const queued = await mirrors.send(state.windowId, input);
    expect(queued).toMatchObject({
      state: 'sent',
      message: expect.stringContaining('Queued here'),
    });
    expect(await mirrors.send(state.windowId, input)).toEqual(queued);
    expect(nativeWrites).toBe(0);
    expect(mirrors.queue.list(target).items).toHaveLength(1);
    expect(mirrors.receipt(input.key)).toEqual(queued);
    state.status = 'idle';
    await mirrors.queue.pump();
    expect(nativeWrites).toBe(1);
    await expect(
      mirrors.send(state.windowId, { ...input, text: 'Changed same key' }),
    ).rejects.toThrow('different message');
  } finally {
    mirrors.close();
  }
});

it('selected-host routes admit only exact typed outbox paths and target queries', () => {
  const id = randomUUID(),
    key = randomUUID();
  expect(proxyPath('GET', '/vscode/queued?provider=codex&threadId=same-thread')).not.toBeNull();
  expect(
    proxyPath('GET', '/vscode/queued?provider=codex&provider=claude&threadId=same-thread'),
  ).toBeNull();
  expect(
    proxyPath('GET', '/vscode/queued?provider=codex&threadId=same-thread&method=turn/start'),
  ).toBeNull();
  expect(proxyPath('POST', `/vscode/queued/${id}`)).not.toBeNull();
  expect(proxyPath('GET', `/vscode/queued/${id}/receipts/${key}`)).not.toBeNull();
  expect(proxyPath('POST', `/vscode/queued/${id}/native-edit`)).toBeNull();
});

it('resolves late delivery receipts during read-only inspection without repeating normal or steered sends', async () => {
  const row = enqueue();
  state.status = 'idle';
  result = { state: 'uncertain', message: 'Awaiting native receipt' };
  await queue.pump();
  expect(queue.item(row.id).status).toBe('uncertain');
  result = { state: 'sent', message: 'Late native acknowledgement' };
  expect(queue.list(target).items).toEqual([]);
  expect(queue.item(row.id).status).toBe('completed');
  expect(sends).toHaveLength(1);
  state.status = 'busy';
  state.steerToken = 'turn-two';
  state.stopToken = 'turn-two';
  const next = enqueue('Original future prompt');
  await action(next.id, 'edit');
  result = { state: 'uncertain', message: 'Steering receipt delayed' };
  await action(next.id, 'steer', { text: 'Exactly submitted steering' });
  const other = new WorkspaceState(store).register({ key: randomUUID(), label: 'Other phone' })
    .client.id;
  await expect(
    action(next.id, 'takeover', { clientId: other, text: 'Changed uncertain text' }),
  ).rejects.toThrow('cannot be changed');
  await action(next.id, 'takeover', { clientId: other });
  expect(queue.item(next.id).queueEdit?.state).toBe('steering');
  result = { state: 'sent', message: 'Late steer accepted' };
  expect(queue.item(next.id)).toMatchObject({
    status: 'completed',
    text: 'Exactly submitted steering',
    queueEdit: null,
  });
  await queue.pump();
  expect(sends).toHaveLength(2);
});

it('shutdown keeps an in-flight handoff durable and restart uses its receipt without replay', async () => {
  const row = enqueue();
  state.status = 'idle';
  result = { state: 'uncertain', message: 'No recorded receipt yet' };
  let release = () => {};
  send = () =>
    new Promise((resolve) => {
      release = () => resolve({ state: 'sent', message: 'Provider accepted' });
    });
  const dispatch = queue.pump();
  await expect.poll(() => sends.length).toBe(1);
  queue.close();
  release();
  await dispatch;
  expect(queue.item(row.id).status).toBe('running');
  queue = new MirrorOutbox(store, transport());
  expect(queue.item(row.id).status).toBe('uncertain');
  await queue.pump();
  expect(sends).toHaveLength(1);
  result = { state: 'sent', message: 'Persisted late mirror receipt' };
  expect(queue.item(row.id).status).toBe('completed');
  await queue.pump();
  expect(sends).toHaveLength(1);
});

it('an async steering read cannot switch provider identity or change the held message', async () => {
  const row = enqueue();
  await action(row.id, 'edit');
  read = async () => ({ ...state, provider: 'claude' });
  await expect(action(row.id, 'steer')).rejects.toThrow('cannot be steered');
  expect(sends).toEqual([]);
  expect(queue.item(row.id).queueEdit?.state).toBe('editing');
});

it('recovers the exact steering acknowledgement after the native receipt wins the crash window', async () => {
  for (const late of [false, true]) {
    const row = enqueue('Crash-window prompt');
    await action(row.id, 'edit');
    const steer = {
      key: randomUUID(),
      clientId: client,
      revision: queue.item(row.id).queueRevision,
      action: 'steer' as const,
      text: 'Exactly delivered before restart',
    };
    result = { state: 'sent', message: 'Native steer receipt saved' };
    await queue.action(row.id, steer);
    const operation = `mirror-queue:${row.id}:${steer.key}`;
    // Snapshot the real persisted claim, modelling process death after native sent is saved
    // but before the final outbox/operation acknowledgement transaction commits.
    const claimed = JSON.parse(
      String(store.db.prepare('SELECT result FROM operations WHERE key=?').get(operation)!.result),
    );
    store.transaction(() => {
      store.db
        .prepare('UPDATE mirror_outbox SET status=?,body=? WHERE id=?')
        .run('running', JSON.stringify(claimed), row.id);
      store.db.prepare('DELETE FROM operations WHERE key=?').run(`${operation}:ack`);
    });
    if (late) result = { state: 'uncertain', message: 'Native receipt not yet definitive' };
    queue.close();
    queue = new MirrorOutbox(store, transport());
    if (late) {
      expect(queue.receipt(row.id, steer.key).status).toBe('uncertain');
      result = { state: 'sent', message: 'Late native steer receipt saved' };
    }
    // A single inspection must both reconcile the item and resolve its matching receipt.
    expect(queue.receipt(row.id, steer.key)).toMatchObject({
      status: 'applied',
      item: { status: 'completed', text: steer.text },
    });
    expect(await queue.action(row.id, steer)).toMatchObject({
      status: 'completed',
      text: steer.text,
    });
    await queue.pump();
  }
  expect(sends).toHaveLength(2);
});

it('public app queue availability never enables unsupported native queue dispatch', async () => {
  state.source = 'codex-daemon';
  state.canQueue = false;
  let nativeWrites = 0;
  const daemon = {
    discover: async () => {},
    windows: () => [state],
    read: async () => state,
    send: async () => {
      nativeWrites++;
      return result;
    },
    control: async () => result,
    goal: async () => {
      throw new Error('Native goal is outside this queue fixture.');
    },
    goalAction: async () => {
      throw new Error('Native goal is outside this queue fixture.');
    },
    close: () => {},
  };
  const mirrors = new VscodeMirrors(store, daemon),
    app = Fastify();
  registerMirrorRoutes(app, mirrors, true);
  try {
    expect((await app.inject({ url: '/api/vscode/windows' })).json()[0].canQueue).toBe(true);
    expect(
      (await app.inject({ url: `/api/vscode/windows/${state.windowId}` })).json().canQueue,
    ).toBe(true);
    expect((await mirrors.read(state.windowId, {})).canQueue).toBe(false);
    expect(mirrors.windows()[0].canQueue).toBe(false);
    await mirrors.send(state.windowId, {
      key: randomUUID(),
      ...target,
      mode: 'queue',
      text: 'Safe app-owned queue',
    });
    state.steerToken = 'next-native-turn';
    state.stopToken = 'next-native-turn';
    await mirrors.queue.pump();
    expect(nativeWrites).toBe(0);
    state.status = 'idle';
    await mirrors.queue.pump();
    expect(nativeWrites).toBe(1);
  } finally {
    await app.close();
    mirrors.close();
  }
});

it('deletes an unheld app queue item at its exact revision without native dispatch, retaining restart receipts', async () => {
  const row = enqueue();
  const input = { key: randomUUID(), clientId: client, revision: 0, action: 'remove' as const };
  const removed = await queue.action(row.id, input);
  expect(removed).toMatchObject({ status: 'cancelled', queueRevision: 1, queueEdit: null });
  expect(await queue.action(row.id, input)).toEqual(removed);
  await expect(queue.action(row.id, { ...input, revision: 1 })).rejects.toThrow();
  queue.close();
  store.close();
  store = new Store(join(root, 'dock.sqlite'));
  queue = new MirrorOutbox(store, transport());
  expect(queue.item(row.id)).toMatchObject({ status: 'cancelled', text: row.text });
  expect(
    JSON.parse(
      String(store.db.prepare('SELECT body FROM mirror_outbox WHERE id=?').get(row.id)?.body),
    ).acceptedText,
  ).toBe(row.text);
  expect(queue.receipt(row.id, input.key).status).toBe('applied');
  await queue.pump();
  expect(sends).toEqual([]);
});

it('a delete winning during native read prevents dispatch and cannot erase another browser hold', async () => {
  const row = enqueue();
  state.status = 'idle';
  let release!: () => void,
    started = false;
  read = () =>
    new Promise((resolve) => {
      started = true;
      release = () => resolve(state);
    });
  const pump = queue.pump();
  await expect.poll(() => started).toBe(true);
  await action(row.id, 'remove');
  release();
  await pump;
  expect(sends).toEqual([]);
  const held = enqueue();
  await action(held.id, 'edit');
  const other = new WorkspaceState(store).register({ key: randomUUID(), label: 'Other browser' })
    .client.id;
  await expect(action(held.id, 'remove', { clientId: other })).rejects.toThrow();
  expect(queue.item(held.id).queueEdit?.clientId).toBe(client);
  await action(held.id, 'save', { text: 'Saved held text' });
  expect(await action(held.id, 'remove')).toMatchObject({ status: 'cancelled' });
});

it('refuses another browser deleting an uncertain held steering item and keeps native work unchanged', async () => {
  const row = enqueue();
  await action(row.id, 'edit');
  result = { state: 'uncertain', message: 'No native acknowledgement' };
  await action(row.id, 'steer');
  const other = new WorkspaceState(store).register({ key: randomUUID(), label: 'Other browser' })
    .client.id;
  await expect(action(row.id, 'remove', { clientId: other })).rejects.toThrow('Hold this message');
  expect(queue.item(row.id)).toMatchObject({
    status: 'uncertain',
    queueEdit: { clientId: client, state: 'steering' },
  });
  expect(await action(row.id, 'remove')).toMatchObject({ status: 'cancelled' });
  expect(sends).toHaveLength(1);
});
