import {
  groupWorkspaceInputSchema,
  groupWorkspaceViewSchema,
} from '@dock/shared/dist/group-workspace.js';
import { api, apiScope, ApiError } from '../api';
/** Keep the exact bind operation through a lost ACK, independently of the current route. */
export async function bindCreatedGroup(
  key: string,
  handle: string,
  selectionKey?: string,
  scope = apiScope(),
  current: () => boolean = () => true,
) {
  const guard = () => {
    if (apiScope() !== scope || !current())
      throw new Error(
        'The computer or setup view changed. Return to the original computer and retry the saved request.',
      );
  };
  guard();
  if (!selectionKey) return;
  const storage = `swa:groups:${scope}:create-bind:${key}`;
  const saved = sessionStorage.getItem(storage);
  let operation;
  if (saved) {
    operation = groupWorkspaceInputSchema.parse(JSON.parse(saved));
    if (
      operation.action !== 'select' ||
      operation.handle !== handle ||
      operation.selectionKey !== selectionKey
    )
      throw new Error(
        'The saved creation folder belongs to a different group. Keep it for recovery.',
      );
  } else {
    const workspace = groupWorkspaceViewSchema.parse(
      await api('/groups/workspace', { action: 'status', handle }),
    );
    guard();
    if (workspace.selectionKey === selectionKey && workspace.available) return;
    if (workspace.revision !== 0)
      return 'This group already has another folder. Review it in Manage → Work folder; the creation folder was not applied.';
    operation = {
      action: 'select' as const,
      key: crypto.randomUUID(),
      handle,
      selectionKey,
      revision: workspace.revision,
    };
    sessionStorage.setItem(storage, JSON.stringify(operation));
  }
  guard();
  let bound;
  try {
    bound = groupWorkspaceViewSchema.parse(await api('/groups/workspace', operation));
  } catch (reason) {
    guard();
    if (reason instanceof ApiError && reason.code === 'GROUP_FOLDER_BINDING_REFUSED')
      return reason.message;
    throw reason;
  }
  guard();
  if (bound.selectionKey === selectionKey && !bound.available)
    return 'The saved folder is unavailable. Group creation completed; repair its folder in Manage → Work folder.';
  if (bound.selectionKey !== selectionKey || !bound.available)
    throw new Error('The saved folder could not be verified. Retry this same creation request.');
  sessionStorage.removeItem(storage);
}
