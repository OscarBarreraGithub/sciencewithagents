import { GroupFeatureGit } from './group-feature-git.js';
import { GroupFeatureDocuments } from './group-feature-documents.js';
import { groupHostNativeStatusSchema } from '@dock/shared/dist/group-host.js';
import { GroupFeatureCoordination } from './group-feature-coordination.js';
import { GroupHost } from './group-host.js';
import { createGroupNativeConnector } from './group-native-connector.js';
import type { Runtime } from './runtime.js';
import { registerGroupReadingCapabilities } from './group-features-reading.js';
import { loadGroupNativeOwnerConfig } from './group-native-owner-config.js';
import { GroupNativeOwner } from './group-native-owner.js';
import type { OwnerTerminals } from './owner-terminal.js';
import type { GroupNativeOwnerConfig } from './group-native-owner-config.js';

/** Production entry only: host-owned storage/events and the ordinary supervised runtime. */
export function createProductionGroupHost(
  dataDir: string,
  runtime: Runtime,
  ownerTerminals?: OwnerTerminals,
) {
  let config: GroupNativeOwnerConfig | null = null;
  let invalidConfig = false;
  try {
    config = loadGroupNativeOwnerConfig(dataDir, runtime);
  } catch {
    invalidConfig = true;
  }
  let git: GroupFeatureGit | undefined;
  let documents: GroupFeatureDocuments | undefined;
  let coordination: GroupFeatureCoordination | undefined;
  let nativeConnector: ReturnType<typeof createGroupNativeConnector>;
  const host = new GroupHost(dataDir, {
    nativeFactory: (host) => {
      const connector = createGroupNativeConnector(runtime, host);

      const availability = async () =>
        groupHostNativeStatusSchema.parse(
          invalidConfig
            ? {
                available: false,
                productionReady: false,
                authState: 'unavailable',
                message:
                  'Private native route configuration is invalid. Ask the setup agent to repair it; human Groups messages remain available.',
              }
            : await connector.availability(),
        );
      const owner = new GroupNativeOwner(
        host.directory,
        { ...connector, availability },
        config,
        ownerTerminals
          ? (key, invocation) => ownerTerminals.openNativeLogin(key, invocation).id
          : undefined,
      );
      const exposed = {
        ...connector,
        owner,
        close: async () => {
          await git?.close();
          await coordination?.close();
          await documents?.close();
          await connector.close();
          await owner.close();
        },
        availability,
      };
      nativeConnector = exposed;
      return exposed;
    },
  });
  git = new GroupFeatureGit(host, nativeConnector!);
  git.start();
  nativeConnector!.beforeTurn((context, requestId) => git!.beforeWork(context, requestId));
  documents = new GroupFeatureDocuments(host, nativeConnector!);
  coordination = new GroupFeatureCoordination(runtime, host, nativeConnector!.coordination!);
  coordination.start();
  registerGroupReadingCapabilities(runtime, host);
  host.promotion.start(
    nativeConnector!.promotionSynthesis((request, signal) =>
      host.promotion.authorizeNative(request, signal),
    ),
  );
  return host;
}
