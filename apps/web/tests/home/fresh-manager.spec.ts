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
  const headers = { origin: new URL(info.project.use.baseURL as string).origin };
  const post = (url: string, data: unknown) => page.request.post(url, { headers, data });
  const managers: string[] = [];
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

    await page.goto('/#/new');
    await page.getByRole('radio', { name: /Existing folder/ }).check();
    const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
    await browser
      .getByRole('searchbox', { name: 'Search folders', exact: true })
      .fill(basename(folder));
    await browser.getByRole('button', { name: basename(folder), exact: true }).click();
    await browser.getByRole('button', { name: 'Use this folder' }).click();
    const name = `New app ${info.project.name} ${randomUUID().slice(0, 8)}`;
    await page.getByLabel('Project name', { exact: true }).fill(name);
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
    const id = new URL(page.url()).hash.split('/')[2]!;
    managers.push(id);
    expect(id).not.toBe(old.managerId);
    const detail = await (await page.request.get(`/api/agents/${id}`)).json();
    expect(detail.agent.projectId).not.toBe(old.id);
    expect(detail.agent).toMatchObject({ name: `${name} manager`, model: 'demo' });
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
    await expect(page.getByText('This manager was removed.', { exact: false })).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: `Message ${name} manager`, exact: true }),
    ).toHaveCount(0);
  } finally {
    for (const id of managers)
      await post(`/api/agents/${id}/remove`, { key: randomUUID() }).catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  }
});
