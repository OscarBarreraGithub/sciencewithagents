import { GroupHost } from './group-host.js';
import {
  createGroupHostNativeConnector,
  type GroupHostNativeRuntime,
} from './group-native-host-runtime.js';
import type { Runtime } from './runtime.js';
import { attachGroupHostLocalFeatures } from './group-host-local-features.js';

/** Default v1: explicit owner work, normal native Mac runtime and separate histories. */
export function createLocalProductionGroupHost(dataDir: string, runtime: Runtime) {
  let native: GroupHostNativeRuntime;
  let features: { close(): Promise<void> } | undefined;
  const host = new GroupHost(dataDir, {
    nativeFactory: (ports) => {
      native = createGroupHostNativeConnector(runtime, ports);
      const close = native.close!;
      native.close = async () => {
        await features?.close();
        await close();
      };
      return native;
    },
  });
  native!.revalidate(async (context) => {
    const scope = await host.nativeFeatureContext(context);
    await scope.revalidate();
  });
  native!.backgroundVisible((enrollment) => host.localVisible(enrollment));
  native!.evidence(async (context) => {
    const scope = await host.nativeFeatureContext(context);
    let shared = await scope.readShared({ visibility: 'shared', after: 0, limit: 8, cursor: null });
    if (shared.watermark > 8)
      shared = await scope.readShared({
        visibility: 'shared',
        after: Math.max(0, shared.watermark - 8),
        limit: 8,
        cursor: null,
      });
    // Private local human messages are selected by this exact authenticated slot.
    // No personal Store history, browser draft, or other member's aside is read.
    const own =
      context.visibility === 'private'
        ? host.db
            .prepare('SELECT input FROM gh_sends WHERE handle=? ORDER BY rowid DESC LIMIT 8')
            .all(scope.handle)
            .reverse()
            .map((row) => ({ text: JSON.parse(String(row.input)).text }))
        : [];
    await scope.revalidate();
    return JSON.stringify({
      sharedWatermark: shared.watermark,
      sharedCoverage:
        'Latest eight shared headers; use dock_group_evidence_query for original typed evidence and incremental offline changes. Missing facts and index gaps remain unknown.',
      shared: shared.entries.map((e) => ({
        eventId: e.eventId,
        memberId: e.scope.memberId,
        sequence: e.sequence,
        category: e.category,
        causalRefs: e.scope.causalRefs,
        text: e.condensedText.slice(0, 3000),
      })),
      ownPrivate: own,
    });
  });
  features = attachGroupHostLocalFeatures(runtime, host, native!);
  return host;
}
