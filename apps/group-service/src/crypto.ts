export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export const capabilityHash = (groupId: string, purpose: string, secret: string): Promise<string> =>
  digest(JSON.stringify(['dock-membership-v1', groupId, purpose, secret]));
export const setupHash = (secret: string): Promise<string> =>
  digest(`dock-group-setup-v1:${secret}`);
export function equalHash(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(a), new TextEncoder().encode(b));
}
// The setup operation routes retries to the same generated group, without a global coordinator.
export async function creationGroupId(setupDigest: string, operationId: string): Promise<string> {
  const h = await digest(JSON.stringify(['dock-group-id-v1', setupDigest, operationId]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const localTestMode = (mode: string): boolean => mode === 'local-test';

export const hostingApprovalHash = (secret: string): Promise<string> =>
  digest(`dock-hosting-approval-v1:${secret}`);
export function hostingEnvironment(env: Env): boolean {
  if (localTestMode(env.HOSTING_MODE)) return true;
  if (String(env.HOSTING_MODE) !== 'hosted' || !/^[a-f0-9]{64}$/.test(env.HOSTING_APPROVAL_HASH))
    return false;
  try {
    const url = new URL(env.HOSTING_ORIGIN);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      url.origin === env.HOSTING_ORIGIN
    );
  } catch {
    return false;
  }
}
