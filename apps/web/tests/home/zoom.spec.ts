import { chromium, expect, test } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

for (const size of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test(`real tab zoom preserves workflow screens at ${size.width} by ${size.height}`, async ({}, info) => {
    test.skip(
      info.project.name !== 'desktop',
      'Real tab zoom runs on desktop; phone layouts have their own checks.',
    );
    test.setTimeout(180_000);
    const root = resolve('../../data/zoom');
    await mkdir(root, { recursive: true });
    const owned = await mkdtemp(join(root, 'workflow-'));
    const extension = join(owned, 'extension');
    await mkdir(extension);
    await writeFile(
      join(extension, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Local workflow zoom check',
        version: '1.0',
        permissions: ['tabs'],
        host_permissions: ['http://127.0.0.1:4339/*'],
        background: { service_worker: 'background.js' },
      }),
    );
    await writeFile(
      join(extension, 'background.js'),
      'chrome.runtime.onInstalled.addListener(() => {});',
    );
    const context = await chromium.launchPersistentContext(join(owned, 'profile'), {
      channel: 'chromium',
      headless: true,
      viewport: size,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const measurements: unknown[] = [];
    try {
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(15_000);
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:4339');
      await page.evaluate(() => {
        localStorage.setItem(
          'dock:local-access:retained:zoom',
          JSON.stringify({
            version: 1,
            source: 'http://127.0.0.1:4339',
            createdAt: '2026-09-28T12:00:00.000Z',
            entries: [
              {
                kind: 'session',
                key: 'dock:mirror:local:retained',
                value: 'Retained draft text for a conversation.',
              },
            ],
          }),
        );
      });
      const phone = await (await page.request.get('http://127.0.0.1:4339/api/phone/status')).json();
      let localLocked = false;
      await page.route('**/api/phone/status', (route) =>
        route.fulfill({
          status: localLocked ? 401 : 200,
          json: localLocked
            ? {
                error: 'Open the installed app to reconnect.',
                code: 'LOCAL_UNLOCK_REQUIRED',
                reconnectUrl: null,
              }
            : { ...phone, setupIssue: 'listener', enabled: false, connection: 'error' },
        }),
      );
      const snapshot = await (await page.request.get('http://127.0.0.1:4339/api/snapshot')).json();
      const project = snapshot.projects[0];
      const task = snapshot.tasks[0];
      Object.assign(task, { status: 'done', hasReviewedChanges: true });
      await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
      await page.route('**/api/local-access/status', (route) =>
        route.fulfill({ json: { enabled: true } }),
      );
      await page.route(`**/api/tasks/${task.id}/integration`, (route) =>
        route.fulfill({
          json: {
            taskId: task.id,
            source: 'a'.repeat(40),
            target: 'b'.repeat(40),
            changes: 'draft.ts | 4 ++++',
            patch: '+Save drafts safely.',
            canApply: true,
            relation: 'fast-forward',
            reconciliationTaskId: null,
          },
        }),
      );
      await page.setViewportSize(size);
      for (const factor of [1.25, 1.5, 2, 2.5]) {
        await worker.evaluate(async (factor) => {
          const c = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  query(query: object): Promise<{ id: number; url?: string }[]>;
                  setZoom(id: number, factor: number): Promise<void>;
                };
              };
            }
          ).chrome;
          const tab = (await c.tabs.query({})).find((t) =>
            t.url?.startsWith('http://127.0.0.1:4339'),
          )!;
          await c.tabs.setZoom(tab.id, factor);
        }, factor);
        await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(factor, 1);
        for (const route of [
          `review/${task.id}`,
          'settings',
          'welcome',
          'advanced',
          `advanced/${project.managerId}`,
          'assistant-settings',
          'vscode',
          'search',
          'workspace',
          'computers',
          'phone',
          'recovery',
          'work',
          'attention',
          'activity',
          'transcribe',
          'projects',
          'chats',
          `project/${project.id}`,
          `task/${snapshot.tasks[0].id}`,
          `chat/${project.managerId}`,
          'new',
        ]) {
          await page.goto(`http://127.0.0.1:4339/#/${route}`);
          await expect(page.locator('.flow-page')).toBeVisible();
          if (route === 'welcome') {
            const exit = page.getByRole('link', { name: 'Open home', exact: true });
            await exit.scrollIntoViewIfNeeded();
            await expect(exit).toBeInViewport();
          }
          if (route === 'phone') {
            const retry = page.getByRole('button', { name: 'Retry connection', exact: true });
            await retry.scrollIntoViewIfNeeded();
            await expect(retry).toBeInViewport();
          }
          if (route === 'recovery') {
            await page.locator('.retained-copy > summary').click();
            await page.locator('.retained-entry > summary').click();
            const text = page.getByRole('textbox', { name: 'Retained text' });
            await text.scrollIntoViewIfNeeded();
            await expect(text).toBeInViewport();
            await expect(text).toHaveValue('Retained draft text for a conversation.');
          }
          if (route.startsWith('review/')) {
            await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
            const confirmation = page.getByRole('button', {
              name: 'Confirm and apply changes',
              exact: true,
            });
            await confirmation.scrollIntoViewIfNeeded();
            await expect(confirmation).toBeInViewport();
            await page.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
          }
          if (route.startsWith('advanced/')) {
            const save = page.getByRole('button', { name: 'Save settings', exact: true });
            await save.scrollIntoViewIfNeeded();
            await expect(save).toBeInViewport();
          }
          if (route.startsWith('project/')) {
            await page.getByText('Tools for new workers', { exact: true }).click();
            const saveTools = page.getByRole('button', {
              name: 'Save worker settings',
              exact: true,
            });
            await saveTools.scrollIntoViewIfNeeded();
            await expect(saveTools).toBeInViewport();
            for (const [action, submit] of [
              ['Add task', 'Create task'],
              ['Add manager', 'Create manager'],
            ]) {
              await page.getByRole('button', { name: action, exact: true }).click();
              const button = page.getByRole('button', { name: submit, exact: true });
              await button.scrollIntoViewIfNeeded();
              await expect(button).toBeInViewport();
              await page.keyboard.press('Escape');
            }
          }
          if (route === 'new') {
            const sent: string[] = [];
            page.on('request', (request) => {
              if (request.method() === 'POST' && request.url().endsWith('/messages'))
                sent.push(request.url());
            });
            await expect(
              page.getByRole('heading', { name: 'Start or connect a project', exact: true }),
            ).toBeVisible();
            await page.getByRole('radio', { name: /New folder/ }).check();
            const name = `Zoom ${size.width} ${factor}`;
            await page.getByLabel('Project name', { exact: true }).fill(name);
            const spawn = page.getByRole('button', { name: 'Spawn', exact: true });
            await spawn.scrollIntoViewIfNeeded();
            await expect(spawn).toBeInViewport();
            await page.reload();
            await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(name);
            await page.getByRole('button', { name: 'Spawn', exact: true }).click();
            const brief = page.getByRole('dialog', { name: 'Describe your project', exact: true });
            await expect(brief).toBeVisible();
            const description = `Draft retained at ${factor}x zoom.`;
            const descriptionField = brief.getByRole('textbox', {
              name: 'Project description',
              exact: true,
            });
            await descriptionField.fill(description);
            await expect(brief.locator('.notepad-status')).toHaveText('Saved in this browser');
            await page.reload();
            await expect(
              page.getByRole('dialog', { name: 'Describe your project', exact: true }),
            ).toBeVisible();
            await expect(
              page
                .getByRole('dialog', { name: 'Describe your project', exact: true })
                .getByRole('textbox', { name: 'Project description', exact: true }),
            ).toHaveValue(description);
            const snapshot = await (await page.request.get('/api/snapshot')).json();
            const managerId = snapshot.projects.find(
              (p: { name: string }) => p.name === name,
            ).managerId;
            const created = await (await page.request.get(`/api/agents/${managerId}`)).json();
            expect(created.runs).toEqual([]);
            expect(sent).toEqual([]);

            await page.route('**/api/project-options', (route) =>
              route.fulfill({ json: { canChooseFolder: true } }),
            );
            await page.route('**/api/projects/connect-folder', (route) =>
              route.fulfill({
                json: {
                  project: null,
                  selection: {
                    key: route.request().postDataJSON().key,
                    name: 'Folder with existing research files',
                    needsTracking: true,
                  },
                },
              }),
            );
            // Folder layout is a separate fixture. Real navigation deliberately retains an
            // unsent project's setup; remove only this test receipt after verifying its draft.
            await page.evaluate(() => {
              localStorage.removeItem('dock:local:project-spawn');
              sessionStorage.removeItem('dock:local:project-spawn:brief-open');
            });
            await page.goto('http://127.0.0.1:4339/#/new');
            await page.reload();
            await expect(
              page.getByRole('heading', { name: 'Start or connect a project', exact: true }),
            ).toBeVisible();
            await page.getByRole('radio', { name: /Existing folder/ }).check();
          }
          if (route === 'new') {
            await expect(
              page.getByText('Selected folder: Folder with existing research files', {
                exact: true,
              }),
            ).toBeVisible();
            const tracking = page.getByRole('button', {
              name: 'Spawn',
              exact: true,
            });
            await tracking.scrollIntoViewIfNeeded();
            await expect(tracking).toBeInViewport();
            const another = page.getByRole('button', { name: 'Choose another folder' });
            await another.scrollIntoViewIfNeeded();
            await expect(another).toBeInViewport();
            await another.click();
          }
          const measured = await page.evaluate(() => {
            const panel = document.querySelector('.home-content')!;
            const panelOverflowPx = panel.scrollHeight - panel.clientHeight;
            return {
              width: innerWidth,
              height: innerHeight,
              documentWidth: document.documentElement.scrollWidth,
              documentHeight: document.documentElement.scrollHeight,
              panelOverflowPx,
              panelScroll: panelOverflowPx > 8,
              hint: document.querySelector('.home-scroll-hint')?.textContent,
            };
          });
          expect(measured.documentWidth).toBeLessThanOrEqual(measured.width);
          expect(measured.documentHeight).toBeLessThanOrEqual(measured.height);
          if (measured.panelScroll)
            await expect(
              page.locator('.home-scroll-hint'),
              JSON.stringify({ size, factor, route, ...measured }),
            ).not.toBeEmpty();
          measurements.push({ size, factor, route, ...measured });
        }
        await page.screenshot({ path: join(root, `${size.width}-${factor}-form.png`) });
        localLocked = true;
        await page.goto('http://127.0.0.1:4339');
        await expect(page.getByRole('heading', { name: 'Open your workspace' })).toBeVisible();
        const reconnect = page.getByRole('link', { name: 'Open desktop app', exact: true });
        await reconnect.scrollIntoViewIfNeeded();
        await expect(reconnect).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        localLocked = false;
        await page.getByRole('button', { name: 'Check connection', exact: true }).click();
        await expect(page.locator('.home-shell')).toBeVisible();
      }
      await writeFile(
        join(root, `workflow-${size.width}-measurements.json`),
        JSON.stringify(measurements, null, 2),
      );
    } finally {
      await context.close();
      await rm(owned, { recursive: true, force: true });
    }
  });
}
