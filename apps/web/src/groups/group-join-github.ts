import { groupHostOpenSchema } from '@dock/shared/dist/group-host.js';
import { groupGitHubViewSchema, githubUsernameSchema } from '@dock/shared/dist/group-github.js';
import { api, apiScope } from '../api';
/** Membership and profile have separate durable receipts, including pending/resumed joins. */
export async function retainJoinGitHub(
  scope: string,
  group: { handle: string; state: string },
  raw: string | undefined,
  current: () => boolean,
) {
  if (!raw) return;
  const username = githubUsernameSchema.parse(raw);
  const guard = () => {
    if (apiScope() !== scope || !current())
      throw new Error('The original computer changed; its join/profile receipts are retained.');
  };
  guard();
  const storage = `swa:groups:${scope}:github-join-profile:${group.handle}`;
  const existing = JSON.parse(sessionStorage.getItem(storage) ?? 'null') as {
    key: string;
    username: string;
    handle?: string;
  } | null;
  const profile = existing ?? { key: crypto.randomUUID(), username };
  if (profile.username.toLowerCase() !== username.toLowerCase())
    throw new Error('Retry the existing saved GitHub profile before replacing its username.');
  sessionStorage.setItem(storage, JSON.stringify(profile));
  if (group.state !== 'active') return;
  try {
    const opened = groupHostOpenSchema.parse(await api('/groups/open', { handle: group.handle }));
    guard();
    profile.handle = opened.shared.handle;
    sessionStorage.setItem(storage, JSON.stringify(profile));
    const result = groupGitHubViewSchema.parse(
      await api('/groups/github', {
        action: 'profile',
        handle: opened.shared.handle,
        key: profile.key,
        username: profile.username,
      }),
    );
    guard();
    if (result.receipt?.key === profile.key && result.receipt.committed)
      sessionStorage.removeItem(storage);
  } catch {
    /* Joining succeeded independently; exact profile retry remains in Manage. */
  }
}
