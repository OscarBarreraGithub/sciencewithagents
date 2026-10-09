import type { Runtime } from './runtime.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import { registerGroupReadingCapabilities } from './group-features-reading.js';
import { createGroupLocalSynthesis } from './group-local-synthesis.js';
import { GroupHostNativeGit } from './group-host-native-git.js';
import { GroupFeatureDocuments } from './group-feature-documents.js';
import { GroupHostNativeDocuments } from './group-documents-host-native.js';
import { GroupFeatureCoordination } from './group-feature-coordination.js';
import { registerGroupHostCoordination } from './group-host-coordination-tools.js';
import { GroupMemberFeed } from './group-member-feed.js';
import { GroupHostNativeActivity, registerGroupHostActivity } from './group-native-activity.js';

/** Host mode reuses the ordinary native tools and its scoped private reader.
 * Immutable report copies reuse scoped grants/Reading/sharing without a host compiler. */
export function attachGroupHostLocalFeatures(
  runtime: Runtime,
  host: GroupHost,
  connector: GroupHostNativeRuntime,
): { close(): Promise<void> } {
  registerGroupReadingCapabilities(runtime, host);
  const reports = new GroupHostNativeDocuments(host);
  const documents = new GroupFeatureDocuments(host, reports);
  connector.completed((completion) => reports.captureCompleted(completion));
  const coordination = connector.coordination
    ? new GroupFeatureCoordination(runtime, host, connector.coordination)
    : undefined;
  const unregisterCoordination = coordination
    ? registerGroupHostCoordination(runtime, coordination.tools)
    : undefined;
  coordination?.start();
  const git = new GroupHostNativeGit(host, runtime, connector);
  connector.beforeTurn?.((context, requestId) => git.beforeWork(context, requestId));
  git.start();
  const synthesis = createGroupLocalSynthesis({
    directory: host.directory,
    runtime,
    events: host.events,
    resolveLocalContext: (context, enrollment) =>
      connector.resolveLocalContext(context, enrollment),
    registerHelper: (agentId, context, enrollment, runId, requestId) =>
      connector.registerHelper(agentId, context, enrollment, runId, requestId),
    authorize: (request, signal) => host.promotion.authorizeNative(request, signal),
  });
  host.promotion.start(synthesis);
  const memberFeed = new GroupMemberFeed(runtime, host.directory, connector, {
    allowed: (enrollment) => host.localVisible(enrollment),
    source: (input) => host.memberFeedSource(input),
    publish: (input, decision, operationId) => host.publishMemberFeed(input, decision, operationId),
  });
  const retain = (input: Parameters<GroupMemberFeed['retain']>[0]) => memberFeed.retain(input);
  host.memberFeedOriginal = retain;
  memberFeed.start();
  const activity = new GroupHostNativeActivity(runtime.store, host);
  const unregisterActivity = registerGroupHostActivity(host, activity);
  activity.start();
  return {
    close: async () => {
      if (host.memberFeedOriginal === retain) host.memberFeedOriginal = undefined;
      unregisterCoordination?.();
      unregisterActivity();
      await activity.close();
      await coordination?.close();
      await memberFeed.close();
      await documents.close();
      await reports.close();
      await git.close();
      await synthesis.close();
    },
  };
}
