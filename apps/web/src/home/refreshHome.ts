// Existing refresh listeners also serve pull-to-refresh. Collect their real reads
// so the wheel stops when the data arrives, including an already-pending read.
type RefreshDetail = { waitUntil: (reading: Promise<boolean>) => void };

export function trackRefresh(event: Event, reading: Promise<boolean>) {
  if (event instanceof CustomEvent)
    (event.detail as RefreshDetail | undefined)?.waitUntil?.(reading);
}

export async function refreshHome() {
  const readings: Promise<boolean>[] = [];
  window.dispatchEvent(
    new CustomEvent<RefreshDetail>('swa:refresh-home', {
      detail: { waitUntil: (reading) => readings.push(reading) },
    }),
  );
  const results = await Promise.allSettled(readings);
  return results.every((result) => result.status === 'fulfilled' && result.value);
}
