import { AppSourceUpdates } from './app-source-updates.js';
import { repoRoot } from './paths.js';
import { GroupsFiles } from './groups-files.js';
import { claudeModelCatalog } from './claude-model-catalog.js';
import { join } from 'node:path';
import { Store, Conflict } from './store.js';
import { GroupHost } from './group-host.js';
import { unavailableGroupNative } from './group-host-native.js';
import { GroupHostNativeDocuments } from './group-documents-host-native.js';
import { GroupFeatureDocuments } from './group-feature-documents.js';
import { ModelPolicy } from './model-policy.js';
import { inspectClaudeRuntime } from './claude-session.js';
import {
  GroupsConversationWorker,
  groupsConversationWorker,
  claudeGroupsSummary,
  type GroupsSummary,
} from './groups-conversation-worker.js';
import { WorkspaceState } from './workspace-state.js';

/** No Runtime, queue restoration, provider discovery or managed background services. */
export async function createGroupsServices(
  root: string,
  options: {
    inspectSource?: () => Promise<import('./app-source-check.js').Inspection>;
    http?: typeof fetch;
    summarize?: GroupsSummary;
    filesFixture?: ConstructorParameters<typeof GroupsFiles>[3];
  } = {},
) {
  const store = new Store(join(root, 'dock.sqlite'));
  let host: GroupHost | undefined;
  let reports: GroupHostNativeDocuments | undefined;
  let documents: GroupFeatureDocuments | undefined;
  let policy: ModelPolicy | undefined;
  let files: GroupsFiles | undefined;
  let appUpdates: AppSourceUpdates | undefined;
  try {
    host = new GroupHost(root, {
      http: options.http,
      native: {
        ...unavailableGroupNative,
        availability: () => ({
          available: false,
          productionReady: false,
          authState: 'unavailable',
          message:
            'Use your existing Claude Code conversation through the optional Groups plugin. Human chat and reading need no agent.',
        }),
      },
    });
    files = new GroupsFiles(host, store, root, options.filesFixture);
    reports = new GroupHostNativeDocuments(host);
    documents = new GroupFeatureDocuments(host, reports);
    const summarize: GroupsSummary =
      options.summarize ??
      (async (text, signal) => {
        const binary = process.env.DOCK_CLAUDE_BIN ?? 'claude';
        policy ??= new ModelPolicy(
          store,
          async (provider) => {
            if (provider !== 'claude')
              throw new Conflict('Groups summaries use your selected Claude integration.');
            return claudeModelCatalog((await inspectClaudeRuntime(binary, root)).models);
          },
          Date.now,
          { initializeDefaults: false },
        );
        return claudeGroupsSummary(policy, binary, root)(text, signal);
      });
    const sharing = groupsConversationWorker(
      host,
      () => new GroupsConversationWorker(host!, root, summarize),
    )!;
    appUpdates = new AppSourceUpdates(store, 'groups-only', repoRoot, options.inspectSource);
    const hostId = new WorkspaceState(store).hostId;
    let closing: Promise<void> | undefined;
    return {
      root,
      store,
      host,
      sharing,
      hostId,
      files,
      appUpdates,
      start: () => {
        appUpdates!.start();
        sharing.start();
        files!.start();
      },
      close: () => (closing ??= closeAll()),
    };
  } catch (error) {
    await closeAll().catch(() => {});
    throw error;
  }
  async function closeAll() {
    const errors: unknown[] = [];
    const close = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await close(() => appUpdates?.close());
    await close(() => host && groupsConversationWorker(host)?.close());
    await close(() => files?.close());
    // Report readers can still use the host DB while their active locks drain.
    await close(() => documents?.close());
    await close(() => reports?.close());
    await close(() => host?.close());
    await close(() => policy?.close());
    await close(() => store.close());
    if (errors.length) throw new AggregateError(errors, 'Groups could not close every service.');
  }
}
export type GroupsServices = Awaited<ReturnType<typeof createGroupsServices>>;
