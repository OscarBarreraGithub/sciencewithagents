/** The one-use code belongs in a fragment, never an HTTP path or query string. */
export function pairingLink(origin: string, code: string): string {
  const url = new URL('/', origin);
  url.hash = `pair=${encodeURIComponent(code)}`;
  return url.href;
}

/** Read once before React/network startup, then remove the secret from this history entry. */
export function readPairingCode(): string {
  const fragment = window.location.hash;
  const params = new URLSearchParams(fragment.slice(1));
  if (!params.has('pair')) return '';
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  if (fragment.length > 128 || [...params.keys()].length !== 1) return '';
  const raw = (params.get('pair') ?? '').toUpperCase().replace(/-/g, '');
  if (!/^[A-HJ-NP-Z2-9]{16}$/.test(raw)) return '';
  return raw.match(/.{4}/g)!.join('-');
}
