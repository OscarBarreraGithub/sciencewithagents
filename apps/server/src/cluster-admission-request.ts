import { createHash } from 'node:crypto';
import { remoteAdmissionCandidateSchema, type RemoteAdmissionCandidate } from '@dock/shared';
export function remoteRequestHash(candidate: RemoteAdmissionCandidate) {
  return createHash('sha256')
    .update(JSON.stringify(remoteAdmissionCandidateSchema.parse(candidate)))
    .digest('hex');
}
