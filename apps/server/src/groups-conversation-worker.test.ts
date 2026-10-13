import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repoRoot } from './paths.js';
import {
  GroupsConversationWorker,
  type GroupsConversationHost,
} from './groups-conversation-worker.js';
import { GroupsConversationJournal } from './groups-conversation-journal.js';

function directory() {
  const root = join(repoRoot, 'data/groups-conversation-tests');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, 'case-'));
}
const handle = randomUUID(),
  shared = randomUUID(),
  sessionId = randomUUID();
function select(journal: GroupsConversationJournal) {
  journal.registerSession(sessionId);
  return journal.select({ handle, sessionId, key: randomUUID() });
}
function exchange(journal: GroupsConversationJournal) {
  journal.observe(sessionId, 'UserPromptSubmit', 'Check whether the calculation converges.');
  journal.observe(sessionId, 'Stop', 'It does not converge; more work is needed.');
}
describe('selected native conversation sharing', () => {
  it('keeps the optional journal and polling absent before any integration is selected', async () => {
    const root = directory(),
      worker = new GroupsConversationWorker(
        {
          async open() {
            throw new Error('Unused');
          },
          async send() {
            throw new Error('Unused');
          },
        },
        root,
        async () => {
          throw new Error('No model');
        },
      );
    try {
      worker.start();
      expect(worker.status(handle)).toMatchObject({ selection: null, pending: 0 });
      expect(existsSync(join(root, 'groups-conversations.sqlite'))).toBe(false);
      expect(worker.stop({ handle, key: randomUUID() })).toEqual({
        enabled: false,
        outcome: 'unresolved',
      });
      expect(existsSync(join(root, 'groups-conversations.sqlite'))).toBe(false);
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('backs off pending delivery and ends terminal collisions without blocking new exchanges', async () => {
    const root = directory();
    let time = 100_000,
      sends = 0,
      turns = 0,
      delivery = 'pending';
    const worker = new GroupsConversationWorker(
      {
        async open() {
          return { group: {}, shared: { handle: shared } };
        },
        async send() {
          sends++;
          return { delivery };
        },
      },
      root,
      async () => {
        turns++;
        return { share: true, summary: 'The calculation still needs work.', model: 'test-model' };
      },
      () => time,
    );
    try {
      select(worker.journal);
      exchange(worker.journal);
      await worker.step();
      await worker.step();
      expect(sends).toBe(1);
      time += 31_000;
      delivery = 'collision';
      await worker.step();
      expect(worker.status(handle)).toMatchObject({ pending: 0, blocked: 1 });
      time += 100_000;
      await worker.step();
      expect(sends).toBe(2);
      expect(turns).toBe(1);
      worker.journal.warn(handle, 'Old warning');
      select(worker.journal);
      expect(worker.status(handle)).toMatchObject({ pending: 0, blocked: 0, warning: null });
      exchange(worker.journal);
      worker.journal.warn(handle, 'New warning');
      delivery = 'complete';
      await worker.step();
      expect(worker.status(handle).warning).toBeNull();
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('refuses an unobserved native session and never reuses an older prompt after an oversized input', () => {
    const root = directory(),
      journal = new GroupsConversationJournal(root);
    try {
      expect(() => journal.select({ handle, sessionId, key: randomUUID() })).toThrow(
        'has not reached',
      );
      select(journal);
      journal.observe(sessionId, 'UserPromptSubmit', 'Previous unrelated prompt');
      journal.observe(sessionId, 'UserPromptSubmit', 'x'.repeat(20_000));
      journal.observe(sessionId, 'Stop', 'A short final response.');
      expect(journal.jobs()).toHaveLength(0);
      expect(journal.state(handle).state).toBe('unknown');
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('starts a new selection only with a new prompt and never carries a previously selected prompt forward', () => {
    const root = directory(),
      journal = new GroupsConversationJournal(root);
    try {
      select(journal);
      journal.observe(sessionId, 'UserPromptSubmit', 'Earlier private prompt');
      journal.stop({ handle, key: randomUUID() });
      select(journal);
      journal.observe(sessionId, 'Stop', 'Reconnection acknowledgement');
      expect(journal.jobs()).toHaveLength(0);
      exchange(journal);
      expect(journal.jobs()).toHaveLength(1);
      expect(journal.jobs()[0].text).not.toContain('Earlier private prompt');
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('retains only selected conversation exchanges, deduplicates stops and persists through compaction/reopen', () => {
    const root = directory();
    let journal = new GroupsConversationJournal(root);
    try {
      journal.observe(randomUUID(), 'UserPromptSubmit', 'Unselected private material');
      expect(journal.db.prepare('SELECT COUNT(*) AS n FROM gc_prompts').get()!.n).toBe(0);
      const selected = select(journal);
      exchange(journal);
      journal.observe(sessionId, 'Stop', 'It does not converge; more work is needed.');
      expect(journal.jobs()).toHaveLength(1);
      journal.close();
      journal = new GroupsConversationJournal(root);
      expect(journal.selection(handle)).toEqual(selected);
      expect(journal.jobs()[0].text).toContain('does not converge');
      const other = randomUUID();
      journal.registerSession(other);
      journal.select({ handle, sessionId: other, key: randomUUID() });
      journal.observe(sessionId, 'UserPromptSubmit', 'Old conversation is no longer selected');
      expect(journal.db.prepare('SELECT COUNT(*) AS n FROM gc_prompts').get()!.n).toBe(1);
    } finally {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('retries the same delivery without rerunning a summary, including restart', async () => {
    const root = directory();
    let turns = 0,
      lose = true;
    const keys: string[] = [];
    const host: GroupsConversationHost = {
      async open() {
        return { group: {}, shared: { handle: shared } };
      },
      async send(input) {
        keys.push(input.key);
        if (lose) {
          lose = false;
          throw new Error('Lost response after accepted write');
        }
        return { delivery: 'complete' };
      },
    };
    let worker = new GroupsConversationWorker(
      host,
      root,
      async () => {
        turns++;
        return {
          share: true,
          summary: 'Calculation has not converged; further work is needed.',
          model: 'test-model',
        };
      },
      () => 100_000,
    );
    try {
      select(worker.journal);
      exchange(worker.journal);
      await worker.step();
      expect(turns).toBe(1);
      expect(worker.status(handle).pending).toBe(1);
      await worker.close();
      worker = new GroupsConversationWorker(
        host,
        root,
        async () => {
          throw new Error('Must never rerun');
        },
        () => 200_000,
      );
      await worker.step();
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(worker.status(handle).pending).toBe(0);
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('makes no model calls in read-only mode and never publishes after Stop sharing', async () => {
    const root = directory();
    let turns = 0,
      posts = 0,
      readOnly = true;
    const host: GroupsConversationHost = {
      async open() {
        return {
          group: { local: { mode: readOnly ? 'read-only' : 'contribute', hidden: false } },
          shared: { handle: shared },
        };
      },
      async send() {
        posts++;
        return { delivery: 'complete' };
      },
    };
    const worker = new GroupsConversationWorker(
      host,
      root,
      async () => {
        turns++;
        worker.stop({ handle, key: randomUUID() });
        return { share: true, summary: 'Must remain private.', model: 'test-model' };
      },
      () => 100_000,
    );
    try {
      select(worker.journal);
      exchange(worker.journal);
      await worker.step();
      expect(turns).toBe(0);
      readOnly = false;
      await worker.step();
      expect(turns).toBe(1);
      expect(posts).toBe(0);
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not repeat an interrupted model attempt after process restart', async () => {
    const root = directory();
    let turns = 0;
    const host: GroupsConversationHost = {
      async open() {
        return { group: {}, shared: { handle: shared } };
      },
      async send() {
        throw new Error('Must not publish');
      },
    };
    const worker = new GroupsConversationWorker(
      host,
      root,
      async () => {
        turns++;
        throw new Error('Must not launch');
      },
      () => 100_000,
    );
    try {
      select(worker.journal);
      exchange(worker.journal);
      const job = worker.journal.jobs()[0];
      worker.journal.startAttempt(job.id, 1);
      await worker.step();
      expect(turns).toBe(0);
      expect(worker.journal.state(job.id).state).toBe('unknown');
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('combines busy exchanges into one bounded summary and one delivery', async () => {
    const root = directory();
    let turns = 0,
      posts = 0,
      source = '';
    const host: GroupsConversationHost = {
      async open() {
        return { group: {}, shared: { handle: shared } };
      },
      async send() {
        posts++;
        return { delivery: 'complete' };
      },
    };
    const worker = new GroupsConversationWorker(
      host,
      root,
      async (text) => {
        turns++;
        source = text;
        return {
          share: true,
          summary: 'Three checks are complete; the final calculation still needs work.',
          model: 'test-model',
        };
      },
      () => 100_000,
    );
    try {
      select(worker.journal);
      for (let i = 0; i < 3; i++) {
        worker.journal.observe(sessionId, 'UserPromptSubmit', `Check ${i}`);
        worker.journal.observe(sessionId, 'Stop', `Check ${i} is complete.`);
      }
      await worker.step();
      expect(turns).toBe(1);
      expect(posts).toBe(1);
      expect(source).toContain('Check 2');
      expect(Buffer.byteLength(source)).toBeLessThanOrEqual(32 * 1024);
      expect(worker.status(handle).pending).toBe(0);
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('withholds a generated summary containing a recognizable credential', async () => {
    const root = directory();
    let posts = 0;
    const host: GroupsConversationHost = {
      async open() {
        return { group: {}, shared: { handle: shared } };
      },
      async send() {
        posts++;
        return { delivery: 'complete' };
      },
    };
    const worker = new GroupsConversationWorker(
      host,
      root,
      async () => ({
        share: true,
        summary: 'Use sk-ant-12345678901234567890 for the experiment.',
        model: 'test-model',
      }),
      () => 100_000,
    );
    try {
      select(worker.journal);
      exchange(worker.journal);
      await worker.step();
      expect(posts).toBe(0);
      expect(worker.status(handle).blocked).toBe(1);
    } finally {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
