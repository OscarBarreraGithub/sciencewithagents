import { test, expect } from '@playwright/test';
import { invitationPage } from '../../../group-service/src/invite-page';

test('public invitation handoff scrubs secrets, copies safely and stays readable', async ({
  page,
}) => {
  const origin = 'https://groups.example.test';
  const secret = 'a'.repeat(64);
  const id = 'a75f93cd-70ab-4ffb-92e1-40f76bc3e7cf';
  const fragment = `#/groups?invite=${encodeURIComponent(
    JSON.stringify({
      groupId: id,
      secret,
      name: 'Research group',
      service: {
        version: 1,
        mode: 'hosted',
        endpoint: `${origin}/`,
        endpointId: id,
        hostingAuthorization: { origin, approvalCapability: 'b'.repeat(64), freeApprovalId: id },
      },
    }),
  )}`;
  const fullLink = `${origin}/join${fragment}`;
  const response = invitationPage();
  const headers = Object.fromEntries(response.headers);
  const body = await response.text();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route(`${origin}/**`, (route) => route.fulfill({ status: 200, headers, body }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedInvite?: string }).copiedInvite = text;
        },
      },
    });
  });
  await page.goto(fullLink);
  await expect(page.getByRole('button', { name: 'Copy invitation', exact: true })).toBeVisible();
  expect(page.url()).toBe(`${origin}/join`);
  await page.getByRole('button', { name: 'Copy invitation', exact: true }).click();
  expect(
    await page.evaluate(() => (window as Window & { copiedInvite?: string }).copiedInvite),
  ).toBe(fullLink);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(secret);
  expect(requests.every((url) => !url.includes(secret) && !url.includes('invite='))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw Error('unavailable');
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Invitation copied', exact: true }).click();
  await expect(page.getByText(/Copy did not work/)).toBeVisible();
  expect(
    await page
      .locator('#invitation')
      .evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart),
  ).toBe(fullLink.length);
  await page.evaluate(() => {
    location.hash = '#/groups?invite=invalid';
  });
  await expect(page.getByText(/incomplete or malformed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy invitation', exact: true })).toBeHidden();
  expect(page.url()).toBe(`${origin}/join`);
});
