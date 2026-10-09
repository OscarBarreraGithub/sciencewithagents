import { test, expect } from '@playwright/test';

for (const state of ['pending', 'unavailable'] as const) {
  test(`report capture guidance retains ${state} disposition and exact reply through reload`, async ({
    page,
  }) => {
    const requests: unknown[] = [];
    await page.route('**/api/groups/document-offer', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: state === 'pending' ? 503 : 409,
        json: {
          code:
            state === 'pending'
              ? 'GROUP_DOCUMENT_CAPTURE_PENDING'
              : 'GROUP_DOCUMENT_CAPTURE_UNAVAILABLE',
          error: 'Private diagnostic /private/canary must never be displayed',
        },
      });
    });
    await page.goto(`/?capture=${state}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = page.getByRole('region', { name: 'Saved report capture' });
      const button = report.getByRole('button', { name: 'Open report from this reply' });
      const expected =
        state === 'pending' ? 'Report capture is still finishing' : 'explicitly request new Work';
      await expect(report.getByRole('status')).toContainText(expected);
      await button.click();
      await expect(report.getByRole('alert')).toContainText(expected);
      if (state === 'pending') await expect(button).toBeEnabled();
      else await expect(button).toBeDisabled();
      await expect(page.locator('body')).not.toContainText('canary');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (!attempt) await page.reload();
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]).not.toHaveProperty('path');
  });
}
