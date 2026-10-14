import { z } from 'zod';
import { appUpdateCheckSchema } from './app-updates.js';
export const appSourceBranchSchema = z.enum(['main', 'groups-only']);
export type AppSourceBranch = z.infer<typeof appSourceBranchSchema>;
export const appSourceUpdatesSchema = z.object({
  branch: appSourceBranchSchema,
  check: appUpdateCheckSchema.nullable(),
  lastSuccessful: appUpdateCheckSchema.nullable(),
  nextCheckAt: z.string().datetime().nullable(),
});
export type AppSourceUpdates = z.infer<typeof appSourceUpdatesSchema>;
export function appSourceUpdatePrompt(branch: AppSourceBranch) {
  return `Check and prepare an update of my existing sciencewithagents installation from the ${branch} branch of https://github.com/OscarBarreraGithub/sciencewithagents. Follow docs/${branch === 'groups-only' ? 'GROUPS_ONLY' : 'UPDATE_APP'}.md. Follow the current branch head for future updates; resolve and record one exact SHA for this prepared update and independent review. Preserve my source changes, Git history, launcher, private data, groups, folders, receipts, accounts, settings and running work. Inspect active/queued work and preserve source/data recovery copies first. Prepare and review a bounded change using my native tools; do not start QUARK or an app-owned manager. Do not reset, clean, force-push, switch branches silently, install integrations or deploy a Worker merely to update this app. Apply only the exact reviewed change under my project policy. At an idle checkpoint, use my existing launcher to stop only this installation, install pinned dependencies with pnpm install --frozen-lockfile, build and reopen with the same data/port. Verify the running Groups workflow and saved records; distinguish prepared source from the running version. Keep tracking ${branch} for subsequent updates. Ask only about a real conflict or necessary owner action. Report unverified steps.`;
}
