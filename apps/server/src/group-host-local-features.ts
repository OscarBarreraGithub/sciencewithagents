import type { Runtime } from './runtime.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import { registerGroupReadingCapabilities } from './group-features-reading.js';
import { createGroupLocalSynthesis } from './group-local-synthesis.js';
import { GroupHostNativeGit } from './group-host-native-git.js';
import { GroupMemberFeed } from './group-member-feed.js';

/** Host mode reuses the ordinary native tools and its scoped private reader.
 * Container-specific Git, document export and coordination adapters stay optional. */
export function attachGroupHostLocalFeatures(
  runtime: Runtime,
  host: GroupHost,
  connector: GroupHostNativeRuntime,
): { close(): Promise<void> } {
  registerGroupReadingCapabilities(runtime, host);
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
    source: (input) => host.memberFeedSource(input),
    publish: (input, decision, operationId) => host.publishMemberFeed(input, decision, operationId),
  });
  const retain = (input: Parameters<GroupMemberFeed['retain']>[0]) => memberFeed.retain(input);
  host.memberFeedOriginal = retain;
  memberFeed.start();
  return {
    close: async () => {
      if (host.memberFeedOriginal === retain) host.memberFeedOriginal = undefined;
      await memberFeed.close();
      await git.close();
      await synthesis.close();
    },
  };
}
