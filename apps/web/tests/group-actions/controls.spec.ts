import { test, expect } from '@playwright/test';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const alice = { groupId: id(2), memberId: id(3), installationId: id(4), displayName: 'Alice' },
  bob = { groupId: id(2), memberId: id(5), installationId: id(6), displayName: 'Bob' };
const work = {
  workId: id(7),
  title: 'Analyze the shared sample',
  owner: alice,
  taskId: id(8),
  managerId: id(9),
  sharedGoalId: id(10),
  revision: 2,
  desired: 'start',
  latest: {
    actionId: id(11),
    actor: alice,
    at: '2026-10-06T12:00:00.000Z',
    origin: { kind: 'instruction', eventId: id(12) },
  },
};
test('shared conflict confirmation, retry identity, stale recovery and board fit', async ({
  page,
}, info) => {
  let confirms = 0,
    stale = true;
  const received: string[] = [];
  const proposal = {
    proposalId: id(13),
    workId: work.workId,
    kind: 'stop',
    origin: { kind: 'instruction', eventId: id(14) },
    actor: bob,
    at: '2026-10-06T13:00:00.000Z',
    observed: work,
    overrideRequired: true,
  };
  await page.route('**/api/groups/actions', async (route) => {
    const { command } = route.request().postDataJSON() as {
      command: { kind: string; operationId?: string; text?: string };
    };
    let value: unknown;
    if (command.kind === 'board')
      value = {
        kind: 'board',
        board: {
          instructions: [],
          works: [work],
          proposals: [],
          actions: [],
          notices: [],
          after: 0,
          continuation: null,
        },
      };
    else if (command.kind === 'instruction')
      value = {
        kind: 'instruction',
        instruction: {
          eventId: id(14),
          actor: bob,
          text: command.text,
          at: '2026-10-06T13:00:00.000Z',
        },
      };
    else if (command.kind === 'propose') value = { kind: 'proposal', proposal };
    else {
      confirms++;
      received.push(command.operationId!);
      if (confirms === 1) {
        await route.abort('connectionfailed');
        return;
      }
      if (stale) {
        await route.fulfill({ json: { ok: false, error: 'stale', current: work } });
        return;
      }
      value = {
        kind: 'action',
        action: { actionId: id(15), proposal, revision: 3, state: 'pending-owner', outcome: null },
      };
    }
    await route.fulfill({ json: { ok: true, value } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Analyze the shared sample' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Propose stop' })).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Shared instruction' })
    .fill('Stop until the sample is checked.');
  await page.getByRole('button', { name: 'Propose stop' }).click();
  await expect(page.getByRole('alert')).toContainText('overrides Alice’s start request');
  expect(confirms).toBe(0);
  await page.getByRole('button', { name: 'Confirm override' }).click();
  await expect(page.getByRole('alert').first()).toContainText(/connect|fetch|request/i);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Confirm override' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm override' }).click();
  await expect(page.getByRole('alert').first()).toContainText('Work changed');
  expect(received[0]).toBe(received[1]);
  await page.getByRole('button', { name: 'Discard proposal' }).click();
  await expect(page.getByRole('button', { name: 'Propose stop' })).toBeEnabled();
  stale = false;
  await page.getByRole('button', { name: 'Propose stop' }).click();
  await expect(page.getByRole('button', { name: 'Confirm override' })).toBeEnabled();
  await page.screenshot({
    path: `../../data/group-actions/${info.project.name}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Confirm override' }).click();
  await expect(page.getByRole('button', { name: 'Confirm override' })).toHaveCount(0);
});
test('native manager proposal is reviewable by its owning member after reopening', async ({
  page,
}) => {
  const proposal = {
    proposalId: id(20),
    workId: work.workId,
    kind: 'stop',
    origin: {
      kind: 'autonomous',
      eventId: id(21),
      sharedGoalId: work.sharedGoalId,
      managerId: work.managerId,
    },
    actor: bob,
    at: '2026-10-08T12:00:00.000Z',
    observed: work,
    overrideRequired: true,
  };
  let confirmed = false;
  await page.route('**/api/groups/actions', async (route) => {
    const { command } = route.request().postDataJSON();
    const value =
      command.kind === 'confirm'
        ? (() => {
            expect(command.proposalId).toBe(proposal.proposalId);
            expect(command.expectedRevision).toBe(work.revision);
            expect(command.override).toBe(true);
            confirmed = true;
            return {
              kind: 'action',
              action: {
                actionId: id(22),
                proposal,
                revision: 3,
                state: 'pending-owner',
                outcome: null,
              },
            };
          })()
        : {
            kind: 'board',
            board: {
              works: [work],
              instructions: [],
              proposals: confirmed
                ? []
                : [proposal, { ...proposal, proposalId: id(23), actor: alice }],
              actions: [],
              notices: [],
              after: 0,
              continuation: null,
            },
          };
    await route.fulfill({ json: { ok: true, value } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Review stop proposal' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Review stop proposal' }).click();
  await page.reload();
  await expect(page.getByRole('article', { name: 'Confirm shared action' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm override', exact: true }).click();
  await expect.poll(() => confirmed).toBe(true);
  await expect(page.getByRole('article', { name: 'Confirm shared action' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
