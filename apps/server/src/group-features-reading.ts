import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GroupCatchupStore } from './group-catchup.js';
import { GroupEvidenceIndex, type GroupEvidenceSourcePort } from './group-evidence.js';
import { registerGroupCatchupRoutes } from './group-catchup-routes.js';
import type { GroupHost } from './group-host.js';
import { privateGroupFile, protectGroupSidecars } from './group-host-storage.js';
import { registerGroupNativeCapabilities } from './group-native-connector.js';
import {
  createGroupPrivateEvidenceQuery,
  GROUP_PRIVATE_EVIDENCE_TOOL,
} from './group-evidence-private.js';
import type { Runtime } from './runtime.js';
import { GroupCatchupError } from './group-catchup-context.js';
import { groupFeatureEvidence } from './group-feature-evidence.js';

const readers = new WeakMap<GroupHost, GroupFeatureReading>();
export function groupFeatureReading(host: GroupHost) {
  const reading = readers.get(host);
  if (!reading) throw new Error('Authenticated group reading is unavailable.');
  return reading;
}

/** Normal host lifecycle owns the finite private reading stores. Their pages
 * come from authenticated hosted remote positions, never Store/SSE history. */
export class GroupFeatureReading {
  readonly catchup: GroupCatchupStore;
  readonly evidence: GroupEvidenceIndex;
  constructor(
    readonly host: GroupHost,
    source?: GroupEvidenceSourcePort,
  ) {
    const catchupPath = join(host.directory, 'catchup.sqlite');
    const evidencePath = join(host.directory, 'evidence.sqlite');
    privateGroupFile(catchupPath);
    privateGroupFile(evidencePath);
    this.catchup = new GroupCatchupStore(catchupPath);
    try {
      this.evidence = new GroupEvidenceIndex(evidencePath, source ?? groupFeatureEvidence(host));
    } catch (error) {
      this.catchup.close();
      throw error;
    }
    protectGroupSidecars(catchupPath);
    protectGroupSidecars(evidencePath);
  }
  register(app: FastifyInstance, authenticated: (request: FastifyRequest) => boolean) {
    if (readers.has(this.host)) throw new Error('Group reading lifecycle already registered.');
    readers.set(this.host, this);
    registerGroupCatchupRoutes(app, {
      authenticated,
      resolve: async (handle) => {
        const reader = await this.host.authenticatedContext({ handle });
        if (reader.context.visibility !== 'private')
          throw new GroupCatchupError('private_required', 'Open catch-up in your private aside.');
        return reader;
      },
      catchup: this.catchup,
      evidence: this.evidence,
    });
  }
  close() {
    readers.delete(this.host);
    this.evidence.close();
    this.catchup.close();
  }
}
export function registerGroupReadingCapabilities(runtime: Runtime, host: GroupHost) {
  registerGroupNativeCapabilities(runtime, 'private-history', (context) =>
    context.visibility === 'private'
      ? [
          {
            ...GROUP_PRIVATE_EVIDENCE_TOOL,
            invoke: async (raw) => {
              const reading = readers.get(host);
              if (!reading) throw new Error('Authenticated group reading is unavailable.');
              const query = createGroupPrivateEvidenceQuery({
                resolve: () => host.nativeFeatureContext(context),
                evidence: reading.evidence,
                catchup: reading.catchup,
              });
              return { content: [{ type: 'text', text: JSON.stringify(await query(raw)) }] };
            },
          },
        ]
      : [],
  );
}
