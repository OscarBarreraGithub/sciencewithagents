import type { GroupContext } from '@dock/shared';
import type { GroupDocumentsAuthority, GroupDocumentAuthority } from './group-documents-native.js';
/** Concrete normal GroupHost.authenticatedContext adapter; no synthetic Store agent mapping.
 * The normal owner supplies revalidateDocumentOwner against its persisted local enrollment
 * and current remote membership, comparing every context field before issuing authority.
 */
export function createGroupDocumentsAuthority(host: {
  authenticatedContext(input: {
    handle: string;
  }): Promise<{ context: GroupContext; revalidate(): Promise<void> }>;
  revalidateDocumentOwner(context: GroupContext): Promise<void>;
}): GroupDocumentsAuthority {
  return {
    async resolve(handle): Promise<GroupDocumentAuthority> {
      const resolved = await host.authenticatedContext({ handle });
      return { context: resolved.context, revalidate: () => resolved.revalidate() };
    },
    revalidateOwner: (context) => host.revalidateDocumentOwner(context),
  };
}
