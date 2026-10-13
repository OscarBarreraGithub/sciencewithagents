import { z } from 'zod';
import {
  groupHostApprovalSchema,
  groupHostCreateSchema,
  groupHostJoinSchema,
  groupHostLocalModeSchema,
  groupHostLocalVisibilitySchema,
  groupHostSelectSchema,
  groupHostSendSchema,
} from './group-host.js';
import { groupFeedQuerySchema, groupEventIdSchema } from './groups.js';
import { groupExternalFileProposeSchema } from './group-external-files.js';
import {
  groupConversationSelectionSchema,
  groupConversationStatusSchema,
  groupConversationStopSchema,
} from './group-conversation-sharing.js';

/** Native Groups tools: no provider, manager, arbitrary HTTP or shell controls. */
export const groupExternalInputs = {
  groups_list: z.strictObject({}),
  groups_open: groupHostSelectSchema,
  groups_create: groupHostCreateSchema,
  groups_join: groupHostJoinSchema,
  groups_invite: groupHostSelectSchema.extend({ key: z.uuid() }),
  groups_remove_member: groupHostApprovalSchema,
  groups_remove_here: groupHostLocalVisibilitySchema,
  groups_set_read_only: groupHostLocalModeSchema,
  groups_read: groupHostSelectSchema.extend({
    query: groupFeedQuerySchema.refine((v) => v.visibility === 'shared' && v.limit <= 20),
  }),
  groups_original: groupHostSelectSchema.extend({ eventId: groupEventIdSchema }),
  groups_post: groupHostSendSchema,
  groups_delivery: groupHostSelectSchema.extend({
    key: z.uuid(),
    retry: z.boolean().default(false),
  }),
  groups_select_conversation: groupConversationSelectionSchema,
  groups_stop_sharing: groupConversationStopSchema,
  groups_sharing_status: groupConversationStatusSchema,
  groups_files_status: groupHostSelectSchema,
  groups_files_propose: groupExternalFileProposeSchema,
} as const;
export type GroupExternalTool = keyof typeof groupExternalInputs;
