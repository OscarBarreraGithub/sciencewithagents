import {
  GroupPromotionAuthority,
  type GroupPromotionActor,
  type GroupPromotionPolicy,
} from '@dock/shared/dist/group-promotion-authority.js';
import {
  groupPromotionCommandSchema,
  type GroupPromotionCommand,
} from '@dock/shared/dist/group-promotion.js';

/** Structural subset of the existing SQLite DurableObjectStorage. No additional
 * DO, database, alarm, namespace, provider, network endpoint or storage allowance. */
export interface GroupPromotionDoStorage {
  sql: {
    exec<T extends Record<string, string | number | null>>(
      query: string,
      ...args: (string | number | null)[]
    ): { toArray(): T[] };
  };
  transactionSync<T>(work: () => T): T;
}
/** Authenticated same-object adapter. Its policy MUST resolve the current
 * membership and delivery_messages/source author inside these synchronous calls.
 * All allocation checks join the existing capacity ledger. Public JSON is never
 * an actor/source attestation. The existing service owner mounts this handler. */
export class GroupPromotionDoHandler {
  private readonly authority: GroupPromotionAuthority;
  constructor(storage: GroupPromotionDoStorage, policy: GroupPromotionPolicy) {
    this.authority = new GroupPromotionAuthority(
      {
        rows<T extends Record<string, string | number | null>>(
          query: string,
          ...args: (string | number | null)[]
        ): T[] {
          return storage.sql.exec<T>(query, ...args).toArray();
        },
        transaction: (work) => storage.transactionSync(work),
      },
      policy,
    );
  }
  designate(actor: GroupPromotionActor, writer: GroupPromotionActor['installationId']) {
    this.authority.designate(actor, writer);
  }
  command(actor: GroupPromotionActor, raw: GroupPromotionCommand) {
    return this.authority.handle(actor, groupPromotionCommandSchema.parse(raw));
  }
}
