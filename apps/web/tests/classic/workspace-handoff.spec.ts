import { test, expect, type Page } from './fixture';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:4339';
async function project(page: Page) {
  const response = await page.request.post('/api/projects', {
    headers: { Origin: origin },
    data: { key: randomUUID(), name: `Handoff ${randomUUID().slice(0, 8)}`, description: '' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string; managerId: string; name: string };
}
async function openSidebar(page: Page) {
  if (
    page.viewportSize()!.width <= 720 &&
    !(await page.getByRole('navigation', { name: 'Projects' }).isVisible())
  )
    await page.getByRole('button', { name: 'Open projects' }).click();
}
async function selectProject(page: Page, name: string) {
  await openSidebar(page);
  await page
    .getByRole('navigation', { name: 'Projects' })
    .getByRole('button')
    .filter({ hasText: name })
    .click();
  await expect(page.getByRole('heading', { name: `${name} manager`, exact: true })).toBeVisible();
  await expect(
    page.getByText('Draft saved separately for this browser.', { exact: false }),
  ).toBeVisible();
}
async function renameBrowser(page: Page, name: string) {
  await openSidebar(page);
  await page.getByRole('button', { name: /^Open conversations/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Open conversations' });
  await dialog.getByRole('textbox', { name: 'Name this browser' }).fill(name);
  await dialog.getByRole('button', { name: 'Save browser name' }).click();
  await expect(dialog.getByRole('button', { name: 'Save browser name' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  if (page.viewportSize()!.width <= 720)
    await page
      .getByRole('button', { name: 'Close panel' })
      .click({ position: { x: page.viewportSize()!.width - 5, y: 5 } });
}

test('different devices keep separate drafts and one copied draft has one delivery', async ({
  page,
  browser,
}, info) => {
  const fixture = await project(page);
  const secondContext = await browser.newContext({ viewport: page.viewportSize()! });
  await secondContext.addInitScript(() => sessionStorage.setItem('dock:workspace-ui', 'classic'));
  const second = await secondContext.newPage();
  try {
    await page.goto('/');
    await selectProject(page, fixture.name);
    await renameBrowser(page, 'First browser');
    await second.goto(origin);
    await selectProject(second, fixture.name);
    await renameBrowser(second, 'Second browser');
    const firstInput = page.getByRole('textbox', { name: `Message ${fixture.name} manager` });
    const secondInput = second.getByRole('textbox', { name: `Message ${fixture.name} manager` });
    const text = `One shared delivery ${randomUUID()}`;
    await firstInput.fill(text);
    await expect(
      page.getByText('Draft saved separately for this browser.', { exact: false }),
    ).toBeVisible();
    await secondInput.fill('Separate phone typing');
    await expect(
      second.getByText('Draft saved separately for this browser.', { exact: false }),
    ).toBeVisible();
    await page.reload();
    await expect(firstInput).toHaveValue(text);
    await expect(secondInput).toHaveValue('Separate phone typing');
    await secondInput.fill('');
    await expect(
      second.getByText('Draft saved separately for this browser.', { exact: false }),
    ).toBeVisible();
    await second.reload();
    await second.getByText(/^Drafts from other browsers/).click();
    await second.getByRole('button', { name: 'Copy draft here from First browser' }).click();
    await expect(secondInput).toHaveValue(text);
    await second.screenshot({
      path: `../../data/screenshots/${info.project.name}-draft-handoff.png`,
    });
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await second.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(secondInput).toHaveValue('');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(firstInput).toHaveValue('');
    const detail = await (await page.request.get(`/api/agents/${fixture.managerId}`)).json();
    expect(detail.runs.filter((run: { text: string }) => run.text === text)).toHaveLength(1);
  } finally {
    await secondContext.close();
  }
});

test('lost draft and Send acknowledgements recover across reload without repeating work', async ({
  page,
}, info) => {
  const fixture = await project(page);
  await page.goto('/');
  await selectProject(page, fixture.name);
  const input = page.getByRole('textbox', { name: `Message ${fixture.name} manager` });
  const savedKeys: string[] = [];
  let dropSave = true;
  await page.route(`**/api/workspace/*/drafts/${fixture.managerId}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    savedKeys.push(route.request().postDataJSON().key);
    const response = await route.fetch();
    if (dropSave) {
      dropSave = false;
      return route.abort('failed');
    }
    await route.fulfill({ response });
  });
  const text = `Retry once ${randomUUID()}`;
  await input.fill(text);
  await expect(page.getByRole('button', { name: 'Retry saving draft' })).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue(text);
  await expect.poll(() => savedKeys.length).toBeGreaterThanOrEqual(2);
  expect(savedKeys[0]).toBe(savedKeys[1]);
  let sends = 0;
  await page.route(`**/api/agents/${fixture.managerId}/messages`, async (route) => {
    sends++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await expect(input).toHaveValue(text);
  await page.reload();
  await expect(input).toHaveValue('');
  expect(sends).toBe(1);
  const detail = await (await page.request.get(`/api/agents/${fixture.managerId}`)).json();
  expect(detail.runs.filter((run: { text: string }) => run.text === text)).toHaveLength(1);
  await page.screenshot({ path: `../../data/screenshots/${info.project.name}-draft-recovery.png` });
});

test('open conversations reopen without starting turns and closing only removes the view', async ({
  page,
}, info) => {
  const fixture = await project(page);
  await page.goto('/');
  await selectProject(page, fixture.name);
  await renameBrowser(page, `Saved ${info.project.name}`);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: `${fixture.name} manager`, exact: true }),
  ).toBeVisible();
  await openSidebar(page);
  await page.getByRole('button', { name: /^Open conversations/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Open conversations' });
  await expect(
    dialog.getByRole('button', { name: `${fixture.name} manager · Current`, exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: `Close ${fixture.name} manager view`, exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: `Close ${fixture.name} manager view`, exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-workspace-restore.png`,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const detail = await (await page.request.get(`/api/agents/${fixture.managerId}`)).json();
  expect(detail.runs).toEqual([]);
  expect(detail.entries).toEqual([]);
});

test('stale tabs retain both versions and require an explicit draft choice', async ({
  page,
  context,
}) => {
  const fixture = await project(page);
  await page.goto('/');
  await selectProject(page, fixture.name);
  const other = await context.newPage();
  try {
    await other.goto(origin);
    const firstInput = page.getByRole('textbox', { name: `Message ${fixture.name} manager` });
    const otherInput = other.getByRole('textbox', { name: `Message ${fixture.name} manager` });
    await expect(
      other.getByText('Draft saved separately for this browser.', { exact: false }),
    ).toBeVisible();
    await firstInput.fill('First tab saved this version');
    await expect(
      page.getByText('Draft saved separately for this browser.', { exact: false }),
    ).toBeVisible();
    await otherInput.fill('Second tab still has its own typing');
    await expect(other.getByRole('button', { name: 'Keep my text', exact: true })).toBeVisible();
    await expect(otherInput).toHaveValue('Second tab still has its own typing');
    await expect(firstInput).toHaveValue('First tab saved this version');
    await expect(other.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    const clientId = await page.evaluate(() => localStorage.getItem('dock:local:workspace:client'));
    const before = await (
      await page.request.get(`/api/workspace/${clientId}/drafts/${fixture.managerId}`)
    ).json();
    expect(before.own.text).toBe('First tab saved this version');
    await other.getByRole('button', { name: 'Keep my text', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Keep my text', exact: true })).toHaveCount(0);
    await expect(
      other.getByText('Draft saved separately for this browser.', { exact: false }),
    ).toBeVisible();
    const after = await (
      await page.request.get(`/api/workspace/${clientId}/drafts/${fixture.managerId}`)
    ).json();
    expect(after.own.text).toBe('Second tab still has its own typing');
    const detail = await (await page.request.get(`/api/agents/${fixture.managerId}`)).json();
    expect(detail.runs).toEqual([]);
  } finally {
    await other.close();
  }
});

test('older browser drafts migrate once without resurfacing after a confirmed send', async ({
  page,
}) => {
  const fixture = await project(page);
  const text = `A draft saved before shared workspaces ${randomUUID()}`;
  await page.addInitScript(
    ({ id, text }) => {
      if (!localStorage.getItem('dock:legacy-fixture-installed')) {
        localStorage.setItem(`dock:draft:${id}`, text);
        localStorage.setItem('dock:legacy-fixture-installed', '1');
      }
    },
    { id: fixture.managerId, text },
  );
  await page.goto('/');
  await selectProject(page, fixture.name);
  const input = page.getByRole('textbox', { name: `Message ${fixture.name} manager` });
  await expect(input).toHaveValue(text);
  await expect
    .poll(() => page.evaluate((id) => localStorage.getItem(`dock:draft:${id}`), fixture.managerId))
    .toBeNull();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(input).toHaveValue('');
  // Even a stale legacy backup left by an earlier client must not silently resurrect.
  await page.evaluate(({ id, text }) => localStorage.setItem(`dock:draft:${id}`, text), {
    id: fixture.managerId,
    text,
  });
  await page.reload();
  await expect(input).toHaveValue('');
  await expect(page.getByText('Older browser draft retained', { exact: true })).toHaveCount(0);
  const detail = await (await page.request.get(`/api/agents/${fixture.managerId}`)).json();
  expect(detail.runs.filter((run: { text: string }) => run.text === text)).toHaveLength(1);
});
