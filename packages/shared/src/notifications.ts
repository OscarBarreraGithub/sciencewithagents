import { z } from 'zod';
import type { AttentionItem } from './attention.js';

/** Only stops that cannot continue without the owner. Ready-to-apply changes and backups wait quietly. */
export const escalationKinds = ['approval', 'decision', 'failed', 'interrupted'] as const;
export type EscalationKind = (typeof escalationKinds)[number];
export const isEscalation = (
  item: Pick<AttentionItem, 'kind'>,
): item is AttentionItem & {
  kind: EscalationKind;
} => (escalationKinds as readonly string[]).includes(item.kind);

/**
 * Standard browser push services. A subscription endpoint is an outbound URL chosen by the
 * browser, so anything else (private hosts, other ports, credentials) is refused before storage.
 */
const pushHosts = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)?push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
export function pushEndpointAllowed(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    (url.port === '' || url.port === '443') &&
    !url.username &&
    !url.password &&
    pushHosts.some((host) => host.test(url.hostname))
  );
}
const base64url = z
  .string()
  .min(16)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);
export const pushSubscribeSchema = z
  .object({
    endpoint: z
      .string()
      .max(1024)
      .refine(pushEndpointAllowed, 'This browser push service is not supported.'),
    keys: z.object({ p256dh: base64url, auth: base64url }).strict(),
    label: z.string().trim().max(60).default('This browser'),
  })
  .strict();
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;
export const pushEndpointSchema = z.object({ endpoint: z.string().max(1024) }).strict();
export const pushSubscriptionRemoveSchema = z.object({ id: z.string().uuid() }).strict();
export const notificationGlobalSchema = z.object({ enabled: z.boolean() }).strict();
export const notificationProjectSchema = z
  .object({ projectId: z.string().uuid(), enabled: z.boolean() })
  .strict();

export const notificationSubscriptionViewSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    /** Push service host only; the capability URL itself is never returned. */
    service: z.string(),
    createdAt: z.string(),
    lastSuccessAt: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    mine: z.boolean(),
  })
  .strict();
export const notificationStatusSchema = z
  .object({
    /** Absent in demo/embedded servers or when private key storage is unavailable. */
    available: z.boolean(),
    publicKey: z.string().nullable(),
    enabled: z.boolean(),
    projects: z.array(
      z.object({ id: z.string().uuid(), name: z.string(), enabled: z.boolean() }).strict(),
    ),
    subscriptions: z.array(notificationSubscriptionViewSchema),
    /** Other identities' subscriptions are counted, not listed, for paired devices. */
    otherSubscriptions: z.number().int().nonnegative(),
  })
  .strict();
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

/** Lock-screen payload: project name, generic blocker kind and a same-origin hash route. */
export const pushPayloadSchema = z
  .object({
    title: z.string().max(80),
    body: z.string().max(160),
    // `?computer=entry` pins the opened document to the computer that sent the push.
    url: z.string().regex(/^\/(?:\?computer=entry)?(?:#\/chat\/[0-9a-f-]{36})?$/i),
    tag: z.string().max(64),
  })
  .strict();
export type PushPayload = z.infer<typeof pushPayloadSchema>;

const kindText: Record<EscalationKind, [string, string]> = {
  approval: ['approval is waiting', 'approvals are waiting'],
  decision: ['task needs your decision', 'tasks need your decision'],
  failed: ['run stopped with an error', 'runs stopped with an error'],
  interrupted: ['run was interrupted', 'runs were interrupted'],
};
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/**
 * Never include titles, prompts, commands or output: approval titles may contain command text.
 * The owner opens the app to see details behind its normal authentication.
 */
export function escalationPayload(
  projectName: string,
  items: Array<Pick<AttentionItem, 'kind' | 'agentId' | 'projectId'>>,
): PushPayload {
  const counts = new Map<EscalationKind, number>();
  for (const item of items)
    if (isEscalation(item)) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = escalationKinds
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const count = counts.get(kind)!;
      return count === 1
        ? `An ${kindText[kind][0]}`.replace(/^An (?=[^aeiou])/i, 'A ')
        : `${count} ${kindText[kind][1]}`;
    });
  return pushPayloadSchema.parse({
    title: clip(`${projectName} needs you`, 80),
    body: clip(`${parts.join('; ')}. Open the app to continue.`, 160),
    url: `/?computer=entry#/chat/${items[0]!.agentId}`,
    tag: `dock-${items[0]!.projectId}`.slice(0, 64),
  });
}
