import { distributionSchema } from '@dock/shared/dist/distribution.js';
/** Pin only this document before api.ts evaluates; saved full-SWA host choices stay intact. */
export function pinGroupsEntry() {
  const url = new URL(location.href);
  url.searchParams.set('computer', 'entry');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
export async function readDistribution(): Promise<'groups-only' | 'full-swa'> {
  const response = await fetch('/api/distribution', { credentials: 'same-origin' });
  if (!response.ok) {
    const message = await response
      .text()
      .then((text) => {
        if (text.length > 4096) return null;
        try {
          const value: unknown = JSON.parse(text);
          return value &&
            typeof value === 'object' &&
            'error' in value &&
            typeof value.error === 'string' &&
            value.error.length <= 500
            ? value.error
            : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    throw new Error(message ?? 'The computer is unavailable. Retry when the app is running.');
  }
  const result = distributionSchema.safeParse(await response.json());
  if (!result.success)
    throw new Error('This app entry could not be identified. Reopen your installed app.');
  return result.data.distribution;
}
