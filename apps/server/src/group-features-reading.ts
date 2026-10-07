import { join } from 'node:path';
import type { GroupContext } from '@dock/shared';
import type { ClaudeHostTool } from './claude-session.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GroupCatchupStore } from './group-catchup.js';
import { GroupEvidenceIndex, type GroupEvidenceSourcePort } from './group-evidence.js';
import { registerGroupCatchupRoutes } from './group-catchup-routes.js';
import type { GroupHost } from './group-host.js';
import { privateGroupFile, protectGroupSidecars } from './group-host-storage.js';
import { registerGroupNativeCapabilities } from './group-native-connector.js';
import { registerGroupHostEvidence } from './group-host-native-tools.js';
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

/** Both authenticated HTTP entries lease the same host-owned reading stores. */
export function registerGroupFeatureReading(
  app: FastifyInstance,
  host: GroupHost,
  authenticated: (request: FastifyRequest) => boolean,
) {
  const reading = readers.get(host) ?? new GroupFeatureReading(host);
  reading.register(app, authenticated);
}

/** Normal host lifecycle owns the finite private reading stores. Their pages
 * come from authenticated hosted remote positions, never Store/SSE history. */
export class GroupFeatureReading {
  readonly catchup: GroupCatchupStore;
  readonly evidence: GroupEvidenceIndex;
  private registrations = 0;
  private closed = false;
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
    if (this.closed || (readers.has(this.host) && readers.get(this.host) !== this))
      throw new Error('Group reading lifecycle already registered or closed.');
    try {
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
      app.addHook('onClose', async () => {
        if (--this.registrations === 0) this.close();
      });
      this.registrations++;
      readers.set(this.host, this);
    } catch (error) {
      if (this.registrations === 0) this.close();
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (readers.get(this.host) === this) readers.delete(this.host);
    this.evidence.close();
    this.catchup.close();
  }
}
export function registerGroupReadingCapabilities(runtime: Runtime, host: GroupHost) {
  const tools = (context: GroupContext): ClaudeHostTool[] =>
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
      : [];
  registerGroupNativeCapabilities(runtime, 'private-history', tools);
  registerGroupHostEvidence(runtime, tools);
}
