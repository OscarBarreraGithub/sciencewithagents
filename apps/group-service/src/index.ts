import {
  DOCUMENT_TRANSPORT_LIMITS,
  documentTransportCommandSchema,
  type DocumentTransportResult,
} from '@dock/shared/dist/group-document-transport.js';
import {
  DELIVERY_LIMITS,
  deliveryCommandSchema,
  type DeliveryResult,
} from '@dock/shared/dist/group-delivery.js';
import {
  MEMBERSHIP_LIMITS,
  membershipCapabilitySchema,
  membershipCommandSchema,
  type MembershipEnvelope,
  type MembershipResult,
} from '@dock/shared/dist/group-membership.js';
import { groupIdSchema } from '@dock/shared/dist/groups.js';
import {
  groupActionCommandSchema,
  type GroupActionResult,
} from '@dock/shared/dist/group-actions.js';
import {
  GROUP_PROMOTION_HOST_LIMITS,
  groupPromotionHostCommandSchema,
  type GroupPromotionHostResult,
} from '@dock/shared/dist/group-promotion-host.js';
import {
  creationGroupId,
  equalHash,
  localTestMode,
  setupHash,
  hostingEnvironment,
  hostingApprovalHash,
} from './crypto.js';
import { verifyWorkerBetaAdmission, betaGroupMatches } from './group-beta-admission.js';
import type { GroupBetaAdmissionPayload } from '@dock/shared/dist/group-beta-admission.js';
import { invitationPage } from './invite-page.js';
export { GroupMembership } from './membership.js';

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const status = {
  denied: 403,
  invalid: 400,
  conflict: 409,
  limit: 429,
  unavailable: 503,
  hosting_disabled: 503,
  stale: 409,
  creation_expired: 410,
} as const;
function reply(
  result:
    | MembershipResult
    | DeliveryResult
    | GroupActionResult
    | GroupPromotionHostResult
    | DocumentTransportResult,
): Response {
  return Response.json(result, { status: result.ok ? 200 : status[result.error], headers });
}
async function boundedBody(
  request: Request,
  limit: number = MEMBERSHIP_LIMITS.bodyBytes,
): Promise<unknown> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new Error('invalid');
  if (!request.body) throw new Error('invalid');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const abort = () => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(abort, DELIVERY_LIMITS.timeoutMs);
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (timedOut || request.signal.aborted) throw new Error('invalid');
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('invalid');
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Hosted configuration is inert until the owner has verified Free entitlement,
    // approved this exact HTTPS origin and supplied a separate protected capability.
    const local = localTestMode(env.HOSTING_MODE);
    if (!hostingEnvironment(env)) return reply({ ok: false, error: 'hosting_disabled' });
    // The public handoff is static: it never consumes capabilities or reaches a DO.
    // Its invitation stays in the browser fragment and is not part of this request.
    if (
      !local &&
      url.protocol === 'https:' &&
      url.origin === env.HOSTING_ORIGIN &&
      url.pathname === '/join' &&
      url.search === '' &&
      url.hash === '' &&
      (request.method === 'GET' || request.method === 'HEAD')
    )
      return invitationPage(request.method === 'HEAD');
    const betaAdmission = request.headers.get('X-Group-Admission');
    let beta: GroupBetaAdmissionPayload | undefined;
    if (local) {
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        request.headers.has('X-Hosting-Approval') ||
        betaAdmission !== null
      )
        return reply({ ok: false, error: 'hosting_disabled' });
    } else {
      if (betaAdmission !== null) {
        // Never fall through from invalid/mixed beta authority to the operator path.
        if (
          url.protocol !== 'https:' ||
          url.origin !== env.HOSTING_ORIGIN ||
          request.headers.has('X-Hosting-Approval') ||
          request.headers.has('Origin')
        )
          return reply({ ok: false, error: 'denied' });
        try {
          beta = (await verifyWorkerBetaAdmission(betaAdmission, env)).payload;
        } catch {
          return reply({ ok: false, error: 'denied' });
        }
      } else {
        const approval = membershipCapabilitySchema.safeParse(
          request.headers.get('X-Hosting-Approval'),
        );
        if (
          url.protocol !== 'https:' ||
          url.origin !== env.HOSTING_ORIGIN ||
          !approval.success ||
          !equalHash(await hostingApprovalHash(approval.data), env.HOSTING_APPROVAL_HASH)
        )
          return reply({ ok: false, error: 'hosting_disabled' });
      }
    }
    if (
      request.method !== 'POST' ||
      url.search !== '' ||
      url.hash !== '' ||
      request.headers.get('Content-Type') !== 'application/json'
    ) {
      return reply({ ok: false, error: 'invalid' });
    }
    const credential = membershipCapabilitySchema.safeParse(
      /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1],
    );
    if (!credential.success) return reply({ ok: false, error: 'denied' });
    const documentsRoute = /^\/v1\/groups\/([a-f0-9-]+)\/documents$/.exec(url.pathname);
    if (documentsRoute) {
      const id = groupIdSchema.safeParse(documentsRoute[1]);
      if (
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        request.headers.has('X-Group-Setup') ||
        request.headers.has('Origin')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const command = documentTransportCommandSchema.safeParse(
          await boundedBody(request, DOCUMENT_TRANSPORT_LIMITS.bodyBytes),
        );
        if (!command.success) return reply({ ok: false, error: 'invalid' });
        return reply(
          await env.GROUPS.getByName(id.data).documents({
            groupId: id.data,
            credential: credential.data,
            command: command.data,
          }),
        );
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
    const promotionRoute = /^\/v1\/groups\/([a-f0-9-]+)\/promotion$/.exec(url.pathname);
    if (promotionRoute) {
      const id = groupIdSchema.safeParse(promotionRoute[1]);
      if (
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        request.headers.has('X-Group-Setup') ||
        request.headers.has('Origin')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const command = groupPromotionHostCommandSchema.safeParse(
          await boundedBody(request, GROUP_PROMOTION_HOST_LIMITS.bodyBytes),
        );
        if (!command.success) return reply({ ok: false, error: 'invalid' });
        return reply(
          await env.GROUPS.getByName(id.data).promote({
            groupId: id.data,
            credential: credential.data,
            command: command.data,
          }),
        );
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
    const actionsRoute = /^\/v1\/groups\/([a-f0-9-]+)\/actions$/.exec(url.pathname);
    if (actionsRoute) {
      const id = groupIdSchema.safeParse(actionsRoute[1]);
      if (
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        request.headers.has('X-Group-Setup') ||
        request.headers.has('Origin')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const command = groupActionCommandSchema.safeParse(await boundedBody(request, 12_000));
        if (!command.success) return reply({ ok: false, error: 'invalid' });
        return reply(
          await env.GROUPS.getByName(id.data).actions({
            groupId: id.data,
            credential: credential.data,
            command: command.data,
          }),
        );
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
    const deliveryRoute = /^\/v1\/groups\/([a-f0-9-]+)\/delivery$/.exec(url.pathname);
    if (deliveryRoute) {
      const id = groupIdSchema.safeParse(deliveryRoute[1]);
      if (
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        request.headers.has('X-Group-Setup') ||
        request.headers.has('Origin')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const parsed = deliveryCommandSchema.safeParse(
          await boundedBody(request, DELIVERY_LIMITS.bodyBytes),
        );
        if (!parsed.success) return reply({ ok: false, error: 'invalid' });
        return reply(
          await env.GROUPS.getByName(id.data).deliver({
            groupId: id.data,
            credential: credential.data,
            command: parsed.data,
          }),
        );
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
    let command;
    try {
      command = membershipCommandSchema.safeParse(await boundedBody(request));
    } catch {
      return reply({ ok: false, error: 'invalid' });
    }
    if (!command.success) return reply({ ok: false, error: 'invalid' });
    let groupId;
    let setupCapability: string | undefined;
    if (url.pathname === '/v1/create' && command.data.kind === 'initialize') {
      const setup = membershipCapabilitySchema.safeParse(request.headers.get('X-Group-Setup'));
      if (!setup.success) return reply({ ok: false, error: 'denied' });
      const hashed = await setupHash(setup.data);
      groupId = groupIdSchema.parse(await creationGroupId(hashed, command.data.operationId));
      if (
        beta
          ? !equalHash(hashed, beta.createCapabilityHash) ||
            command.data.operationId !== beta.createOperationId ||
            groupId !== beta.groupId
          : !equalHash(hashed, env.GROUP_SETUP_HASH)
      )
        return reply({ ok: false, error: 'denied' });
      // No expiry/key-retirement precheck: the DO first recovers a committed exact receipt.
      setupCapability = setup.data;
    } else {
      const route = /^\/v1\/groups\/([a-f0-9-]+)$/.exec(url.pathname);
      const id = groupIdSchema.safeParse(route?.[1]);
      if (
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        command.data.kind === 'initialize' ||
        request.headers.has('X-Group-Setup')
      )
        return reply({ ok: false, error: 'denied' });
      groupId = id.data;
    }
    const envelope: MembershipEnvelope = {
      groupId,
      credential: credential.data,
      command: command.data,
      ...(setupCapability === undefined ? {} : { setupCapability }),
      ...(betaAdmission === null ? {} : { betaAdmission }),
    };
    try {
      return reply(await env.GROUPS.getByName(groupId).execute(envelope));
    } catch {
      return reply({ ok: false, error: 'unavailable' });
    }
  },
} satisfies ExportedHandler<Env>;
