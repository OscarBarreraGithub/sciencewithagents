import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  GroupPromotionAuthority,
  type GroupPromotionActor,
} from '@dock/shared/dist/group-promotion-authority.js';
import { groupPromotionIdentitySchema } from '@dock/shared/dist/group-promotion.js';
import { groupIdSchema, groupInstallationIdSchema } from '@dock/shared';
// Owned local concurrency fixture; synthetic IDs only, no provider/network activity.
const [path, group, installation, identityJson] = process.argv.slice(2);
const actor: GroupPromotionActor = {
  groupId: groupIdSchema.parse(group),
  installationId: groupInstallationIdSchema.parse(installation),
};
const identity = groupPromotionIdentitySchema.parse(JSON.parse(identityJson));
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout=5000');
try {
  const authority = new GroupPromotionAuthority(
    {
      rows(query, ...args) {
        if (query.includes('CREATE TABLE')) {
          db.exec(query);
          return [];
        }
        return db.prepare(query).all(...args) as never;
      },
      transaction(work) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const v = work();
          db.exec('COMMIT');
          return v;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
    },
    {
      authorize(a, i) {
        if (a.groupId !== identity.key.groupId || i.sourceHash !== identity.sourceHash)
          throw new Error('Fixture denied');
      },
      authorizeWriter() {
        throw new Error('Fixture cannot designate');
      },
      checkCapacity() {},
      authorizeDisposition() {
        throw new Error('No disposition approval');
      },
      verifyPublished() {
        throw new Error('Fixture has no committed publication');
      },
      now: () => 1000,
      id: randomUUID,
    },
  );
  process.stdout.write(JSON.stringify(authority.handle(actor, { kind: 'reserve', identity })));
} finally {
  db.close();
}
