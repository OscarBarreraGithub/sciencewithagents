import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROUP_LOCAL_RECEIPT_BYTES,
  GROUP_LOCAL_RECEIPT_CONTROL_BYTES,
  initializeGroupLocalReceiptCapacity,
  admitGroupLocalReceipt,
  groupLocalReceiptCapacity,
} from './group-local-receipt-capacity.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function schema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS gh_operations(key TEXT PRIMARY KEY,input TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gh_sends(handle TEXT,key TEXT,input TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(handle,key));
    CREATE TABLE IF NOT EXISTS gh_draft_receipts(handle TEXT,key TEXT,input TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(handle,key));`);
}
function promotion(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS gh_promotion_inputs(receipt_id TEXT PRIMARY KEY,enrollment_handle TEXT,source_json TEXT,state TEXT,registered INTEGER DEFAULT 0);`,
  );
}
it('backfills UTF-8 old records once and accounts new tables, rollback and reserved updates through reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'groups-receipt-budget-'));
  roots.push(root);
  const path = join(root, 'host.sqlite');
  let db = new DatabaseSync(path);
  try {
    schema(db);
    db.prepare('INSERT INTO gh_sends VALUES(?,?,?,?)').run('owner', 'old', 'é', '{}');
    initializeGroupLocalReceiptCapacity(db);
    const first = groupLocalReceiptCapacity(db).bytes;
    expect(first).toBe(2 + 8192 + 4096);
    promotion(db);
    initializeGroupLocalReceiptCapacity(db);
    db.prepare('INSERT INTO gh_promotion_inputs VALUES(?,?,?,?,0)').run(
      'source',
      'owner',
      'α',
      'pending',
    );
    expect(groupLocalReceiptCapacity(db).bytes).toBe(first + 2 + 1024 + 4096);
    const before = groupLocalReceiptCapacity(db);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO gh_operations VALUES(?,?,?)').run('rolled', '{}', '{}');
    db.exec('ROLLBACK');
    expect(groupLocalReceiptCapacity(db)).toEqual(before);
    db.prepare('UPDATE gh_sends SET body=? WHERE key=?').run('x'.repeat(8192), 'old');
    expect(groupLocalReceiptCapacity(db)).toEqual(before);
    expect(() =>
      db.prepare('UPDATE gh_sends SET body=? WHERE key=?').run('x'.repeat(8193), 'old'),
    ).toThrow('reservation');
    db.close();
    db = new DatabaseSync(path);
    initializeGroupLocalReceiptCapacity(db);
    expect(groupLocalReceiptCapacity(db)).toEqual(before);
    expect(db.prepare('SELECT input FROM gh_sends WHERE key=?').get('old')!.input).toBe('é');
  } finally {
    db.close();
  }
});
it('admits thousands of small identities beyond old count caps, then refuses new work while reserving accepted receipt growth', () => {
  const db = new DatabaseSync(':memory:');
  schema(db);
  promotion(db);
  initializeGroupLocalReceiptCapacity(db);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 4097; i++) {
      admitGroupLocalReceipt(db, 'gh_draft_receipts', '{}', '{}');
      db.prepare('INSERT INTO gh_draft_receipts VALUES(?,?,?,?)').run(
        'owner',
        String(i),
        '{}',
        '{}',
      );
    }
    for (let i = 0; i < 2049; i++) {
      admitGroupLocalReceipt(db, 'gh_operations', '{}', '{}');
      db.prepare('INSERT INTO gh_operations VALUES(?,?,?)').run(String(i), '{}', '{}');
    }
    for (let i = 0; i < 513; i++) {
      admitGroupLocalReceipt(db, 'gh_promotion_inputs', '{}', 'pending');
      db.prepare('INSERT INTO gh_promotion_inputs VALUES(?,?,?,?,0)').run(
        String(i),
        'owner',
        '{}',
        'pending',
      );
    }
    const insertSend = db.prepare('INSERT INTO gh_sends VALUES(?,?,?,?)');
    for (let i = 0; i < 2049; i++) {
      admitGroupLocalReceipt(db, 'gh_sends', '{}', '{}');
      insertSend.run('owner', String(i), '{}', '{}');
    }
    db.exec('COMMIT');
    expect(db.prepare('SELECT count(*) n FROM gh_sends').get()!.n).toBe(2049);
    // Seed the retained accounting counter as a near-full historical installation.
    // Thousands of real rows above verify count-cap removal; reaching the 2 GiB
    // admission fence should not require 170,000 more inserts on shared CI hosts.
    const remaining =
      GROUP_LOCAL_RECEIPT_BYTES -
      GROUP_LOCAL_RECEIPT_CONTROL_BYTES -
      groupLocalReceiptCapacity(db).bytes;
    db.prepare("UPDATE gh_receipt_storage SET bytes=bytes+? WHERE bucket='gh_operations'").run(
      remaining,
    );
    const before = groupLocalReceiptCapacity(db);
    expect(() => admitGroupLocalReceipt(db, 'gh_sends', '{}', '{}')).toThrow('no new request');
    admitGroupLocalReceipt(db, 'gh_operations', '{}', '{}', true);
    expect(groupLocalReceiptCapacity(db)).toEqual(before);
    // Receipt space was admitted before any transport; filling other admission
    // cannot consume the accepted human send's future body reservation.
    db.prepare('UPDATE gh_sends SET body=? WHERE handle=? AND key=?').run(
      'x'.repeat(8192),
      'owner',
      '0',
    );
    expect(groupLocalReceiptCapacity(db)).toEqual(before);
    const key = randomUUID();
    expect(() => admitGroupLocalReceipt(db, 'gh_sends', key, '{}')).toThrow();
    expect(db.prepare('SELECT body FROM gh_operations WHERE key=?').get('0')!.body).toBe('{}');
  } finally {
    db.close();
  }
});
