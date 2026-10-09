import { GroupDocumentSharing } from './group-document-sharing.js';
import { join } from 'node:path';
import { GroupDocuments } from './group-documents.js';
import { nativeDocumentResultNames } from './group-documents-native-runtime.js';
import type { GroupDocumentsAuthority, GroupDocumentsNative } from './group-documents-native.js';
import type { GroupHost } from './group-host.js';
import type { GroupHostNativeRecord } from './group-host-native-journal.js';
import {
  privateGroupDirectory,
  privateGroupFile,
  protectGroupSidecars,
} from './group-host-storage.js';

const consumers = new WeakMap<GroupHost, GroupFeatureDocuments>();
export const groupFeatureDocuments = (host: GroupHost) => consumers.get(host);
/** Only exact normal result projections offer native-captured files. Browser
 * identifiers never look up arbitrary paths or unprojected native results. */
export class GroupFeatureDocuments {
  readonly documents: GroupDocuments;
  readonly sharing: GroupDocumentSharing;
  constructor(
    readonly host: GroupHost,
    private readonly native: {
      documents(authority: GroupDocumentsAuthority): GroupDocumentsNative;
      documentAvailable?(resultId: string): boolean;
      documentCaptureState?(
        resultId: string,
        record: GroupHostNativeRecord,
      ): 'pending' | 'unavailable' | undefined;
    },
  ) {
    const authority = {
      resolve: (handle: string) => host.authenticatedContext({ handle }),
      revalidateOwner: async (context: import('@dock/shared').GroupContext) => {
        const owner = await host.authenticatedOwnerContext(context);
        await owner.revalidate();
      },
    };
    const path = join(host.directory, 'documents.sqlite');
    privateGroupFile(path);
    const directory = privateGroupDirectory(join(host.directory, 'document-files'));
    this.documents = new GroupDocuments(path, directory, authority, native.documents(authority));
    protectGroupSidecars(path);
    this.sharing = new GroupDocumentSharing(host, this.documents);
    consumers.set(host, this);
  }
  receipt(record: GroupHostNativeRecord) {
    if (!record.result) return {};
    try {
      const documentCaptureState = this.native.documentCaptureState?.(record.ids.resultId, record);
      return {
        ...(documentCaptureState ? { documentCaptureState } : {}),
        documentAvailable:
          this.native.documentAvailable?.(record.ids.resultId) ??
          nativeDocumentResultNames(record.result.text).length > 0,
      };
    } catch {
      return {};
    }
  }
  async offer(handle: string, key: string) {
    const record = this.host.nativeJournal.get(handle, key);
    if (!record?.result || record.receipt.state !== 'completed')
      throw new Error('Select a completed report from this exact conversation.');
    return this.documents.offer(handle, record.ids.resultId);
  }
  async close() {
    await this.sharing.close();
    await this.documents.close();
    consumers.delete(this.host);
  }
}
