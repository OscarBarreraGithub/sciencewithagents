import type { GroupContext } from '@dock/shared';
import type {
  GroupDocumentManifest,
  GroupDocumentFile,
  groupDocumentBuildPolicy,
} from '@dock/shared/dist/group-documents.js';
import { groupDocumentOfferFailureMessages } from '@dock/shared/dist/group-documents.js';

/** Only verified capture lifecycle facts can classify a reply as permanently unavailable. */
export class GroupDocumentCaptureError extends Error {
  readonly code: 'GROUP_DOCUMENT_CAPTURE_PENDING' | 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE';
  constructor(readonly disposition: 'pending' | 'unavailable') {
    const code =
      disposition === 'pending'
        ? 'GROUP_DOCUMENT_CAPTURE_PENDING'
        : 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE';
    super(groupDocumentOfferFailureMessages[code]);
    this.code = code;
  }
}

export interface GroupDocumentBytes {
  artifactId: string;
  bytes: Uint8Array;
}
/** Implemented by the native owner: verified durable completed results only, never paths.
 * Export keys are durable: an uncertain reply must reconcile that SAME export, not rerun a tool.
 * Build must execute in a fresh confinement containing only these bytes and compiler system assets.
 * No host TeX process, provider account, arbitrary mounts, network or shell escape fallback.
 */
export interface GroupDocumentsNative {
  describe(resultId: string): Promise<GroupDocumentManifest>;
  export(input: {
    key: string;
    manifest: GroupDocumentManifest;
    artifactIds: string[];
    limits: { bytes: number; timeoutMs: number };
  }): Promise<
    | {
        state: 'completed';
        receiptId: string;
        sourceReceiptId: string;
        version: string;
        files: GroupDocumentBytes[];
      }
    | { state: 'unknown'; receiptId: string }
  >;
  build?(input: {
    key: string;
    grantId: string;
    version: string;
    sourceReceiptId: string;
    context: GroupContext;
    entry: GroupDocumentFile;
    files: (GroupDocumentFile & { content: Uint8Array })[];
    policy: typeof groupDocumentBuildPolicy;
  }): Promise<
    | { state: 'completed'; receiptId: string; grantId: string; version: string; pdf: Uint8Array }
    | { state: 'unknown'; receiptId: string }
  >;
}
export interface GroupDocumentAuthority {
  context: GroupContext;
  revalidate(): Promise<void>;
}
export interface GroupDocumentsAuthority {
  /** Resolve a persisted normal-host slot; browser IDs/labels never create context authority. */
  resolve(handle: string): Promise<GroupDocumentAuthority>;
  /** Recheck the exact source owner enrollment/context, including remote revocation. */
  revalidateOwner(context: GroupContext): Promise<void>;
}
