import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { agentSchema, groupFeedPageSchema } from '@dock/shared';
import {
  groupHostChatSchema,
  groupHostListSchema,
  groupHostOpenSchema,
} from '@dock/shared/dist/group-host.js';
import { groupNativeOwnerStatusSchema } from '@dock/shared/dist/group-native-owner.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const date = '2026-10-09T12:00:00.000Z';
const member = {
  groupId: id(1),
  memberId: id(2),
  installationId: id(3),
  displayName: 'Amina',
  active: true,
};
const group = {
  id: id(1),
  handle: id(4),
  name: 'Native group capability',
  members: 1,
  sync: 'Ready',
  state: 'active',
  local: { hidden: false, revision: 0, mode: 'contribute', modeRevision: 0 },
};
const actor = {
  groupId: member.groupId,
  memberId: member.memberId,
  installationId: member.installationId,
  displayName: member.displayName,
};
const agent = agentSchema.parse({
  id: id(5),
  projectId: id(6),
  parentId: null,
  taskId: null,
  name: 'My group agent',
  role: 'manager',
  status: 'idle',
  model: null,
  effort: 'low',
  permission: 'workspace-write',
  checkpoint: '',
  createdAt: date,
  updatedAt: date,
});
const native = {
  executionMode: 'host',
  available: true,
  productionReady: true,
  authState: 'ready',
  message: 'Native access ready.',
};
const shared = {
  handle: id(7),
  context: {
    groupId: member.groupId,
    memberId: member.memberId,
    installationId: member.installationId,
    sessionId: id(8),
    visibility: 'shared',
    provider: 'codex',
    nativeSessionId: 'synthetic-native-group',
  },
  agent,
};
const opened = groupHostOpenSchema.parse({
  group,
  member,
  members: [member],
  shared,
  private: {
    ...shared,
    handle: id(9),
    context: { ...shared.context, sessionId: id(10), visibility: 'private' },
  },
  native,
  feedWriter: { canSelect: true, enabled: false, message: 'Optional summaries are off.' },
});
const original = 'To-do: check the retained shared sample.';
const bytes = Buffer.byteLength(original);
const hash = createHash('sha256').update(original).digest('hex');
const feed = groupFeedPageSchema.parse({
  entries: [
    {
      eventId: id(11),
      sequence: 1,
      scope: {
        groupId: member.groupId,
        memberId: member.memberId,
        installationId: member.installationId,
        visibility: 'shared',
        source: {
          sessionId: shared.context.sessionId,
          provider: 'owner',
          nativeSessionId: shared.context.nativeSessionId,
          messageId: id(12),
        },
        causalRefs: [],
      },
      operationId: id(13),
      entityId: id(14),
      revision: 1,
      category: 'Action',
      condensedText: original,
      evidenceRefs: [],
      corrects: null,
      manifest: { bytes, sha256: hash, chunks: [{ index: 0, bytes, sha256: hash }] },
      recordedAt: date,
    },
  ],
  watermark: 1,
  continuation: null,
});
const chat = groupHostChatSchema.parse({
  detail: { agent, entries: [], runs: [], hasMore: false },
  draft: { text: '', revision: 0 },
  deliveries: [],
  nativeRequests: [],
});
const earlier = groupHostOpenSchema.parse({
  ...opened,
  group: { ...opened.group, id: id(20), handle: id(21), name: 'Earlier group' },
  member: { ...member, groupId: id(20) },
  members: [{ ...member, groupId: id(20) }],
  shared: {
    ...opened.shared,
    handle: id(22),
    context: { ...opened.shared.context, groupId: id(20), sessionId: id(23) },
  },
  private: { ...opened.private, context: { ...opened.private.context, groupId: id(20) } },
});
const earlierReplies: (() => void)[] = [];
const releaseEarlier = () => earlierReplies.splice(0).forEach((release) => release());
test.afterEach(releaseEarlier);

