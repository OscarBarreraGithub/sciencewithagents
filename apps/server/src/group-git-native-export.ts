import { z } from 'zod';
import { groupScopeSchema } from '@dock/shared';
import { digest, GroupGitBlocked } from './group-git.js';
import { gitOid } from './group-git-endpoint.js';
import type { PinnedGitResource } from './group-git-host-files.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
/** Protected owning-host port. Native owner must resolve the exact source in its admitted
 * guest, inspect complete reachable history against contentPaths BEFORE exporting bytes,
 * freeze a NEW read-only resource outside all guest write mounts, and durably attest it.
 * A Node pathname/symlink check or browser receipt is never an implementation of this port. */
export const gitNativeExportRequestSchema = z.strictObject({
  exportId: z.uuid(),
  operationId: id,
  repositoryId: id,
  resourceId: id,
  scope: groupScopeSchema,
  grantRevision: id,
  reviewId: id,
  sourceOid: gitOid,
  historyRevision: id,
  contentPaths: z.array(z.string()).max(10000),
  maxObjects: z.number().int().positive().max(10000),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
});
export type GitNativeExportRequest = z.infer<typeof gitNativeExportRequestSchema>;
export const gitNativeExportReceiptSchema = z.strictObject({
  exportId: z.uuid(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceOid: gitOid,
  /** gitObjectManifest over the exact complete reachable object closure. */
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nativeReceiptId: id,
  boundary: z.literal('native-immutable-git-export-v1'),
});
export type GitNativeExportReceipt = z.infer<typeof gitNativeExportReceiptSchema>;
export interface GitNativeExportLease {
  readonly receipt: GitNativeExportReceipt;
  readonly resource: PinnedGitResource;
  /** Native owner rechecks admission, revocation, receipt and actual read-only boundary. */
  revalidate(): Promise<GitNativeExportReceipt>;
}
export interface GitNativeExports {
  acquire(request: GitNativeExportRequest): Promise<GitNativeExportLease>;
  /** Read-only same-ID recovery. Never starts a new native export after an uncertain intent. */
  inspect(exportId: string): Promise<GitNativeExportLease | null>;
}
export async function verifyGitNativeExport(
  lease: GitNativeExportLease,
  request: GitNativeExportRequest,
): Promise<void> {
  const receipt = gitNativeExportReceiptSchema.parse(lease.receipt);
  if (
    receipt.exportId !== request.exportId ||
    receipt.requestDigest !== digest(request) ||
    receipt.sourceOid !== request.sourceOid ||
    !lease.resource.bare ||
    digest(gitNativeExportReceiptSchema.parse(await lease.revalidate())) !== digest(receipt)
  )
    throw new GroupGitBlocked('Native immutable export receipt/request changed');
}
