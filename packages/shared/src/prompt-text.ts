import { z } from 'zod';

// One limit for owner chat, autosaves and editable follow-ups. Transport headroom
// includes JSON escaping and multi-byte text; provider context limits still apply.
export const promptTextLimit = 200_000;
export const promptBodyLimit = 2 * 1024 * 1024;
export const draftTextSchema = z.string().max(promptTextLimit);
export const promptTextSchema = z.string().trim().min(1).max(promptTextLimit);
