import { DELIVERY_LIMITS } from '@dock/shared/dist/group-delivery.js';
import { MEMBERSHIP_LIMITS as L } from '@dock/shared/dist/group-membership.js';

// Application storage envelope, not a provider quota or preallocated storage.
// See GROUP_HOSTING.md for the payload/page derivation and local SQLite evidence.
const pageBytes = 4096;
const treeRows = [
  L.enrollments, // enrollments table
  L.enrollments, // enrollment_state index
  L.historyOperations, // invitations table (conservative: every normal operation issued one)
  L.historyOperations, // invitation_state_expiry index
  L.historyOperations, // receipts table, including all remaining member revocations
  L.historyOperations, // receipts primary-key index
  L.historyOperations, // audit table
  1, // metadata table
  2, // sqlite_sequence: enrollments and audit
  L.enrollments, // bounded failed-revocation markers table
  L.enrollments, // marker primary-key index (each target appears at most once)
] as const;
// Payloads fit on one leaf cell with no overflow. Charge a whole leaf per row,
// a whole interior page per leaf, and an extra root for each touched tree.
// This covers an entire replacement of those trees, including unchanged rows.
const treePages = treeRows.reduce((sum, rows) => sum + 2 * rows + 1, 0);
const maxDepth = Math.ceil(Math.log2(L.historyOperations + 1)) + 1;
// SQLite balance_nonroot has up to 3 old / 5 new siblings. Charge 6 additional
// pages at every level of every tree, even though modifications are sequential.
const balancingPages = treeRows.length * 6 * maxDepth;
// Auto-vacuum pointer maps use 5 bytes/page; include them even if disabled.
const pointerMapPages =
  Math.ceil(
    (L.databaseBytes / pageBytes +
      DELIVERY_LIMITS.databaseBytes / pageBytes +
      treePages +
      balancingPages) /
      (Math.floor(pageBytes / 5) - 1),
  ) + 1;

export const MEMBERSHIP_CAPACITY = {
  // Membership envelope within the proposed 250 MB/group budget. Pointer maps
  // include the separately fenced delivery allocation; revocation touches no event trees.
  // This does not allocate event storage or reserve any provider quota.
  designBudgetBytes: 128 * 1_048_576,
  pageBytes,
  normalOperations: L.historyOperations - L.enrollments,
  normalDatabaseBytes: L.databaseBytes,
  treePages,
  balancingPages,
  pointerMapPages,
  revocationReserveBytes: (treePages + balancingPages + pointerMapPages) * pageBytes,
  reservedDatabaseBytes:
    L.databaseBytes + (treePages + balancingPages + pointerMapPages) * pageBytes,
} as const;