for (const capability of ['direct', 'legacy', 'managed'] as const) {
  test(`${capability} owner capability preserves normal Groups and scopes managed execution controls`, async ({
    page,
  }, info) => {
    const ownerAgent = { ...agent, executionMode: capability === 'direct' ? 'direct' : 'managed' };
    const status = groupNativeOwnerStatusSchema.parse({
      executionMode: 'host',
      ...(capability === 'legacy'
        ? {}
        : { sessionMode: capability, managedCoordination: capability === 'managed' }),
      hostEnabled: true,
      configured: true,
      productionReady: true,
      provider: 'codex',
      setupId: null,
      state: 'verified',
      message: `${capability} native access confirmed.`,
    });
    let actionReads = 0;
    let earlierStatusRead = false;
    let earlierChatReads = 0;
    const unexpected: string[] = [];
    await page.route('**/api/groups**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const input = route.request().postDataJSON() as {
        handle?: string;
        action?: string;
        query?: { after: number };
        command?: { kind: string };
      } | null;
      let value: unknown;
      if (path === '/api/groups')
        value = groupHostListSchema.parse({
          groups: [group],
          service: { configured: true, message: 'Synthetic service ready.' },
          native,
        });
      else if (path === '/api/groups/open')
        value =
          input?.handle === earlier.group.handle
            ? earlier
            : { ...opened, shared: { ...opened.shared, agent: ownerAgent } };
      else if (path === '/api/groups/chat') {
        if (input?.handle === earlier.shared.handle) earlierChatReads++;
        value = { ...chat, detail: { ...chat.detail, agent: ownerAgent } };
      } else if (path === '/api/groups/native-owner' && input?.action === 'status') {
        if (input.handle === earlier.shared.handle) {
          earlierStatusRead = true;
          await new Promise<void>((resolve) => {
            earlierReplies.push(resolve);
          });
          value = { ...status, sessionMode: 'managed', managedCoordination: true };
        } else value = status;
      } else if (path === '/api/groups/feed')
        value =
          input?.handle === earlier.shared.handle
            ? { entries: [], watermark: 0, continuation: null }
            : input?.query?.after
              ? { ...feed, entries: [] }
              : feed;
      else if (path === '/api/groups/original') value = { eventId: id(11), text: original };
      else if (path === '/api/groups/workspace' && input?.action === 'status')
        value = {
          revision: 0,
          selectionKey: null,
          workspacePath: null,
          available: false,
          message: 'Choose this group’s work folder.',
        };
      else if (path === '/api/groups/native-git' && input?.action === 'status')
        value = {
          available: false,
          repository: null,
          workspacePath: null,
          branch: 'main',
          githubUsername: '',
          autoSync: false,
          dirty: false,
          busy: false,
          message: 'Connect your private repository when ready.',
          tasks: [],
          preview: null,
        };
      else if (path === '/api/groups/actions' && input?.command?.kind === 'board') {
        actionReads++;
        value = {
          ok: true,
          value: {
            kind: 'board',
            board: {
              works: [
                {
                  workId: id(15),
                  title: 'Retained managed work',
                  owner: actor,
                  taskId: id(16),
                  managerId: agent.id,
                  sharedGoalId: id(17),
                  revision: 1,
                  desired: 'start',
                  latest: {
                    actionId: id(18),
                    actor,
                    at: date,
                    origin: { kind: 'instruction', eventId: id(19) },
                  },
                },
              ],
              instructions: [],
              proposals: [],
              actions: [],
              notices: [],
              after: 0,
              continuation: null,
            },
          },
        };
      } else {
        unexpected.push(path);
        await route.fulfill({ status: 400, json: { error: 'Unexpected fixture operation.' } });
        return;
      }
      await route.fulfill({ json: value });
    });
    if (capability === 'direct') {
      await page.goto(`/#/chats/groups/${earlier.group.handle}`);
      await expect.poll(() => earlierStatusRead).toBe(true);
      await page.evaluate((handle) => {
        location.hash = `#/chats/groups/${handle}`;
      }, group.handle);
    } else await page.goto(`/#/chats/groups/${group.handle}`);
    await expect(page.getByRole('heading', { name: group.name, exact: true })).toBeVisible();
    // This is the existing native-owner status read; no separate capability poll.
    const manage = page.getByRole('dialog', { name: 'Manage group', exact: true });
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await manage.getByText('My agent on this computer', { exact: true }).click();
    await expect(manage.getByRole('status').filter({ hasText: status.message })).toHaveText(
      status.message,
    );
    await manage.getByText('Advanced', { exact: true }).click();
    const actions = manage.getByText('Review proposed shared actions', { exact: true });
    if (capability === 'direct') {
      await expect(actions).toHaveCount(0);
      await expect(manage).toContainText('Managed shared actions are unavailable');
      await expect(manage.getByRole('button', { name: 'Propose start' })).toHaveCount(0);
      await expect(manage.getByRole('button', { name: 'Propose stop' })).toHaveCount(0);
      expect(actionReads).toBe(0);
      const priorReads = earlierChatReads;
      releaseEarlier();
      // The old owner callback performs its existing chat refresh after reporting
      // the capability. This barrier proves it cannot re-enable this new context.
      await expect.poll(() => earlierChatReads).toBeGreaterThan(priorReads);
      await expect(actions).toHaveCount(0);
      expect(actionReads).toBe(0);
    } else {
      await actions.click();
      await expect(manage.getByRole('heading', { name: 'Retained managed work' })).toBeVisible();
      await expect(manage.getByRole('button', { name: 'Propose start' })).toBeVisible();
      await expect(manage.getByRole('button', { name: 'Propose stop' })).toBeVisible();
      expect(actionReads).toBe(1);
    }
    for (const label of [
      'Work folder',
      'Git sync and reviewed changes',
      'Browse earlier shared reports',
      'Creator backup of shared group data',
    ])
      await expect(manage.getByText(label, { exact: true })).toBeVisible();
    expect(await manage.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../data/group-capability/${info.project.name}-${capability}.png`,
    });
    await manage.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Contribution mode: Contribute' })).toBeVisible();
    await expect(page.getByText(original, { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'My group agent', exact: true }).click();
    const intent = page.getByRole('combobox', { name: 'Agent request', exact: true });
    await expect(intent).toBeEnabled();
    await expect(intent.locator('option')).toHaveText(['Ask', 'Work']);
    expect(unexpected).toEqual([]);
  });
}
