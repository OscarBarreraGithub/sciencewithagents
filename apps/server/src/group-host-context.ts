import type { GroupContext, GroupFeedPage, GroupFeedQuery, GroupEvent } from '@dock/shared';
import type { MembershipIdentity } from '@dock/shared/dist/group-membership.js';
/** Internal authenticated host port, never a browser DTO or bearer grant.
 * Each asynchronous operation rechecks the persisted enrollment and service.
 * Feature adapters must revalidate immediately before dispatching mutations;
 * these read ports do not authorize owner execution or publication. */
export interface GroupHostFeatureContext {
  readonly handle: string;
  readonly enrollmentHandle: string;
  readonly context: Readonly<GroupContext>;
  readonly enrollment: Readonly<MembershipIdentity>;
  revalidate(): Promise<void>;
  readShared(query: GroupFeedQuery): Promise<GroupFeedPage>;
  original(
    eventId: GroupEvent['eventId'],
  ): Promise<{ eventId: GroupEvent['eventId']; text: string }>;
}
