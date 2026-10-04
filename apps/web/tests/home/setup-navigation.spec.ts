import { expect, test, type Page } from '@playwright/test';
import { defaultModelPolicy } from '@dock/shared';
import { expectSliderLayout } from './control-layout';

async function models(page: Page) {
  await page.route('**/api/model-policy', (route) =>
    route.fulfill({ json: { policy: defaultModelPolicy, catalogs: [] } }),
  );
  await page.route('**/api/models?*', (route) =>
    route.fulfill({
      json: (new URL(route.request().url()).searchParams.get('provider') === 'claude'
        ? ['fable', 'opus', 'sonnet']
        : ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-terra', 'gpt-6-luna']
      ).map((id) => ({
        id,
        label: id,
        isDefault: false,
        efforts: ['low', 'medium', 'high', 'xhigh'],
      })),
    }),
  );
}

test('revisiting a page trims the Back trail instead of replaying a navigation loop', async ({
  page,
}) => {
  // A → B → C → B → C must return C → B → A, including after a reload.
  await page.goto('/#/welcome');
  await expect(page.locator('main h1')).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.getByRole('link', { name: /Phone access/ }).click();
  await expect(page).toHaveURL(/#\/phone$/);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.getByRole('link', { name: /Phone access/ }).click();
  await expect(page).toHaveURL(/#\/phone$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Phone access');
  const back = page.getByRole('link', { name: 'Back', exact: true });
  await back.click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await back.click();
  await expect(page).toHaveURL(/#\/welcome$/);
  await back.click();
  await expect(page).toHaveURL(/#\/home$/);
});

test('Back does not reopen a minimized brief, and closing Help returns keyboard focus', async ({
  page,
}) => {
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  const manager = snapshot.projects.find((p: { internal?: boolean }) => !p.internal).managerId;
  await page.goto('/#/home');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');
  await page.evaluate((id) => (location.hash = `#/chat/${id}/brief`), manager);
  const minimize = page.getByRole('button', { name: /Minimize/ });
  await minimize.click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${manager}$`));
  // Phone chats are full-screen without the app header.
  await page.evaluate(() => (location.hash = '#/settings'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  const help = page.getByRole('button', { name: 'Help and setup' });
  // A keyboard user returns to the control that opened the dialog.
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Help and setup' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeFocused();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${manager}$`));
  await expect(minimize).toHaveCount(0);
});

test('project setup shows real defaults, comfortable controls and retained choices after a QUARK detour', async ({
  page,
}, info) => {
  await models(page);
  await page.goto('/#/new');
  await page.getByLabel('Project name', { exact: true }).fill('Keep this setup');
  const manager = page.getByRole('group', { name: 'Manager', exact: true });
  await expect(manager.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'gpt-6-astra',
  );
  const reasoning = manager.getByRole('combobox', { name: 'Reasoning', exact: true });
  await expect(reasoning).toHaveValue('xhigh');
  await expect(reasoning.locator('option[value=""]')).toHaveCount(0);
  await reasoning.selectOption('high');
  for (const select of await manager.getByRole('combobox').all()) {
    const box = (await select.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThan(100);
  }
  const workers = page.getByRole('group', { name: 'Workers', exact: true });
  const defaults = workers.locator('.config-defaults summary');
  expect((await defaults.boundingBox())!.y).toBeLessThan(
    (await workers.getByRole('slider').first().boundingBox())!.y,
  );
  await defaults.click();
  await expect(workers.getByRole('table')).toBeVisible();
  await defaults.click();
  const rows = await workers.locator('.config-task-summary small').all();
  expect(rows).toHaveLength(3);
  for (let i = 1; i < rows.length; i++) {
    const previous = (await rows[i - 1]!.boundingBox())!;
    expect((await rows[i]!.boundingBox())!.y).toBeGreaterThanOrEqual(previous.y + previous.height);
  }
  const choices = workers.locator('.config-task-choice');
  await expect(choices).toHaveCount(3);
  for (const choice of await choices.all()) {
    const toggle = choice.locator('summary');
    await expect(toggle).toContainText('Change');
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(choice.getByRole('combobox').first()).toBeVisible();
    await toggle.focus();
    await toggle.press('Enter');
    await expect(choice.getByRole('combobox').first()).toBeHidden();
  }
  for (const size of [16, 20, 24]) {
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = `${size}px`;
    }, size);
    for (const toggle of await choices.locator('summary').all()) {
      expect(await toggle.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  await workers
    .locator('.config-models')
    .screenshot({ path: info.outputPath('task-model-choices.png') });
  for (const row of await workers.locator('.config-check').all()) {
    await row.scrollIntoViewIfNeeded();
    const boxes = await row.evaluate((label) => {
      const row = label.getBoundingClientRect();
      return [...label.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          top: rect.top - row.top,
          bottom: row.bottom - rect.bottom,
          right: row.right - rect.right,
        };
      });
    });
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(12);
      expect(box.bottom).toBeGreaterThanOrEqual(12);
      expect(box.right).toBeGreaterThanOrEqual(0);
    }
  }
  await workers
    .getByRole('checkbox', { name: 'Let me review changes before they are applied', exact: true })
    .check();
  const decisions = workers.getByRole('combobox', {
    name: 'When a decision is needed',
    exact: true,
  });
  await expect(decisions).toHaveCount(1);
  await expect(decisions).toHaveValue('manager-decides');
  await expect(
    workers.getByRole('checkbox', { name: /After two review rounds|Stop and ask me/ }),
  ).toHaveCount(0);
  await decisions.selectOption('ask-human');
  await page.screenshot({ path: info.outputPath('worker-controls.png') });
  const priority = page.getByRole('group', { name: 'Priority and usage', exact: true });
  await expect(priority).toContainText('Tell your manager more specific priorities');
  await expect(priority).toContainText('QUARK pauses its work');
  await priority.getByRole('radio', { name: /^High / }).check();
  await page.getByRole('link', { name: 'QUARK board', exact: true }).click();
  await expect(page).toHaveURL(/#\/work$/);
  await page.reload();
  await page.locator('.home-content').evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expect(page.getByRole('link', { name: 'Back', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('quark-scrolled-back.png') });
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Keep this setup');
  await expect(reasoning).toHaveValue('high');
  await expect(decisions).toHaveValue('ask-human');
  const draft = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dock:local:project-spawn')!),
  );
  expect(draft.workflow).toMatchObject({ reviewLimit: 'ask-human', ambiguity: 'ask-human' });
  await decisions.selectOption('manager-decides');
  const updated = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dock:local:project-spawn')!),
  );
  expect(updated.workflow).toMatchObject({ reviewLimit: 'manager-decides', ambiguity: 'continue' });
  await expect(
    workers.getByRole('checkbox', {
      name: 'Let me review changes before they are applied',
      exact: true,
    }),
  ).toBeChecked();
  await expect(priority.getByRole('radio', { name: /^High / })).toBeChecked();
  await manager.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('manager-controls.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Home ends the detour. Back must never lead into that old setup again.
  await page.getByRole('link', { name: 'sciencewithagents home', exact: true }).click();
  await page.locator('a[href="#/resources"]:visible').first().click();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/#\/home$/);
});

test('right swipe returns from QUARK while vertical scrolling and form gestures keep their screen', async ({
  page,
  browserName,
}, info) => {
  await models(page);
  await page.goto('/#/new');
  const swipe = async (selector: string, dy = 0) => {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    const x = Math.max(35, box.x + 25),
      y = box.y + box.height / 2;
    if (browserName === 'chromium' && info.project.use.isMobile) {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let i = 1; i <= 5; i++)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: x + i * 22, y: y + (dy * i) / 5 }],
          });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await cdp.detach();
      }
    } else {
      // WebKit has no automation API for a native swipe; exercise its DOM gesture handler.
      await target.evaluate(
        (node, { x, y, dy }) => {
          const dispatch = (type: string, dx: number, dy: number) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            const points = [{ clientX: x + dx, clientY: y + dy }];
            Object.defineProperties(event, {
              touches: { value: type === 'touchend' ? [] : points },
              changedTouches: { value: points },
            });
            node.dispatchEvent(event);
          };
          dispatch('touchstart', 0, 0);
          dispatch('touchmove', 110, dy);
          dispatch('touchend', 110, dy);
        },
        { x, y, dy },
      );
    }
  };
  await page.getByLabel('Project name', { exact: true }).fill('Swipe draft');
  await swipe('input[type="range"]');
  await expect(page).toHaveURL(/#\/new$/);
  await swipe('.flow-heading h1', 60);
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole('link', { name: 'QUARK board', exact: true }).click();
  await expect(page).toHaveURL(/#\/work$/);
  await swipe('.quark-workspace .flow-heading h1');
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue('Swipe draft');
});

test('worker slider endpoints and labels fit at normal and doubled text size', async ({
  page,
}, info) => {
  await models(page);
  for (const route of ['new', 'models']) {
    await page.goto(`/#/${route}`);
    const workers = page.getByRole('group', { name: 'Workers', exact: true });
    await expect(workers).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const size of ['100%', '200%']) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size;
      }, size);
      for (const slider of await workers.getByRole('slider').all()) {
        await slider.press('Home');
        await expect(slider).toHaveValue('0');
        await expectSliderLayout(page);
        await slider.press('ArrowRight');
        await expect(slider).toHaveValue('1');
        await expectSliderLayout(page);
        await slider.press('End');
        await expect(slider).toHaveValue((await slider.getAttribute('max')) ?? '');
        await expectSliderLayout(page);
      }
      await workers
        .locator('.config-sliders')
        .screenshot({ path: info.outputPath(`${route}-sliders-${size}.png`) });
      await expectSliderLayout(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
