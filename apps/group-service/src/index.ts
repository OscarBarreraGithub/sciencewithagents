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
import { groupExportRequestSchema } from '@dock/shared/dist/group-hosted-export.js';
import {
  groupActionCommandSchema,
  groupActionRetainedReceiptSchema,
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
import { groupPhonePage } from './group-phone-page.js';
import { phoneProof, phoneProofMatches } from './group-phone-routing.js';
import {
  groupPhoneCommandSchema,
  groupPhoneManageCommandSchema,
  type GroupPhoneResult,
} from '@dock/shared/dist/group-phone.js';
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
    | GroupPhoneResult
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
    const phoneOrigin = local
      ? url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      : url.protocol === 'https:' && url.origin === env.HOSTING_ORIGIN;
    if (
      phoneOrigin &&
      /^\/groups\/[a-f0-9-]+$/.test(url.pathname) &&
      groupIdSchema.safeParse(url.pathname.split('/')[2]).success &&
      !url.search &&
      !url.hash &&
      (request.method === 'GET' || request.method === 'HEAD')
    )
      return groupPhonePage(request.method === 'HEAD');
    const phoneRoute = /^\/v1\/phone\/([a-f0-9-]+)$/.exec(url.pathname);
    if (phoneRoute) {
      const id = groupIdSchema.safeParse(phoneRoute[1]);
      if (
        !phoneOrigin ||
        !id.success ||
        request.method !== 'POST' ||
        url.search ||
        url.hash ||
        request.headers.get('Origin') !== url.origin ||
        request.headers.get('Content-Type') !== 'application/json' ||
        request.headers.has('Authorization') ||
        request.headers.has('X-Hosting-Approval') ||
        request.headers.has('X-Group-Admission') ||
        request.headers.has('X-Group-Setup')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const command = groupPhoneCommandSchema.safeParse(await boundedBody(request, 65536));
        if (!command.success) return reply({ ok: false, error: 'invalid' });
        let credential: string | undefined;
        const cookieName = `${local ? 'swa_test_group_' : '__Host-swa_group_'}${id.data}`;
        if (command.data.kind === 'claim') {
          if (
            command.data.expiresAt <= Date.now() ||
            command.data.expiresAt > Date.now() + 600000 ||
            !(await phoneProofMatches(
              env,
              [
                'pair',
                id.data,
                command.data.pairId,
                command.data.pairSecret,
                command.data.expiresAt,
              ],
              command.data.pairProof,
            ))
          )
            return reply({ ok: false, error: 'denied' });
        } else {
          const cookies = (request.headers.get('Cookie') ?? '')
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.startsWith(cookieName + '='));
          const value =
            cookies.length === 1
              ? /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(cookies[0]!.slice(cookieName.length + 1))
              : null;
          if (!value || !(await phoneProofMatches(env, ['device', id.data, value[1]!], value[2]!)))
            return reply({ ok: false, error: 'denied' });
          credential = value[1]!;
        }
        const result = await env.GROUPS.getByName(id.data).phone({
          groupId: id.data,
          command: command.data,
          ...(credential ? { credential } : {}),
        });
        const response = reply(result);
        if (result.ok && command.data.kind === 'claim') {
          const proof = await phoneProof(env, ['device', id.data, command.data.deviceCredential]);
          response.headers.set(
            'Set-Cookie',
            `${cookieName}=${command.data.deviceCredential}.${proof}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${local ? '' : '; Secure'}`,
          );
        }
        return response;
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
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
    const credential = membershipCapabilitySchema.safeParse(
      /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1],
    );
    const updatesRoute = /^\/v1\/groups\/([a-f0-9-]+)\/updates$/.exec(url.pathname);
    if (updatesRoute) {
      const id = groupIdSchema.safeParse(updatesRoute[1]);
      if (
        !credential.success ||
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        request.method !== 'GET' ||
        url.search !== '' ||
        url.hash !== '' ||
        request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
        request.headers.has('Origin') ||
        request.headers.has('X-Group-Setup')
      )
        return reply({ ok: false, error: 'denied' });
      return env.GROUPS.getByName(id.data).fetch(request);
    }
    if (
      request.method !== 'POST' ||
      url.search !== '' ||
      url.hash !== '' ||
      request.headers.get('Content-Type') !== 'application/json'
    )
      return reply({ ok: false, error: 'invalid' });
    if (!credential.success) return reply({ ok: false, error: 'denied' });
    const phonesRoute = /^\/v1\/groups\/([a-f0-9-]+)\/phones$/.exec(url.pathname);
    if (phonesRoute) {
      const id = groupIdSchema.safeParse(phonesRoute[1]);
      if (
        !id.success ||
        !betaGroupMatches(beta, id.data) ||
        request.headers.has('Origin') ||
        request.headers.has('X-Group-Setup')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const command = groupPhoneManageCommandSchema.safeParse(await boundedBody(request, 8192));
        if (!command.success) return reply({ ok: false, error: 'invalid' });
        const result = await env.GROUPS.getByName(id.data).phoneManage({
          groupId: id.data,
          credential: credential.data,
          command: command.data,
        });
        if (result.ok && command.data.kind === 'pair')
          return reply({
            ok: true,
            value: {
              pairId: command.data.operationId,
              expiresAt: command.data.expiresAt,
              pairProof: await phoneProof(env, [
                'pair',
                id.data,
                command.data.operationId,
                command.data.pairSecret,
                command.data.expiresAt,
              ]),
            },
          });
        return reply(result);
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
    const exportRoute = /^\/v1\/groups\/([a-f0-9-]+)\/export$/.exec(url.pathname);
    if (exportRoute) {
      const id = groupIdSchema.safeParse(exportRoute[1]),
        setup = membershipCapabilitySchema.safeParse(request.headers.get('X-Group-Setup'));
      if (
        !id.success ||
        !setup.success ||
        !betaGroupMatches(beta, id.data) ||
        request.headers.has('Origin')
      )
        return reply({ ok: false, error: 'denied' });
      try {
        const parsed = groupExportRequestSchema.safeParse(await boundedBody(request, 2048));
        if (!parsed.success) return reply({ ok: false, error: 'invalid' });
        return Response.json(
          await env.GROUPS.getByName(id.data).exportHosted({
            groupId: id.data,
            credential: credential.data,
            setupCapability: setup.data,
            ...(betaAdmission === null ? {} : { betaAdmission }),
            request: parsed.data,
          }),
          { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } },
        );
      } catch {
        return reply({ ok: false, error: 'unavailable' });
      }
    }
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
    const actionsRoute = /^\/v1\/groups\/([a-f0-9-]+)\/actions(?:\/(confirm|reconcile))?$/.exec(
      url.pathname,
    );
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
        if (actionsRoute[2] === 'reconcile') {
          const receipt = groupActionRetainedReceiptSchema.safeParse(
            await boundedBody(request, 12000),
          );
          if (!receipt.success) return reply({ ok: false, error: 'invalid' });
          return reply(
            await env.GROUPS.getByName(id.data).actionsReconcile({
              groupId: id.data,
              credential: credential.data,
              receipt: receipt.data,
            }),
          );
        }
        const command = groupActionCommandSchema.safeParse(await boundedBody(request, 12_000));
        if (!command.success) return reply({ ok: false, error: 'invalid' });
        if (actionsRoute[2] === 'confirm' && command.data.kind !== 'confirm')
          return reply({ ok: false, error: 'invalid' });
        return reply(
          await env.GROUPS.getByName(id.data)[
            actionsRoute[2] === 'confirm' ? 'actionsConfirm' : 'actions'
          ]({
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
