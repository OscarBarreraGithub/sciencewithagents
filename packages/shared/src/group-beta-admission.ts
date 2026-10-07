import { z } from 'zod';

export const GROUP_BETA_LIMITS = {
  tokenBytes: 1024,
  setupCodeBytes: 2048,
  creationDays: 90,
} as const;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const kid = z.string().regex(/^[a-f0-9]{16}$/);
export const groupBetaKeysSchema = z
  .array(
    z.strictObject({
      kid,
      publicKey: hex,
      state: z.enum(['create+route', 'route-only']),
    }),
  )
  .min(1)
  .max(4)
  .refine((keys) => new Set(keys.map((k) => k.kid)).size === keys.length);
const instant = z.number().int().nonnegative().safe();
export const groupBetaProfileSchema = z.strictObject({
  version: z.literal(1),
  serviceId: z.uuid(),
  endpointId: z.uuid(),
  origin: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const u = new URL(value);
      return u.protocol === 'https:' && u.origin === value && !u.username && !u.password;
    }),
  keys: groupBetaKeysSchema,
});
export type GroupBetaProfile = z.infer<typeof groupBetaProfileSchema>;
export const groupBetaAdmissionPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    serviceId: z.uuid(),
    kid,
    groupId: z.uuid(),
    createOperationId: z.uuid(),
    createCapabilityHash: hex,
    issuedAt: instant,
    createExpiresAt: instant,
  })
  .refine(
    (v) =>
      v.createExpiresAt > v.issuedAt &&
      v.createExpiresAt - v.issuedAt <= GROUP_BETA_LIMITS.creationDays * 86_400_000,
  );
export type GroupBetaAdmissionPayload = z.infer<typeof groupBetaAdmissionPayloadSchema>;
export const groupBetaAdmissionSchema = z
  .string()
  .max(GROUP_BETA_LIMITS.tokenBytes)
  .regex(/^[a-f0-9]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
export const groupBetaSetupSchema = z.strictObject({
  version: z.literal(1),
  admission: groupBetaAdmissionSchema,
  createCapability: hex,
});
export type GroupBetaSetup = z.infer<typeof groupBetaSetupSchema>;
const prefix = 'swa-groups-beta-v1:';
export function groupBetaEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export function groupBetaDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > GROUP_BETA_LIMITS.setupCodeBytes)
    throw new Error('Invalid Groups beta code.');
  const raw = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (groupBetaEncode(bytes) !== value) throw new Error('Invalid Groups beta code.');
  return bytes;
}
function signedRawBytes(keyId: string, raw: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(`dock-group-beta-admission-v1:${keyId}:`);
  const bytes = new Uint8Array(label.length + raw.length);
  bytes.set(label);
  bytes.set(raw, label.length);
  return bytes;
}
export function groupBetaSigningBytes(payload: GroupBetaAdmissionPayload): Uint8Array<ArrayBuffer> {
  const parsed = groupBetaAdmissionPayloadSchema.parse(payload);
  return signedRawBytes(parsed.kid, new TextEncoder().encode(JSON.stringify(parsed)));
}
export function encodeGroupBetaAdmission(
  payload: GroupBetaAdmissionPayload,
  signature: Uint8Array,
): string {
  const parsed = groupBetaAdmissionPayloadSchema.parse(payload);
  const body = groupBetaEncode(new TextEncoder().encode(JSON.stringify(parsed)));
  return groupBetaAdmissionSchema.parse(`${parsed.kid}.${body}.${groupBetaEncode(signature)}`);
}
function parsePayload(raw: Uint8Array<ArrayBuffer>, keyId: string): GroupBetaAdmissionPayload {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const parsed = groupBetaAdmissionPayloadSchema.parse(JSON.parse(text));
  if (parsed.kid !== keyId || JSON.stringify(parsed) !== text)
    throw new Error('Invalid Groups beta code.');
  return parsed;
}
/** Decode is not authorization; use verify before any protected network request. */
export function decodeGroupBetaAdmission(admission: string): GroupBetaAdmissionPayload {
  const [keyId, body] = groupBetaAdmissionSchema.parse(admission).split('.');
  return parsePayload(groupBetaDecode(body), keyId);
}
/** Signature/service identity only. Creation expiry never expires member routing. */
export async function verifyGroupBetaAdmission(
  admission: string,
  profile: GroupBetaProfile,
): Promise<GroupBetaAdmissionPayload> {
  const pinned = groupBetaProfileSchema.parse(profile);
  const [keyId, body, signatureText] = groupBetaAdmissionSchema.parse(admission).split('.');
  const trusted = pinned.keys.find((k) => k.kid === keyId);
  if (!trusted) throw new Error('Invalid Groups beta admission.');
  const keyBytes = Uint8Array.from(trusted.publicKey.match(/../g)!, (b) => parseInt(b, 16));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, [
    'verify',
  ]);
  const raw = groupBetaDecode(body);
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      groupBetaDecode(signatureText),
      signedRawBytes(keyId, raw),
    ))
  )
    throw new Error('Invalid Groups beta admission.');
  const payload = parsePayload(raw, keyId);
  if (payload.serviceId !== pinned.serviceId) throw new Error('Invalid Groups beta admission.');
  return payload;
}
export function encodeGroupBetaSetupCode(setup: GroupBetaSetup): string {
  return (
    prefix +
    groupBetaEncode(new TextEncoder().encode(JSON.stringify(groupBetaSetupSchema.parse(setup))))
  );
}
export function parseGroupBetaSetupCode(code: string): GroupBetaSetup {
  if (code.length > GROUP_BETA_LIMITS.setupCodeBytes || !code.startsWith(prefix))
    throw new Error('Invalid Groups beta setup code.');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(
    groupBetaDecode(code.slice(prefix.length)),
  );
  const setup = groupBetaSetupSchema.parse(JSON.parse(raw));
  if (JSON.stringify(setup) !== raw) throw new Error('Invalid Groups beta setup code.');
  return setup;
}
