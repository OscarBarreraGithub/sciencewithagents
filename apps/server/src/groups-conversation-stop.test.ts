import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { GroupsConversationJournal } from './groups-conversation-journal.js';
import { repoRoot } from './paths.js';

function fixture() {
  const parent = join(repoRoot, 'data/groups-stop-tests');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'case-'));
  let journal = new GroupsConversationJournal(root);
  const handle = randomUUID(),
    sessionA = randomUUID(),
    sessionB = randomUUID();
  journal.registerSession(sessionA);
  journal.registerSession(sessionB);
  return {
    root,
    handle,
    sessionA,
    sessionB,
    get journal() {
      return journal;
    },
    select(sessionId = sessionA) {
      return journal.select({ handle, key: randomUUID(), sessionId });
    },
    reopen() {
      journal.close();
      journal = new GroupsConversationJournal(root);
    },
    close() {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
describe('generation-bound Stop recovery', () => {
  it('serializes a native selection against an uncommitted Stop receipt using the same key', async () => {
    const f = fixture(),
      key = randomUUID();
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { GroupsConversationJournal } from ${JSON.stringify(new URL('./groups-conversation-journal.ts', import.meta.url).href)};
      const journal = new GroupsConversationJournal(${JSON.stringify(f.root)});
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        process.stdout.write('attempting\\n');
        try {
          journal.select(${JSON.stringify({ handle: f.handle, key, sessionId: f.sessionA })});
          process.stdout.write('incorrectly selected\\n');
        } catch (error) { process.stdout.write(String(error) + '\\n'); }
        finally { journal.close(); process.exit(0); }
      });
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (part) => {
      stdout += part.toString();
    });
    child.stderr.on('data', (part) => {
      stderr += part.toString();
    });
    const ended = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      await expect.poll(() => stdout).toContain('ready');
      f.journal.db.exec('BEGIN IMMEDIATE');
      f.journal.db
        .prepare('INSERT INTO gc_stops VALUES(?,?,?,?)')
        .run(key, f.handle, 1, JSON.stringify({ outcome: 'superseded', enabled: false }));
      child.stdin.write('select\n');
      await expect.poll(() => stdout).toContain('attempting');
      // The old implementation reads the other table without the writer lock,
      // then blocks only its INSERT, admitting the conflicting key after COMMIT.
      await new Promise((resolve) => setTimeout(resolve, 100));
      f.journal.db.exec('COMMIT');
      expect(await ended, stderr).toBe(0);
      expect(stdout).toContain('retained Stop request');
      expect(stdout).not.toContain('incorrectly selected');
      expect(f.journal.selection(f.handle)).toBeUndefined();
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await ended;
      }
      if (f.journal.db.isTransaction) f.journal.db.exec('ROLLBACK');
      f.close();
    }
  });
  it.each(['same', 'different'])(
    'replays a lost Stop ACK without stopping a %s reselected conversation',
    (which) => {
      const f = fixture();
      try {
        const a = f.select(),
          request = { handle: f.handle, key: randomUUID(), generation: a.generation };
        const receipt = f.journal.stop(request);
        const b = f.select(which === 'same' ? f.sessionA : f.sessionB);
        f.reopen();
        expect(f.journal.stop(request)).toEqual(receipt);
        expect(f.journal.selection(f.handle)).toEqual(b);
        expect(() => f.journal.stop({ ...request, generation: b.generation })).toThrow(
          'retry changed',
        );
        expect(() => f.journal.stop({ ...request, handle: randomUUID() })).toThrow('retry changed');
        // Backward-compatible native calls also recover the old key before current state.
        expect(f.journal.stop({ handle: f.handle, key: request.key })).toEqual(receipt);
        expect(f.journal.selection(f.handle)?.enabled).toBe(true);
      } finally {
        f.close();
      }
    },
  );
  it.each(['same', 'different'])(
    'records a no-effect receipt when Stop never arrived before %s-session reselection',
    (which) => {
      const f = fixture();
      try {
        const a = f.select(),
          request = { handle: f.handle, key: randomUUID(), generation: a.generation };
        const b = f.select(which === 'same' ? f.sessionA : f.sessionB);
        const receipt = f.journal.stop(request);
        expect(receipt.outcome).toBe('superseded');
        expect(f.journal.selection(f.handle)).toEqual(b);
        f.reopen();
        expect(f.journal.stop(request)).toEqual(receipt);
        expect(() => f.journal.stop({ ...request, generation: b.generation })).toThrow(
          'retry changed',
        );
        expect(() =>
          f.journal.select({ handle: f.handle, key: request.key, sessionId: f.sessionB }),
        ).toThrow('retained Stop');
        expect(
          f.journal.stop({ handle: f.handle, key: randomUUID(), generation: b.generation }),
        ).toMatchObject({ enabled: false, outcome: 'stopped' });
        expect(() => f.journal.db.exec('DELETE FROM gc_stops')).toThrow('retained Groups receipt');
        expect(() => f.journal.db.exec('UPDATE gc_stops SET target_generation=999')).toThrow(
          'immutable Groups receipt',
        );
      } finally {
        f.close();
      }
    },
  );
  it('recovers accepted pre-correction Stop rows and quarantines unknown legacy keys', () => {
    const f = fixture();
    try {
      const a = f.select(),
        key = randomUUID();
      // Exact format written by the previous implementation, before gc_stops existed.
      f.journal.db
        .prepare('INSERT INTO gc_selections(key,handle,input) VALUES(?,?,?)')
        .run(
          key,
          f.handle,
          JSON.stringify({ handle: f.handle, key, sessionId: a.sessionId, enabled: false }),
        );
      const b = f.select(f.sessionB);
      f.reopen();
      const request = { handle: f.handle, key, recoverOnly: true };
      expect(f.journal.stop(request)).toMatchObject({
        sessionId: a.sessionId,
        enabled: false,
        outcome: 'stopped',
      });
      expect(f.journal.selection(f.handle)).toEqual(b);
      const unknown = { handle: f.handle, key: randomUUID(), recoverOnly: true };
      expect(f.journal.stop(unknown)).toEqual({ outcome: 'unresolved' });
      expect(f.journal.selection(f.handle)).toEqual(b);
      expect(
        f.journal.db.prepare('SELECT 1 FROM gc_stops WHERE key=?').get(unknown.key),
      ).toBeUndefined();
      expect(
        f.journal.stop({ handle: f.handle, key: randomUUID(), generation: b.generation }),
      ).toMatchObject({ enabled: false });
      expect(f.journal.stop(unknown)).toEqual({ outcome: 'unresolved' });
    } finally {
      f.close();
    }
  });
});
