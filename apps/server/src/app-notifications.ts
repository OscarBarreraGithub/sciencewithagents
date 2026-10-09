/**
 * App-generated handoffs that still reach a manager as provider user-role input.
 * Origin comes only from the retained run key the app wrote, never from message wording.
 */
export const reconcileRunKey = (taskId: string) => `reconcile:${taskId}`;
export const appNotificationTitle = 'App notification';
// Entries saved before the app recorded this origin keep their text; only the label changes.
export const earlierAppNotificationTitle = 'App notification · not written by you';

/**
 * SQL (aliases e = entries, r = joined run): the input entry of a reconciliation run that was
 * saved as owner input before the app recorded its origin. Owner keys are UUIDs, so only the
 * app can create this namespaced key.
 */
export const earlierAppNotificationSql = `(e.id=r.id AND json_extract(e.body,'$.kind')='user'
  AND json_extract(r.body,'$.kind')='user' AND json_extract(r.body,'$.sourceId') IS NULL
  AND substr(r.key,1,10)='reconcile:')`;
