import { test, expect } from './fixture';

test('a new scan cannot replace an in-flight legacy pairing attempt and clears an old error only when accepted', async ({
  page,
}) => {
  const firstCode = 'ABCD-EFGH-JKLM-NPQR';
  const secondCode = 'BBBB-EFGH-JKLM-NPQR';
  await page.route('**/api/phone/status', (route) =>
    route.fulfill({
      json: {
        mode: 'remote',
        configured: true,
        enabled: true,
        paired: false,
        authentication: 'access',
        origin: 'https://dock.example.test',
        devices: [],
      },
    }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitted: Array<{ code: string; name: string }> = [];
  await page.route('**/api/phone/pair', async (route) => {
    submitted.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ status: 409, json: { error: 'That code did not match.' } });
  });
  try {
    await page.goto(`/#pair=${firstCode}`);
    await expect(page.getByRole('heading', { name: 'Name your phone' })).toBeVisible();
    await expect(page.getByLabel('Connection code')).toHaveCount(0);
    await page.getByLabel('Phone nickname').fill('Family iPhone');
    await page.getByRole('button', { name: 'Connect this device', exact: true }).click();
    await expect.poll(() => submitted.length).toBe(1);
    await page.evaluate((code) => {
      window.location.hash = `pair=${code}`;
    }, secondCode);
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    await expect(page.getByLabel('Phone nickname')).toBeDisabled();
    expect(submitted).toEqual([{ code: firstCode, name: 'Family iPhone' }]);
    release();
    await expect(page.getByRole('alert')).toContainText('did not match');
    await expect(page.getByRole('heading', { name: 'Enter pairing code' })).toBeVisible();
    await expect(page.getByLabel('Connection code')).toHaveValue(firstCode);
    await page.evaluate((code) => {
      window.location.hash = `pair=${code}`;
    }, secondCode);
    await expect(page.getByRole('heading', { name: 'Name your phone' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByLabel('Phone nickname')).toHaveValue('Family iPhone');
    await page.getByRole('button', { name: 'Use a different code' }).click();
    await expect(page.getByLabel('Connection code')).toHaveValue(secondCode);
    expect(submitted).toHaveLength(1);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
