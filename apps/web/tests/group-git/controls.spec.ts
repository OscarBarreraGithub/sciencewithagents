import { test, expect } from '@playwright/test';
const handle = '10000000-0000-4000-8000-000000000001';
const resource = {
  id: 'saved-repo',
  label: 'Project report',
  branch: 'refs/heads/main',
  visibility: 'content',
  paths: [
    { id: 'opaque-file-1', name: 'report.tex', visibility: 'content' },
    { id: 'opaque-file-2', name: 'chapter.tex', visibility: 'private' },
  ],
  reviews: [{ id: 'approved-review', sourceOid: 'a'.repeat(40) }],
};
const response = {
  message: 'Saved repository ready.',
  repositories: [resource],
  selected: {
    id: resource.id,
    branch: resource.branch,
    observedOid: 'a'.repeat(40),
    nextAttemptAt: null,
    pending: false,
    snapshot: {
      copyId: 'copy',
      revision: 1,
      headOid: 'a'.repeat(40),
      baseOid: 'b'.repeat(40),
      dirty: true,
      untracked: true,
      conflicts: false,
      complete: true,
      writerGeneration: 1,
      paths: ['report.tex'],
      renames: [['draft.tex', 'report.tex']],
      unsavedAwareness: 'unavailable',
    },
    warnings: [{ message: 'Another collaborator plans edits here.', paths: ['report.tex'] }],
  },
};
test('normal saved Git controls preserve exact retry and show working-file/visibility evidence', async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  let fail = true;
  await page.route('**/api/groups/git', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.handle).toBe(handle);
    commands.push(body.command);
    if (body.command.kind === 'policy' && fail) {
      fail = false;
      return route.fulfill({
        status: 503,
        json: { error: 'Acknowledgement lost; saved change retained.' },
      });
    }
    return route.fulfill({
      json: {
        ...response,
        ...(body.command.key
          ? {
              receipt: {
                key: body.command.key,
                state: 'completed',
                message: 'Saved change acknowledged.',
              },
            }
          : {}),
      },
    });
  });
  await page.goto('/');
  await page.getByText('Shared Git workspace', { exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved repository ready');
  await expect(
    page.getByText('Unsaved editor buffers cannot be checked.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Uncommitted changes.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Check working files' }).click();
  await page.getByRole('button', { name: 'Check overlaps' }).click();
  await expect(page.getByRole('region', { name: 'Overlap warnings' })).toContainText(
    'Another collaborator',
  );
  await page.getByText('Resource visibility and planned edits', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Visibility', exact: true }).selectOption('metadata');
  await page.getByRole('button', { name: 'Save visibility' }).click();
  await expect(page.getByRole('alert')).toContainText('Acknowledgement lost');
  const original = commands.find((c) => c.kind === 'policy')!;
  expect(original.paths).toEqual([]);
  expect(original).not.toHaveProperty('path');
  expect(original.key).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload();
  await page.getByText('Shared Git workspace', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved change' })).toBeVisible();
  await page.getByText('Resource visibility and planned edits', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save visibility' })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry saved change' }).click();
  expect(commands.filter((c) => c.kind === 'policy')).toEqual([original, original]);
  await page.getByRole('button', { name: 'Share planned edits' }).click();
  expect(commands.find((c) => c.kind === 'intent')?.paths).toEqual(['opaque-file-1']);
  await page.getByText('Reviewed proposals and separate views', { exact: true }).click();
  await page.getByRole('button', { name: 'Publish reviewed proposal' }).click();
  expect(commands.find((c) => c.kind === 'propose')?.reviewId).toBe('approved-review');
  await page.getByRole('button', { name: 'Create separate task view' }).click();
  expect(commands.find((c) => c.kind === 'view')?.view).toBe('task');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('panel.png'), fullPage: true });
});

test('first run without a saved resource offers setup without pretending Git is ready', async ({
  page,
}) => {
  await page.route('**/api/groups/git', (route) =>
    route.fulfill({
      json: { message: 'No repository is connected.', repositories: [], selected: null },
    }),
  );
  await page.goto('/');
  await page.getByText('Shared Git workspace', { exact: true }).click();
  await expect(page.getByRole('status')).toContainText('No repository is connected');
  await expect(
    page.getByText('Ask the setup agent to connect a repository', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish reviewed proposal' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('explicit pre-effect refusal acknowledges the exact key and permits a new choice', async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = [];
  await page.route('**/api/groups/git', (route) => {
    const body = route.request().postDataJSON();
    if (body.command.key) commands.push(body.command);
    return route.fulfill({
      json: {
        ...response,
        ...(body.command.key
          ? {
              receipt: {
                key: body.command.key,
                state: 'refused',
                message: 'Policy changed before this request; no change was applied.',
              },
            }
          : {}),
      },
    });
  });
  await page.goto('/');
  await page.getByText('Shared Git workspace', { exact: true }).click();
  await page.getByText('Resource visibility and planned edits', { exact: true }).click();
  await page.getByRole('button', { name: 'Save visibility' }).click();
  await expect(page.getByRole('alert')).toContainText('no change was applied');
  await expect(page.getByRole('button', { name: 'Retry saved change' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save visibility' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Visibility', exact: true }).selectOption('private');
  await page.getByRole('button', { name: 'Save visibility' }).click();
  expect(commands).toHaveLength(2);
  expect(commands[0]?.key).not.toBe(commands[1]?.key);
});
