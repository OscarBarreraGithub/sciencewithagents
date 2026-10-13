import { z } from 'zod';
import {
  GROUP_PHONE_LIMITS as L,
  groupPhoneManageCommandSchema,
  groupPhoneCommandSchema,
  groupPhoneDevicesSchema,
  type GroupPhoneCommand,
  type GroupPhoneResult,
} from '@dock/shared/dist/group-phone.js';
import { membershipCapabilitySchema } from '@dock/shared/dist/group-membership.js';
import { groupEventSchema } from '@dock/shared/dist/groups.js';
import {
  publicationEnvelope,
  publicationCanonical,
  type PublicationHeader,
} from '@dock/shared/dist/group-delivery.js';
import { capabilityHash, digest, hostingEnvironment, equalHash } from './crypto.js';
import { GroupFeatureStorage, GroupFeatureStorageLimit } from './group-feature-storage.js';
import type { DeliveryStorage } from './delivery.js';
const schema = `
CREATE TABLE IF NOT EXISTS delivery_phone_pairs(id TEXT PRIMARY KEY,enrollment TEXT NOT NULL,secret TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,label TEXT NOT NULL,post INTEGER NOT NULL,binding TEXT NOT NULL,member TEXT NOT NULL,claim TEXT,device TEXT);
CREATE INDEX IF NOT EXISTS delivery_phone_pair_owner ON delivery_phone_pairs(enrollment);
CREATE TABLE IF NOT EXISTS delivery_phone_devices(id TEXT PRIMARY KEY,pair_id TEXT NOT NULL UNIQUE,enrollment TEXT NOT NULL,credential TEXT NOT NULL UNIQUE,label TEXT NOT NULL,post INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS delivery_phone_device_owner ON delivery_phone_devices(enrollment);
CREATE TABLE IF NOT EXISTS delivery_phone_revokes(id TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,input TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS delivery_phone_posts(key TEXT PRIMARY KEY,device TEXT NOT NULL,input TEXT NOT NULL,body TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS delivery_phone_pair_once BEFORE UPDATE ON delivery_phone_pairs WHEN OLD.claim IS NOT NULL OR NEW.id<>OLD.id OR NEW.enrollment<>OLD.enrollment OR NEW.secret<>OLD.secret OR NEW.expires<>OLD.expires OR NEW.label<>OLD.label OR NEW.post<>OLD.post OR NEW.binding<>OLD.binding OR NEW.member<>OLD.member BEGIN SELECT RAISE(ABORT,'retained phone pairing'); END;`;
type Actor = { installation_id: string; member_id: string; state: string; display_name: string };
type Pair = {
  id: string;
  enrollment: string;
  secret: string;
  expires: number;
  label: string;
  post: number;
  binding: string;
  member: string;
  claim: string | null;
  device: string | null;
};
type Device = {
  id: string;
  pair_id: string;
  enrollment: string;
  credential: string;
  label: string;
  post: number;
};
class Refused extends Error {
  constructor(readonly code: 'denied' | 'invalid' | 'conflict' | 'limit' | 'unavailable') {
    super(code);
  }
}
function refusal(code: Refused['code']): never {
  throw new Refused(code);
}
const envelope = z.strictObject({
  groupId: z.uuid(),
  credential: membershipCapabilitySchema,
  command: groupPhoneManageCommandSchema,
});
const incoming = z.strictObject({
  groupId: z.uuid(),
  credential: membershipCapabilitySchema.optional(),
  command: groupPhoneCommandSchema,
});
const uuid = async (parts: string[]) => {
  const h = await digest(publicationCanonical(parts));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** Narrow per-group phone authority; immutable posts use the existing delivery ledger. */
export class GroupPhone {
  private features: GroupFeatureStorage;
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private delivery: DeliveryStorage,
    private admit: () => void,
    private invalidate: () => void,
  ) {
    delivery.recover();
    this.features = new GroupFeatureStorage(ctx.storage);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(schema).toArray();
      for (const table of [
        'delivery_phone_devices',
        'delivery_phone_revokes',
        'delivery_phone_posts',
      ])
        ctx.storage.sql
          .exec(
            `CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable phone receipt'); END;`,
          )
          .toArray();
      for (const table of [
        'delivery_phone_pairs',
        'delivery_phone_devices',
        'delivery_phone_revokes',
        'delivery_phone_posts',
      ]) {
        ctx.storage.sql
          .exec(
            `CREATE TRIGGER IF NOT EXISTS ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retained phone receipt'); END;`,
          )
          .toArray();
        this.features.track(table);
      }
    });
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...args: SqlStorageValue[]
  ): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...args).toArray();
  }
  private group(id: string) {
    if (
      !hostingEnvironment(this.env) ||
      !this.ctx.id.equals(this.env.GROUPS.idFromName(id)) ||
      this.rows<{ group_id: string }>('SELECT group_id FROM metadata WHERE singleton=1')[0]
        ?.group_id !== id
    )
      refusal('denied');
    this.delivery.probe();
  }
  private actor(hash: string): Actor {
    const actor = this.rows<Actor>(
      'SELECT installation_id,member_id,state,display_name FROM enrollments WHERE credential_hash=?',
      hash,
    )[0];
    if (actor?.state !== 'active') refusal('denied');
    return actor;
  }
  private current(id: string, hash: string) {
    const device = this.rows<Device>(
      'SELECT * FROM delivery_phone_devices WHERE id=? AND credential=?',
      id,
      hash,
    )[0];
    return (
      !!device &&
      !this.rows('SELECT id FROM delivery_phone_revokes WHERE id=?', id).length &&
      this.rows<Actor>(
        'SELECT state FROM enrollments WHERE credential_hash=?',
        device.enrollment,
      )[0]?.state === 'active'
    );
  }
  private device(hash: string): Device {
    const device = this.rows<Device>(
      'SELECT * FROM delivery_phone_devices WHERE credential=?',
      hash,
    )[0];
    if (!device || !this.current(device.id, hash)) refusal('denied');
    this.actor(device.enrollment);
    return device;
  }
  private list(hash: string) {
    return groupPhoneDevicesSchema.parse({
      devices: this.rows<Device>(
        'SELECT d.* FROM delivery_phone_devices d WHERE enrollment=? ORDER BY CASE WHEN EXISTS(SELECT 1 FROM delivery_phone_revokes r WHERE r.id=d.id) THEN 1 ELSE 0 END,d.rowid DESC LIMIT ?',
        hash,
        L.devicePage,
      ).map((d) => ({
        id: d.id,
        label: d.label,
        allowPost: !!d.post,
        state: this.rows('SELECT id FROM delivery_phone_revokes WHERE id=?', d.id).length
          ? 'revoked'
          : 'active',
      })),
    });
  }
  async manage(raw: unknown): Promise<GroupPhoneResult> {
    try {
      const { groupId, credential, command } = envelope.parse(raw),
        hash = await capabilityHash(groupId, 'installation', credential);
      const pairHash =
        command.kind === 'pair'
          ? await capabilityHash(groupId, 'phone-pair', command.pairSecret)
          : '';
      const value = this.ctx.storage.transactionSync(() => {
        this.group(groupId);
        const actor = this.actor(hash);
        if (command.kind === 'list') return this.list(hash);
        if (command.kind === 'pair') {
          if (
            command.binding.remoteGroupId !== groupId ||
            command.binding.groupId !== groupId ||
            command.binding.installationId !== actor.installation_id ||
            command.memberId !== actor.member_id
          )
            refusal('denied');
          const old = this.rows<Pair>(
            'SELECT * FROM delivery_phone_pairs WHERE id=?',
            command.operationId,
          )[0];
          if (old) {
            if (
              old.enrollment !== hash ||
              !equalHash(old.secret, pairHash) ||
              old.binding !== publicationCanonical(command.binding) ||
              old.member !== command.memberId ||
              old.label !== command.label ||
              old.post !== Number(command.allowPost) ||
              old.expires !== command.expiresAt
            )
              refusal('conflict');
            return { kind: 'pair', pairId: old.id, expiresAt: old.expires };
          }
          if (
            command.expiresAt <= Date.now() ||
            command.expiresAt > Date.now() + L.pairMs ||
            this.rows<{ id: string }>(
              'SELECT d.id FROM delivery_phone_devices d WHERE d.enrollment=? AND NOT EXISTS(SELECT 1 FROM delivery_phone_revokes r WHERE r.id=d.id) LIMIT ?',
              hash,
              L.activeDevices,
            ).length >= L.activeDevices
          )
            refusal('limit');
          // An expired, unclaimed link can never consume its future claim or
          // revoke reservation. Keep its immutable receipt, releasing only unused
          // reserved space in a bounded pass; no history/capability is deleted.
          for (const expired of this.rows<{ id: string }>(
            "SELECT p.id FROM delivery_phone_pairs p JOIN delivery_feature_reservations r ON r.id='phone:'||p.id WHERE p.claim IS NULL AND p.expires<=? LIMIT 64",
            Date.now(),
          ))
            this.features.release(`phone:${expired.id}`);
          this.admit();
          this.features.reserve(`phone:${command.operationId}`, 8192, 262144);
          this.features.account(
            () =>
              this.ctx.storage.sql
                .exec(
                  'INSERT INTO delivery_phone_pairs VALUES(?,?,?,?,?,?,?,?,NULL,NULL)',
                  command.operationId,
                  hash,
                  pairHash,
                  command.expiresAt,
                  command.label,
                  Number(command.allowPost),
                  publicationCanonical(command.binding),
                  command.memberId,
                )
                .toArray(),
            4096,
          );
          return { kind: 'pair', pairId: command.operationId, expiresAt: command.expiresAt };
        }
        const d = this.rows<Device>(
          'SELECT * FROM delivery_phone_devices WHERE id=? AND enrollment=?',
          command.deviceId,
          hash,
        )[0];
        if (!d) refusal('denied');
        const exact = publicationCanonical(command),
          old = this.rows<{ key: string; input: string }>(
            'SELECT key,input FROM delivery_phone_revokes WHERE id=? OR key=?',
            d.id,
            command.operationId,
          )[0];
        if (old) {
          if (old.key !== command.operationId || old.input !== exact) refusal('conflict');
          return this.list(hash);
        }
        this.features.account(
          () =>
            this.ctx.storage.sql
              .exec(
                'INSERT INTO delivery_phone_revokes VALUES(?,?,?)',
                d.id,
                command.operationId,
                exact,
              )
              .toArray(),
          1024,
          `phone:${d.pair_id}`,
        );
        this.features.release(`phone:${d.pair_id}`);
        return this.list(hash);
      });
      await this.ctx.storage.sync();
      return { ok: true, value };
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof z.ZodError
            ? 'invalid'
            : e instanceof Refused
              ? e.code
              : e instanceof GroupFeatureStorageLimit
                ? 'limit'
                : 'unavailable',
      };
    }
  }
  async request(raw: unknown): Promise<GroupPhoneResult> {
    try {
      const { groupId, credential, command } = incoming.parse(raw);
      if (command.kind === 'claim') {
        if (credential) refusal('denied');
        const hash = await capabilityHash(groupId, 'phone-pair', command.pairSecret),
          deviceHash = await capabilityHash(groupId, 'phone-device', command.deviceCredential),
          exact = await digest(publicationCanonical(command));
        const value = this.ctx.storage.transactionSync(() => {
          this.group(groupId);
          const pair = this.rows<Pair>(
            'SELECT * FROM delivery_phone_pairs WHERE id=? AND secret=?',
            command.pairId,
            hash,
          )[0];
          if (!pair || pair.expires !== command.expiresAt || pair.expires <= Date.now())
            refusal('denied');
          this.actor(pair.enrollment);
          if (pair.claim) {
            if (
              !equalHash(pair.claim, exact) ||
              pair.device !== command.deviceId ||
              !this.current(command.deviceId, deviceHash)
            )
              refusal('denied');
          } else {
            if (
              this.rows<{ id: string }>(
                'SELECT d.id FROM delivery_phone_devices d WHERE d.enrollment=? AND NOT EXISTS(SELECT 1 FROM delivery_phone_revokes r WHERE r.id=d.id) LIMIT ?',
                pair.enrollment,
                L.activeDevices,
              ).length >= L.activeDevices
            )
              refusal('limit');
            this.features.account(
              () => {
                this.ctx.storage.sql
                  .exec(
                    'INSERT INTO delivery_phone_devices VALUES(?,?,?,?,?,?)',
                    command.deviceId,
                    pair.id,
                    pair.enrollment,
                    deviceHash,
                    pair.label,
                    pair.post,
                  )
                  .toArray();
                this.ctx.storage.sql
                  .exec(
                    'UPDATE delivery_phone_pairs SET claim=?,device=? WHERE id=?',
                    exact,
                    command.deviceId,
                    pair.id,
                  )
                  .toArray();
              },
              4096,
              `phone:${pair.id}`,
            );
          }
          return { kind: 'claimed', deviceId: command.deviceId, allowPost: !!pair.post };
        });
        await this.ctx.storage.sync();
        return { ok: true, value };
      }
      if (!credential) refusal('denied');
      const hash = await capabilityHash(groupId, 'phone-device', credential);
      const device = this.ctx.storage.transactionSync(() => {
        this.group(groupId);
        return this.device(hash);
      });
      if (command.kind === 'feed')
        return {
          ok: true,
          value: this.ctx.storage.transactionSync(() => {
            this.group(groupId);
            this.device(hash);
            const actor = this.actor(device.enrollment),
              group = this.rows<{ group_name: string }>(
                'SELECT group_name FROM metadata WHERE singleton=1',
              )[0];
            const rows = this.rows<{ header: string; sequence: number; display_name: string }>(
              "SELECT o.header,o.sequence,e.display_name FROM delivery_operations o JOIN delivery_authors a USING(operation_id) JOIN enrollments e ON e.installation_id=a.installation_id WHERE o.state='committed' AND o.sequence<? AND o.sequence>? ORDER BY o.sequence DESC LIMIT ?",
              command.before ?? Number.MAX_SAFE_INTEGER,
              command.since,
              L.page + 1,
            );
            const entries = rows
              .slice(0, L.page)
              .reverse()
              .map((r) => {
                const h = JSON.parse(r.header) as PublicationHeader;
                return {
                  id: h.event.eventId,
                  sequence: r.sequence,
                  author: r.display_name,
                  text: h.event.condensedText,
                  recordedAt: h.event.recordedAt,
                  bytes: h.event.manifest.bytes,
                };
              });
            return {
              kind: 'feed',
              groupName: group.group_name,
              self: actor.display_name,
              deviceId: device.id,
              allowPost: !!device.post,
              entries,
              next: rows.length > L.page ? entries[0]!.sequence : null,
            };
          }),
        };
      if (command.kind === 'original') {
        const result = await this.delivery.forPhone(
          {
            groupId,
            command: { kind: 'expand', eventId: command.eventId, start: command.start, count: 1 },
          },
          device.enrollment,
          () => this.current(device.id, hash),
          this.ctx,
          this.env,
        );
        if (!result.ok) return result;
        if (result.value.kind !== 'expansion') refusal('unavailable');
        return {
          ok: true,
          value: {
            kind: 'original',
            eventId: command.eventId,
            start: command.start,
            text: result.value.chunks.map((c) => c.text).join(''),
            next: result.value.next,
          },
        };
      }
      return await this.post(groupId, device, hash, command);
    } catch (e) {
      return {
        ok: false,
        error:
          e instanceof z.ZodError
            ? 'invalid'
            : e instanceof Refused
              ? e.code
              : e instanceof GroupFeatureStorageLimit
                ? 'limit'
                : 'unavailable',
      };
    }
  }
  private async post(
    groupId: string,
    device: Device,
    hash: string,
    command: Extract<GroupPhoneCommand, { kind: 'post' }>,
  ): Promise<GroupPhoneResult> {
    if (!device.post) refusal('denied');
    const ids = await Promise.all(
        ['event', 'entity', 'source', 'publication'].map((kind) =>
          uuid([groupId, device.id, command.key, kind]),
        ),
      ),
      textHash = await digest(command.text),
      exact = publicationCanonical(command);
    const body = this.ctx.storage.transactionSync(() => {
      this.group(groupId);
      this.device(hash);
      const old = this.rows<{ device: string; input: string; body: string }>(
        'SELECT device,input,body FROM delivery_phone_posts WHERE key=?',
        command.key,
      )[0];
      if (old) {
        if (old.device !== device.id || old.input !== exact) refusal('conflict');
        return JSON.parse(old.body) as {
          header: PublicationHeader;
          chunks: { index: number; text: string; bytes: number; sha256: string }[];
        };
      }
      const pair = this.rows<Pair>(
          'SELECT * FROM delivery_phone_pairs WHERE id=?',
          device.pair_id,
        )[0],
        binding = JSON.parse(pair.binding),
        bytes = new TextEncoder().encode(command.text).length;
      const event = groupEventSchema.parse({
        eventId: ids[0],
        sequence: 1,
        scope: {
          groupId: binding.groupId,
          memberId: pair.member,
          installationId: binding.installationId,
          visibility: 'shared',
          source: {
            sessionId: device.id,
            provider: 'owner',
            nativeSessionId: device.id,
            messageId: command.key,
          },
          causalRefs: [],
        },
        operationId: command.key,
        entityId: ids[1],
        revision: 1,
        category: 'Question',
        condensedText: Array.from(command.text).slice(0, 900).join(''),
        evidenceRefs: [],
        corrects: null,
        manifest: { bytes, sha256: textHash, chunks: [{ index: 0, bytes, sha256: textHash }] },
        recordedAt: new Date().toISOString(),
      });
      const prepared = publicationEnvelope(binding, ids[3], { event, original: command.text }),
        serialized = publicationCanonical(prepared);
      this.admit();
      this.features.account(
        () =>
          this.ctx.storage.sql
            .exec(
              'INSERT INTO delivery_phone_posts VALUES(?,?,?,?)',
              command.key,
              device.id,
              exact,
              serialized,
            )
            .toArray(),
        new TextEncoder().encode(serialized + exact).length + 4096,
      );
      return prepared;
    });
    await this.ctx.storage.sync();
    const run = (command: Parameters<DeliveryStorage['forPhone']>[0]['command']) =>
      this.delivery.forPhone(
        { groupId, command },
        device.enrollment,
        () => this.current(device.id, hash),
        this.ctx,
        this.env,
      );
    const registered = await run({
      kind: 'registerSource',
      operationId: ids[2],
      binding: body.header.binding,
      memberId: body.header.event.scope.memberId,
      source: {
        sessionId: device.id,
        provider: 'owner',
        nativeSessionId: device.id,
        messageId: command.key,
      },
    });
    if (!registered.ok) return registered;
    const key = {
      version: body.header.version,
      binding: body.header.binding,
      operationId: body.header.operationId,
      payloadHash: body.header.payloadHash,
    };
    for (const packet of [
      { kind: 'begin' as const, header: body.header },
      { kind: 'chunk' as const, key, chunk: body.chunks[0]! },
      { kind: 'commit' as const, key },
    ]) {
      const result = await run({ kind: 'effect', packet });
      if (!result.ok) return result;
      if (result.value.kind === 'receipt' && result.value.receipt.state === 'collision')
        refusal('conflict');
      if (
        packet.kind === 'commit' &&
        result.value.kind === 'receipt' &&
        result.value.receipt.state === 'committed'
      ) {
        this.invalidate();
        return {
          ok: true,
          value: {
            kind: 'posted',
            key: command.key,
            eventId: result.value.receipt.eventId,
            sequence: result.value.receipt.remoteSequence,
          },
        };
      }
    }
    refusal('unavailable');
  }
}
