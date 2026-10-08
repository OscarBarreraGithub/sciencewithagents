import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

test('Spawn a fresh manager in a reused folder, send an idea and remove it without touching the earlier manager', async ({
  page,
}, info) => {
  // A disposable real folder outside the demo host's private data directory.
  const folder = mkdtempSync(join(homedir(), 'swa-manager-fixture-'));
  const otherFolder = mkdtempSync(join(homedir(), 'swa-manager-other-'));
  const headers = { origin: new URL(info.project.use.baseURL as string).origin };
  const post = (url: string, data: unknown) => page.request.post(url, { headers, data });
  const managers: string[] = [];
  let releaseSelection = () => {};
  try {
    execFileSync('git', ['init', '--template=', '--initial-branch=main'], {
      cwd: folder,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Fixture',
      ],
      { cwd: folder, stdio: 'ignore' },
    );
    writeFileSync(join(folder, 'old-session.jsonl'), '{"text":"Do not import old conversation"}\n');
    const listing = await (
      await page.request.get(`/api/project-folders?query=${basename(folder)}&scope=children`)
    ).json();
    const folderId = listing.folders.find((f: { name: string }) => f.name === basename(folder)).id;
    const oldResponse = await post('/api/projects/connect-folder', {
      key: randomUUID(),
      folderId,
      provider: 'codex',
      name: `Earlier setup ${randomUUID().slice(0, 8)}`,
    });
    expect(oldResponse.ok()).toBe(true);
    const old = (await oldResponse.json()).project;
    managers.push(old.managerId);
    const oldDetail = await (await page.request.get(`/api/agents/${old.managerId}`)).json();

    let selectionGate = Promise.resolve();
    let selections = 0;
    const creations: { key: string; name: string }[] = [];
    await page.route('**/api/projects/connect-folder', async (route) => {
      const input = route.request().postDataJSON();
      const response = await route.fetch();
      if (input.selectOnly) {
        selections++;
        await selectionGate;
        return route.fulfill({ response });
      }
      creations.push(input);
      const created = (await response.json()).project;
      if (created && !managers.includes(created.managerId)) managers.push(created.managerId);
      if (creations.length === 1)
        return route.fulfill({ status: 503, json: { error: 'Project acknowledgement was lost.' } });
      return route.fulfill({ response });
    });

    await page.goto('/#/new');
    const nameField = page.getByLabel('Project name', { exact: true });
    const choose = async (path: string, expectedName: string, edit?: string) => {
      const before = selections;
      selectionGate = new Promise<void>((resolve) => (releaseSelection = resolve));
      if (before === 0) await page.getByRole('radio', { name: /Existing folder/ }).check();
      else await page.getByRole('button', { name: 'Choose another folder', exact: true }).click();
      const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
      await browser
        .getByRole('searchbox', { name: 'Search folders', exact: true })
        .fill(basename(path));
      await browser.getByRole('button', { name: basename(path), exact: true }).click();
      await browser.getByRole('button', { name: 'Use this folder' }).click();
      await expect.poll(() => selections).toBe(before + 1);
      // A metadata read cannot take ownership of a name typed or cleared while it waits.
      await expect(nameField).toBeEnabled();
      if (edit !== undefined) await nameField.fill(edit);
      releaseSelection();
      await expect(
        page.getByText(`Selected folder: ${basename(path)}`, { exact: true }),
      ).toBeVisible();
      await expect(nameField).toHaveValue(expectedName);
    };
    await choose(folder, basename(folder));
    await choose(otherFolder, basename(otherFolder));
    await choose(folder, 'An independent display name', 'An independent display name');
    await choose(otherFolder, '', '');
    await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeDisabled();
    await page.reload();
    await expect(nameField).toHaveValue('');
    const name = `New app ${info.project.name} ${randomUUID().slice(0, 8)}`;
    await choose(folder, name, name);
    await page.reload();
    await expect(nameField).toHaveValue(name);
    const settings = page.getByRole('group', { name: 'Manager', exact: true });
    await settings.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex');
    await expect(
      settings
        .getByRole('combobox', { name: 'Model', exact: true })
        .locator('option[value="demo"]'),
    ).toHaveCount(1);
    await settings.getByRole('combobox', { name: 'Model', exact: true }).selectOption('demo');
    await page.getByRole('button', { name: 'Spawn', exact: true }).click();
    const brief = page.getByRole('dialog', { name: 'Describe your project', exact: true });
    await expect(brief).toBeVisible();
    await brief.getByRole('button', { name: 'Retry project setup', exact: true }).click();
    await expect.poll(() => creations.length).toBe(2);
    expect(creations[0].name).toBe(name);
    expect(creations[1]).toEqual(creations[0]);
    await expect
      .poll(async () =>
        (await (await page.request.get('/api/snapshot')).json()).projects.some(
          (p: { name: string }) => p.name === name,
        ),
      )
      .toBe(true);
    const createdSnapshot = await (await page.request.get('/api/snapshot')).json();
    const id = createdSnapshot.projects.find((p: { name: string }) => p.name === name).managerId;
    managers.push(id);
    expect(id).not.toBe(old.managerId);
    const detail = await (await page.request.get(`/api/agents/${id}`)).json();
    expect(detail.agent.projectId).not.toBe(old.id);
    await expect
      .poll(async () => (await (await page.request.get(`/api/agents/${id}`)).json()).agent.model)
      .toBe('demo');
    expect(detail.agent.name).toBe(name);
    expect(detail.entries).toEqual([]);
    expect(detail.runs).toEqual([]);
    await brief
      .getByRole('textbox', { name: 'Project description', exact: true })
      .fill('Build a simple app for my observations. Start by discussing the idea.');
    await brief.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(brief).toHaveCount(0);
    await expect(
      page.locator('.message.assistant').filter({ hasText: 'Your message is saved' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Configure', exact: true }).click();
    await page.getByRole('button', { name: 'Remove manager', exact: true }).click();
    await expect(page.getByText('Remove this manager from Chats?', { exact: false })).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Confirm removal' });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../data/manager-creation-20261004/${info.project.name}-remove.png`,
    });
    await confirm.click();
    await expect(page).toHaveURL(/#\/chats$/);
    await page.reload();
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
    await expect(page.getByRole('link', { name: new RegExp(old.name) })).toBeVisible();
    const saved = await (await page.request.get(`/api/agents/${id}`)).json();
    expect(saved.agent.archivedAt).toBeTruthy();
    expect(saved.entries.some((e: { text: string }) => e.text.includes('Build a simple app'))).toBe(
      true,
    );
    expect(await (await page.request.get(`/api/agents/${old.managerId}`)).json()).toEqual(
      oldDetail,
    );
    expect(readFileSync(join(folder, 'old-session.jsonl'), 'utf8')).toContain('Do not import');
    await page.goto(`/#/chat/${id}`);
    await expect(
      page.getByRole('status').filter({ hasText: 'Archived conversation.' }),
    ).toBeVisible();
    await expect(
      page.getByText('Build a simple app for my observations. Start by discussing the idea.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: `Message ${name}`, exact: true })).toHaveCount(
      0,
    );
  } finally {
    releaseSelection();
    await page.unrouteAll({ behavior: 'wait' });
    for (const id of managers)
      await post(`/api/agents/${id}/remove`, { key: randomUUID() }).catch(() => {});
    rmSync(folder, { recursive: true, force: true });
    rmSync(otherFolder, { recursive: true, force: true });
  }
});

test('Starting a different setup clears a pending or created project before editing and spawning', async ({
  page,
}, info) => {
  const folder = mkdtempSync(join(homedir(), 'swa-manager-reset-'));
  const headers = { origin: new URL(info.project.use.baseURL as string).origin };
  const post = (url: string, data: unknown) => page.request.post(url, { headers, data });
  const managers: string[] = [];
  const creations: { key: string; name: string; projectId: string }[] = [];
  try {
    const listing = await (
      await page.request.get(`/api/project-folders?query=${basename(folder)}&scope=children`)
    ).json();
    const folderId = listing.folders.find((f: { name: string }) => f.name === basename(folder)).id;
    const folderKey = randomUUID();
    const selection = (
      await (
        await post('/api/projects/connect-folder', { key: folderKey, folderId, selectOnly: true })
      ).json()
    ).selection;
    const oldResponse = await post('/api/projects', {
      key: randomUUID(),
      provider: 'codex',
      name: `Previous reset fixture ${randomUUID().slice(0, 8)}`,
    });
    expect(oldResponse.ok()).toBe(true);
    const old = await oldResponse.json();
    managers.push(old.managerId);
    await page.route('**/api/projects', async (route) => {
      const input = route.request().postDataJSON();
      const response = await route.fetch();
      const created = await response.json();
      managers.push(created.managerId);
      creations.push({ key: input.key, name: input.name, projectId: created.id });
      await route.fulfill({ response });
    });
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto('/#/new');
    const nameField = page.getByLabel('Project name', { exact: true });
    await expect(nameField).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) => key.endsWith(':project-spawn')),
        ),
      )
      .toBe(true);
    const setup = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(':project-spawn'));
      if (!key) throw new Error('The project setup draft was not saved.');
      return { key, spawn: JSON.parse(localStorage.getItem(key)!) };
    });
    for (const state of ['created', 'pending'] as const) {
      const previousKey = randomUUID();
      await page.evaluate(
        ({ setup, previousKey, selection, old, state }) => {
          localStorage.setItem(
            setup.key,
            JSON.stringify({
              ...setup.spawn,
              createKey: previousKey,
              folderKey: selection.key,
              name: old.name,
              nameEdited: true,
              folder: 'connect',
              selection,
              connectionPending: true,
              connectionName: old.name,
              ...(state === 'created'
                ? {
                    project: { id: old.id, managerId: old.managerId, existing: false },
                    setupReady: true,
                    workflowSaved: true,
                  }
                : {}),
            }),
          );
          sessionStorage.removeItem(`${setup.key}:brief-open`);
        },
        { setup, previousKey, selection, old, state },
      );
      await page.reload();
      await expect(nameField).toBeDisabled();
      await page.getByRole('button', { name: 'Start a different setup', exact: true }).click();
      await expect(nameField).toBeEnabled();
      await expect(nameField).toHaveValue('New project');
      await expect(page.getByRole('radio', { name: /New folder/ })).toBeChecked();
      if (state === 'created') await nameField.fill(`Independent reset ${info.project.name}`);
      await expect(nameField).toBeEnabled();
      const expectedName = await nameField.inputValue();
      const fresh = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), setup.key);
      expect(fresh.createKey).not.toBe(previousKey);
      expect(fresh.folderKey).not.toBe(selection.key);
      expect(fresh.project).toBeUndefined();
      expect(fresh.selection).toBeUndefined();
      expect(fresh.connectionPending).toBeUndefined();
      expect(fresh.connectionName).toBeUndefined();
      await expect(
        page.getByRole('button', { name: 'Start a different setup', exact: true }),
      ).toHaveCount(0);
      const settings = page.getByRole('group', { name: 'Manager', exact: true });
      await settings.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex');
      await settings.getByRole('combobox', { name: 'Model', exact: true }).selectOption('demo');
      const request = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        setup.key,
      );
      expect(request.createKey).not.toBe(previousKey);
      const before = creations.length;
      await page.getByRole('button', { name: 'Spawn', exact: true }).click();
      const brief = page.getByRole('dialog', { name: 'Describe your project', exact: true });
      await expect(brief).toBeVisible();
      await expect.poll(() => creations.length).toBe(before + 1);
      expect(creations[before]).toEqual({
        key: request.createKey,
        name: expectedName,
        projectId: expect.not.stringMatching(`^${old.id}$`),
      });
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/agents/${managers.at(-1)}`)).json()).agent
              .projectId,
        )
        .toBe(creations[before].projectId);
      await expect
        .poll(() =>
          page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).setupReady, setup.key),
        )
        .toBe(true);
    }
    expect(creations).toHaveLength(2);
    expect(creations[0].projectId).not.toBe(creations[1].projectId);
    const retained = await (await page.request.get(`/api/agents/${old.managerId}`)).json();
    expect(retained.entries).toEqual([]);
    expect(retained.runs).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    for (const id of managers)
      await post(`/api/agents/${id}/remove`, { key: randomUUID() }).catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  }
});
