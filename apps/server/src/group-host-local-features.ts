import type { Runtime } from './runtime.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRuntime } from './group-native-host-runtime.js';
import { registerGroupReadingCapabilities } from './group-features-reading.js';
import { createGroupLocalSynthesis } from './group-local-synthesis.js';

/** Host mode reuses the ordinary native tools and its scoped private reader.
 * Container-specific Git, document export and coordination adapters stay optional. */
export function attachGroupHostLocalFeatures(
  runtime: Runtime,
  host: GroupHost,
  connector: GroupHostNativeRuntime,
): { close(): Promise<void> } {
  registerGroupReadingCapabilities(runtime, host);
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
  return { close: () => synthesis.close() };
}
