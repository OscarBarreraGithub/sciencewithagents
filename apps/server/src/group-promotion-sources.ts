import type { GroupPromotionSource } from '@dock/shared/dist/group-promotion.js';
import { GroupPromotionController, type GroupPromotionOutcome } from './group-promotion.js';

/** Saved receipt readers owned by normal/native/actions/Git/QUARK/job producers.
 * Every read revalidates authenticated enrollment and the exact immutable shared
 * source/version. Private or metadata-only headers may be returned without content.
 * There is deliberately no global history/SSE/event-bus reader here. */
export interface GroupPromotionSourceReaders {
  humanSend(receiptId: string): Promise<unknown>;
  nativeResult(receiptId: string): Promise<unknown>;
  managerAction(receiptId: string): Promise<unknown>;
  workerResult(receiptId: string): Promise<unknown>;
  quarkTransition(receiptId: string): Promise<unknown>;
  fileChange(receiptId: string): Promise<unknown>;
  jobTransition(receiptId: string): Promise<unknown>;
}
/** Concrete producer hooks, not a plugin catalog or browser launch API.
 * The caller passes a durable producer receipt ID, never raw text/scope/paths. */
export class GroupPromotionSourceHandlers {
  constructor(
    private readonly controller: GroupPromotionController,
    private readonly readers: GroupPromotionSourceReaders,
  ) {}
  private promote(
    reader: (id: string) => Promise<unknown>,
    id: string,
    kind: GroupPromotionSource['kind'],
  ): Promise<GroupPromotionOutcome> {
    if (!id || id.length > 256) throw new Error('Invalid source receipt identifier');
    return this.controller.promote(async () => {
      const source = await reader(id);
      if (
        source &&
        typeof source === 'object' &&
        (source as Partial<GroupPromotionSource>).kind !== kind
      )
        throw new Error('Producer receipt kind mismatch');
      return source;
    });
  }
  humanSend(id: string) {
    return this.promote(this.readers.humanSend.bind(this.readers), id, 'human');
  }
  nativeResult(id: string) {
    return this.promote(this.readers.nativeResult.bind(this.readers), id, 'native');
  }
  managerAction(id: string) {
    return this.promote(this.readers.managerAction.bind(this.readers), id, 'manager');
  }
  workerResult(id: string) {
    return this.promote(this.readers.workerResult.bind(this.readers), id, 'worker');
  }
  quarkTransition(id: string) {
    return this.promote(this.readers.quarkTransition.bind(this.readers), id, 'quark');
  }
  fileChange(id: string) {
    return this.promote(this.readers.fileChange.bind(this.readers), id, 'file');
  }
  jobTransition(id: string) {
    return this.promote(this.readers.jobTransition.bind(this.readers), id, 'job');
  }
}
