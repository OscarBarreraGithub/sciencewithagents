import { equalHash, localTestMode } from './crypto.js';
/** Purpose-separated routing proof rejects random public group IDs before DO creation.
 * The hosting approval digest is a deployment variable, visible to dashboard readers,
 * never sent to the phone. This allocation proof does not replace device authorization. */
export async function phoneProof(env: Env, parts: (string | number)[]): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(
      env.HOSTING_APPROVAL_HASH || (localTestMode(env.HOSTING_MODE) ? 'swa-phone-local-test' : ''),
    ),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(JSON.stringify(['swa-phone-routing-v1', ...parts])),
  );
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export async function phoneProofMatches(env: Env, parts: (string | number)[], proof: string) {
  return equalHash(await phoneProof(env, parts), proof);
}
