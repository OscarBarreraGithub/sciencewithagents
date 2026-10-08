/** Node-only local client protocol. Do not export from the browser contract barrel. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { get, type Agent, type IncomingMessage } from 'node:http';
import { z } from 'zod';
export const localRoleSchema = z.enum(['owner', 'bridge', 'host']);
export type LocalRole = z.infer<typeof localRoleSchema>;
const token = z.string().regex(/^[a-f0-9]{64}$/);
export const localChallengeSchema = z.object({ role: localRoleSchema, challenge: token }).strict();
export const localProofSchema = z.object({ nonce: token, proof: token }).strict();
const mac = (key: string, parts: string[]) =>
  createHmac('sha256', key)
    .update(JSON.stringify(['swa-local-v1', ...parts]))
    .digest('hex');
export const localPeerProof = (
  key: string,
  origin: string,
  role: LocalRole,
  challenge: string,
  nonce: string,
) => mac(key, ['peer', origin, role, challenge, nonce]);
export const localRequestProof = (
  key: string,
  origin: string,
  role: LocalRole,
  challenge: string,
  nonce: string,
  method: string,
  path: string,
) => mac(key, ['request', origin, role, challenge, nonce, method, path]);
export function equalLocalProof(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Verify the app before authorizing one request; the durable key never crosses TCP. */
export async function localAuthorization(
  origin: string,
  credential: string,
  role: LocalRole,
  method: string,
  path: string,
  connection?: {
    transportOrigin: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    agent?: Agent;
  },
) {
  token.parse(credential);
  localRoleSchema.parse(role);
  const loopback = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
  if (
    !loopback.test(origin) ||
    (connection && !loopback.test(connection.transportOrigin)) ||
    !path.startsWith('/api/') ||
    path.includes('#')
  )
    throw new Error('Invalid local connection.');
  const challenge = randomBytes(32).toString('hex');
  // The TCP destination may be an SSH forward. Preserve the pinned app's Host header;
  // Node fetch can replace it with the temporary tunnel port. HTTP get never follows redirects.
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(
      `${connection?.transportOrigin ?? origin}/api/local-access/proof?role=${role}&challenge=${challenge}`,
      {
        headers: connection?.headers,
        signal: AbortSignal.timeout(connection?.timeoutMs ?? 5000),
        agent: connection?.agent ?? false,
      },
      resolve,
    ).once('error', reject);
  });
  if (
    response.statusCode !== 200 ||
    !response.headers['content-type']?.includes('application/json')
  ) {
    response.destroy();
    throw new Error(
      'The local app could not be authenticated. Open sciencewithagents and reconnect.',
    );
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const value = Buffer.from(chunk);
      size += value.byteLength;
      if (size > 4096) throw new Error('The local app returned an invalid authentication proof.');
      parts.push(value);
    }
  } finally {
    response.destroy();
  }
  const value = localProofSchema.parse(JSON.parse(Buffer.concat(parts).toString('utf8')));
  if (
    !equalLocalProof(value.proof, localPeerProof(credential, origin, role, challenge, value.nonce))
  )
    throw new Error('This address does not match your saved sciencewithagents connection.');
  return `Dock ${role}.${value.nonce}.${localRequestProof(credential, origin, role, challenge, value.nonce, method, path)}`;
}
