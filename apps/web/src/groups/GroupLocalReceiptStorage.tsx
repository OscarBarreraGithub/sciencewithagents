import type { groupHostListSchema } from '@dock/shared/dist/group-host.js';

type Storage = NonNullable<
  ReturnType<typeof groupHostListSchema.parse>['service']['localReceiptStorage']
>;
/** Existing list metadata only; this is neither a disk nor a hosted quota measurement. */
export function GroupLocalReceiptStorage({ storage }: { storage: Storage }) {
  const nearLimit = storage.bytes / storage.limitBytes >= 0.8;
  const mib = (value: number) => (value / (1024 * 1024)).toFixed(1);
  return (
    <section className="group-local-receipt-storage" aria-label="Local recovery records">
      <h3>Local recovery records</h3>
      <p>
        Last reported on this computer:{' '}
        <strong>
          {mib(storage.bytes)} of {mib(storage.limitBytes)} MiB
        </strong>{' '}
        for normal receipt admission.
      </p>
      <p>
        This counts retained Groups receipts and reserved send records across saved groups. It is
        separate from Cloudflare storage, other local data and physical disk usage. Recovery
        controls have a separate reserve.
      </p>
      {(storage.full || nearLimit) && (
        <p role="status">
          {storage.full
            ? 'The normal receipt allowance is full; new contributions may be refused.'
            : 'Local recovery records are approaching their limit.'}{' '}
          Ask your setup agent to preserve records and check capacity. Existing receipts are
          retained; the app does not prune them automatically.
        </p>
      )}
    </section>
  );
}
