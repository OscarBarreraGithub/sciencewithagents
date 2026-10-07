import {
  groupBetaKeysSchema,
  verifyGroupBetaAdmission,
  type GroupBetaAdmissionPayload,
} from '@dock/shared/dist/group-beta-admission.js';

/** Public deployment identity only; no issuer private key is deployed. */
export async function verifyWorkerBetaAdmission(admission: string, env: Env) {
  const keys = groupBetaKeysSchema.parse(JSON.parse(env.GROUP_BETA_KEYS));
  const payload = await verifyGroupBetaAdmission(admission, {
    version: 1,
    serviceId: env.GROUP_BETA_SERVICE_ID,
    endpointId: env.GROUP_BETA_SERVICE_ID,
    origin: env.HOSTING_ORIGIN,
    keys,
  });
  return { payload, state: keys.find((key) => key.kid === payload.kid)!.state };
}
export function betaGroupMatches(payload: GroupBetaAdmissionPayload | undefined, groupId: string) {
  return payload === undefined || payload.groupId === groupId;
}
