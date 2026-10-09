import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  nativeRunnerStartSchema,
  type NativeRunnerLaunchOptions,
  type NativeRunnerStart,
  type NativeRunnerStartReceipt,
} from '@dock/shared';

function options(): NativeRunnerLaunchOptions {
  return {
    sources: [
      {
        id: randomUUID(),
        label: 'Local native terminal',
        available: true,
        message: 'Local tmux is available.',
      },
    ],
    providers: [
      {
        provider: 'codex',
        installed: true,
        version: 'fixture',
        message: 'Codex native executable available.',
      },
      {
        provider: 'claude',
        installed: false,
        version: '',
        message: 'Claude optional executable is not installed.',
      },
    ],
    starts: [],
  };
}
function receipt(
  input: NativeRunnerStart,
  state: NativeRunnerStartReceipt['state'],
): NativeRunnerStartReceipt {
  return {
    ...input,
    state,
    folderName: 'Selected analysis',
    targetId: state === 'created' ? randomUUID() : undefined,
    resolution: {
      provider: input.provider,
      mode: input.choice.mode,
      model:
        input.choice.mode === 'exact'
          ? input.choice.model
          : input.choice.mode === 'policy'
            ? 'central-default'
            : null,
      effort:
        input.choice.mode === 'exact'
          ? (input.choice.effort ?? null)
          : input.choice.mode === 'policy'
            ? 'high'
            : null,
      policyRevision: 7,
    },
    message:
      state === 'created'
        ? 'Native session created. Connect explicitly to inspect its native state.'
        : state === 'not_started'
          ? 'The native executable became unavailable before dispatch. Nothing was started.'
          : 'Native creation remains uncertain; do not replay the original start.',
    createdAt: new Date().toISOString(),
  };
}
async function folders(page: Page) {
  const home = randomUUID();
  const selected = randomUUID();
  await page.route('**/api/project-folders?*', (route) => {
    const id = new URL(route.request().url()).searchParams.get('folderId');
    expect(id === null || id === home || id === selected).toBe(true);
    return route.fulfill({
      json: {
        current: {
          id: id === selected ? selected : home,
          name: id === selected ? 'Selected analysis' : 'Home',
          canSelect: id === selected,
        },
        parentId: id === selected ? home : null,
        folders: id === selected ? [] : [{ id: selected, name: 'Selected analysis' }],
        nextOffset: null,
        breadcrumbs: [],
        locations: [],
        search: null,
      },
    });
  });
  return selected;
}
async function choose(page: Page) {
  await page.getByRole('button', { name: 'Choose native work folder', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Choose a project folder' });
  await browser.getByRole('button', { name: 'Selected analysis', exact: true }).click();
  await browser.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.locator('.native-runner-start')).toContainText(
    'Chosen folder: Selected analysis',
  );
}
async function readable(page: Page) {
  const values = await page
    .locator(
      '.native-runner-start p, .native-runner-start label, .native-runner-start button, .native-runner-start select, .native-runner-start a, .native-runner-start summary, .native-runner-start pre',
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .map((element) => ({
          font: parseFloat(getComputedStyle(element).fontSize),
          height: element.getBoundingClientRect().height,
          control: element.matches('button,select,a,summary'),
        })),
    );
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value.font).toBeGreaterThanOrEqual(16);
    if (value.control) expect(value.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const original of await page.locator('.native-runner-original').all())
    expect(
      await original.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
}
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test('New native folder start preserves choices through Back and its exact lost reply through reload, missing and uncertain reads without replay or implicit attach', async ({
  page,
}, info) => {
  const view = options();
  const folderId = await folders(page);
  const starts: NativeRunnerStart[] = [];
  let saved!: NativeRunnerStartReceipt;
  let reads = 0;
  let catalogs = 0;
  const attachments: Record<string, unknown>[] = [];
  await page.route('**/api/models?*', (route) => {
    catalogs++;
    return route.fulfill({
      status: 503,
      json: { error: 'No model discovery is needed for native defaults.' },
    });
  });
  await page.route('**/api/native-connections/launch-options', (route) =>
    route.fulfill({ json: view }),
  );
  await page.route('**/api/native-connections/start', (route) => {
    const input = nativeRunnerStartSchema.parse(route.request().postDataJSON());
    starts.push(input);
    saved = receipt(input, 'created');
    view.starts = [saved];
    return route.abort('failed');
  });
  await page.route('**/api/native-connections/starts/*', (route) => {
    reads++;
    expect(new URL(route.request().url()).pathname.split('/').at(-1)).toBe(saved.key);
    if (reads === 1)
      return route.fulfill({
        status: 404,
        json: { error: 'Original receipt is currently unavailable.' },
      });
    if (reads === 2)
      return route.fulfill({
        json: {
          ...saved,
          state: 'uncertain',
          targetId: undefined,
          message: 'Native creation remains uncertain.',
        },
      });
    return route.fulfill({ json: saved });
  });
  await page.route('**/api/native-connections', (route) =>
    route.fulfill({
      json: {
        sources: [
          {
            id: view.sources[0]!.id,
            label: 'Local native terminal',
            kind: 'tmux',
            location: 'local',
            state: 'available',
            message: 'Native source available.',
          },
        ],
        targets: saved
          ? [
              {
                id: saved.targetId,
                sourceId: view.sources[0]!.id,
                label: 'Created native session',
                kind: 'tmux',
                nativeStatus: 'unknown',
                canObserve: true,
                canControl: true,
                controlPolicy: 'shared',
                controller: 'unknown',
              },
            ]
          : [],
        attachments: [],
        observedAt: new Date().toISOString(),
      },
    }),
  );
  await page.route('**/api/native-connections/attach', (route) => {
    const input = route.request().postDataJSON();
    attachments.push(input);
    return route.fulfill({
      json: {
        id: randomUUID(),
        targetId: input.targetId,
        mode: input.mode,
        status: 'connecting',
        message: 'Observer attachment reserved.',
      },
    });
  });
  await page.route('**/api/native-connections/attachments/*', (route) =>
    route.fulfill({
      json: {
        id: new URL(route.request().url()).pathname.split('/').at(-1),
        targetId: saved.targetId,
        mode: 'observe',
        status: 'connecting',
        message: 'Observer attachment reserved.',
      },
    }),
  );
  await page.routeWebSocket('**/api/native-connections/attachments/*/socket', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }));
  });
  await page.goto('/#/chats');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('group', { name: 'Start new' })
    .getByRole('link', { name: /Start native in a folder/ })
    .click();
  await choose(page);
  await expect(page.getByLabel('Model choice')).toHaveValue('native');
  await page.getByRole('link', { name: 'Back to Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page
    .getByRole('group', { name: 'Start new' })
    .getByRole('link', { name: /Start native in a folder/ })
    .click();
  await expect(page.locator('.native-runner-start')).toContainText(
    'Chosen folder: Selected analysis',
  );
  await readable(page);
  await page.screenshot({
    path: `../../data/native-folder-ui/${info.project.name}-native-start.png`,
  });
  expect(starts).toEqual([]);
  expect(attachments).toEqual([]);
  expect(catalogs).toBe(0);
  await page.getByRole('button', { name: 'Start native session', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Unconfirmed native start' })).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    folderId,
    sourceId: view.sources[0]!.id,
    provider: 'codex',
    choice: { mode: 'native' },
  });
  expect(Object.keys(starts[0]!).sort()).toEqual([
    'choice',
    'folderId',
    'key',
    'provider',
    'sourceId',
  ]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(reads).toBe(0);
  expect(attachments).toEqual([]);
  await page.getByRole('button', { name: 'Check saved start receipt' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'missing receipt does not prove another start is safe',
  );
  await page.getByRole('button', { name: 'Check saved start receipt' }).click();
  await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
    'Creation uncertain',
  );
  await expect(page.getByRole('button', { name: 'Start native session', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Check saved start receipt' }).click();
  const result = page.getByRole('region', { name: 'Native start receipt' });
  await expect(result).toContainText('Native session created');
  await expect(result).toContainText(
    'not a sign-in, agent-turn or current-running acknowledgement',
  );
  expect(starts).toHaveLength(1);
  expect(reads).toBe(3);
  expect(attachments).toEqual([]);
  expect(catalogs).toBe(0);
  await page.getByRole('button', { name: 'Connect created session' }).click();
  const picker = page.getByRole('dialog', { name: 'Connect a native session' });
  await expect(picker).toContainText('Created native session');
  await picker.getByRole('button', { name: 'Observe', exact: true }).click();
  await expect(page.locator('.native-connection-pane')).toContainText('Observing');
  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({ targetId: saved.targetId, mode: 'observe' });
  await expect(page.getByRole('button', { name: 'Send and save prompt' })).toHaveCount(0);
  expect(starts).toHaveLength(1);
});

test('first-run native folder setup remains readable with no optional local source or provider and does not install or start anything', async ({
  page,
}) => {
  const view = options();
  view.sources = [];
  view.providers = view.providers.map((item) => ({
    ...item,
    installed: false,
    version: '',
    message: `${item.provider} optional executable not installed.`,
  }));
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  await page.route('**/api/snapshot', (route) =>
    route.fulfill({ json: { ...snapshot, projects: [], agents: [], tasks: [] } }),
  );
  await page.route('**/api/setup', (route) =>
    route.fulfill({ status: 503, json: { error: 'No local providers configured.' } }),
  );
  await page.route('**/api/setup/check', (route) =>
    route.fulfill({ status: 503, json: { error: 'No local providers configured.' } }),
  );
  await folders(page);
  let calls = 0,
    catalogs = 0;
  await page.route('**/api/native-connections/start', (route) => {
    calls++;
    return route.abort();
  });
  await page.route('**/api/models?*', (route) => {
    catalogs++;
    return route.abort();
  });
  await page.route('**/api/native-connections/launch-options', (route) =>
    route.fulfill({ json: view }),
  );
  await page.goto('/#/welcome');
  await page.getByRole('link', { name: 'Start native in a folder', exact: true }).click();
  await expect(page.locator('.native-runner-start')).toContainText(
    'No configured local tmux source',
  );
  await choose(page);
  await expect(
    page.getByRole('button', { name: 'Start native session', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.native-runner-start')).toContainText(
    'codex optional executable not installed',
  );
  await readable(page);
  expect(calls).toBe(0);
  expect(catalogs).toBe(0);
  await expect(page.getByRole('link', { name: 'Managed project setup (Advanced)' })).toBeVisible();
});

test('native start refuses browser-save and known preflight failures without losing exact light-model choices, then retains not-started and central-policy receipts', async ({
  page,
}) => {
  const view = options();
  await folders(page);
  await page.route('**/api/native-connections/launch-options', (route) =>
    route.fulfill({ json: view }),
  );
  await page.route('**/api/models?provider=codex', (route) =>
    route.fulfill({
      json: [
        {
          id: 'light-native',
          label: 'Light native model',
          isDefault: true,
          efforts: ['low', 'medium'],
        },
      ],
    }),
  );
  const starts: NativeRunnerStart[] = [];
  await page.route('**/api/native-connections/start', (route) => {
    const input = nativeRunnerStartSchema.parse(route.request().postDataJSON());
    starts.push(input);
    if (starts.length === 1)
      return route.fulfill({
        status: 409,
        json: { error: 'The issued folder is unavailable before native creation.' },
      });
    return route.fulfill({ json: receipt(input, 'not_started') });
  });
  await page.goto('/#/new/native');
  await choose(page);
  await page.getByLabel('Model choice').selectOption('exact');
  await page.getByLabel('Exact native model', { exact: true }).selectOption('light-native');
  await page.getByLabel('Thinking level').selectOption('low');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let blocked = true;
    Storage.prototype.setItem = function (key, value) {
      if (blocked && key.endsWith(':native-runner-start:pending'))
        throw new DOMException('Browser start storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    Object.defineProperty(window, 'allowNativeStartSave', {
      value: () => {
        blocked = false;
      },
    });
  });
  const start = page.getByRole('button', { name: 'Start native session', exact: true });
  await start.click();
  await expect(page.getByRole('alert')).toContainText(
    'No creation request was handed to the native program',
  );
  expect(starts).toEqual([]);
  await page.evaluate(() =>
    (window as unknown as { allowNativeStartSave: () => void }).allowNativeStartSave(),
  );
  await start.click();
  await expect(page.getByRole('alert')).toContainText('issued folder is unavailable');
  await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toHaveCount(0);
  await expect(page.getByLabel('Exact native model', { exact: true })).toHaveValue('light-native');
  await expect(page.getByLabel('Thinking level')).toHaveValue('low');
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
    'Not started',
  );
  expect(starts).toHaveLength(2);
  expect(starts[0]!.key).not.toBe(starts[1]!.key);
  expect(starts[1]!.choice).toEqual({ mode: 'exact', model: 'light-native', effort: 'low' });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
    'Not started',
  );
  expect(starts).toHaveLength(2);
  await page.getByRole('button', { name: 'Prepare another native session' }).click();
  await page.getByLabel('Model choice').selectOption('policy');
  await start.click();
  await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
    'central-default',
  );
  expect(starts).toHaveLength(3);
  expect(starts[2]!.choice).toEqual({ mode: 'policy' });
  expect(starts[2]!.key).not.toBe(starts[1]!.key);
});

for (const ending of ['uncertain', 'missing'] as const) {
  test(`persistent ${ending} start can be explicitly set aside without losing its original or replaying it`, async ({
    page,
  }, info) => {
    const view = options();
    const folderId = await folders(page);
    const starts: NativeRunnerStart[] = [];
    const reads: string[] = [];
    let attaches = 0;
    let discovery = 0;
    await page.route('**/api/native-connections/launch-options', (route) =>
      route.fulfill({ json: view }),
    );
    await page.route('**/api/native-connections/start', (route) => {
      const input = nativeRunnerStartSchema.parse(route.request().postDataJSON());
      starts.push(input);
      if (starts.length > 1) return route.fulfill({ json: receipt(input, 'created') });
      return ending === 'uncertain'
        ? route.fulfill({ json: receipt(input, 'uncertain') })
        : route.abort('failed');
    });
    await page.route('**/api/native-connections/starts/*', (route) => {
      const key = new URL(route.request().url()).pathname.split('/').at(-1)!;
      reads.push(key);
      expect(key).toBe(starts[0]!.key);
      return ending === 'uncertain'
        ? route.fulfill({ json: receipt(starts[0]!, 'uncertain') })
        : route.fulfill({ status: 404, json: { error: 'No retained original receipt.' } });
    });
    await page.route('**/api/native-connections', (route) => {
      discovery++;
      return route.fulfill({
        json: {
          sources: [
            {
              id: view.sources[0]!.id,
              label: 'Local native terminal',
              kind: 'tmux',
              location: 'local',
              state: 'available',
              message: 'Native source available.',
            },
          ],
          targets: ['Possible original session', 'Another ordinary native session'].map(
            (label) => ({
              id: randomUUID(),
              sourceId: view.sources[0]!.id,
              label,
              kind: 'tmux',
              nativeStatus: 'unknown',
              canObserve: true,
              canControl: true,
              controlPolicy: 'shared',
              controller: 'unknown',
            }),
          ),
          attachments: [],
          observedAt: new Date().toISOString(),
        },
      });
    });
    await page.route('**/api/native-connections/attach', (route) => {
      attaches++;
      return route.abort();
    });
    await page.goto('/#/new/native');
    await choose(page);
    await page.getByRole('button', { name: 'Start native session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Set aside unconfirmed start' })).toHaveCount(0);
    expect(starts).toHaveLength(1);
    expect(reads).toEqual([]);
    await page.getByRole('button', { name: 'Check saved start receipt' }).click();
    const aside = page.getByRole('button', { name: 'Set aside unconfirmed start' });
    await expect(aside).toBeDisabled();
    await page.reload();
    await expect(aside).toBeDisabled();
    expect(starts).toHaveLength(1);
    expect(reads).toEqual([starts[0]!.key]);
    expect(discovery).toBe(0);
    await page.getByRole('button', { name: 'Inspect native connections' }).click();
    const picker = page.getByRole('dialog', { name: 'Connect a native session' });
    await expect(picker).toContainText('Possible original session');
    await expect(picker).toContainText('Another ordinary native session');
    expect(attaches).toBe(0);
    expect(starts).toHaveLength(1);
    await picker.getByRole('button', { name: 'Close dialog' }).click();
    await page
      .getByRole('checkbox', {
        name: 'I understand the original may have created a session and is not cancelled or stopped.',
      })
      .check();
    await readable(page);
    const before = await page.evaluate(() =>
      Object.fromEntries(
        Object.entries(localStorage).filter(([key]) => key.includes(':native-runner-start:')),
      ),
    );
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      let blocked = true;
      Storage.prototype.setItem = function (key, value) {
        if (blocked && key.endsWith(':native-runner-start:set-aside'))
          throw new DOMException(
            'Cannot retain this original in browser storage.',
            'QuotaExceededError',
          );
        return original.call(this, key, value);
      };
      Object.defineProperty(window, 'allowSetAsideSave', {
        value: () => {
          blocked = false;
        },
      });
    });
    await aside.click();
    await expect(page.getByRole('alert')).toContainText('Cannot retain this original');
    expect(
      await page.evaluate(() =>
        Object.fromEntries(
          Object.entries(localStorage).filter(([key]) => key.includes(':native-runner-start:')),
        ),
      ),
    ).toEqual(before);
    await expect(
      page.getByRole('button', { name: 'Start native session', exact: true }),
    ).toHaveCount(0);
    expect(starts).toHaveLength(1);
    await page.evaluate(() =>
      (window as unknown as { allowSetAsideSave: () => void }).allowSetAsideSave(),
    );
    await aside.click();
    await expect(
      page.getByRole('button', { name: 'Start native session', exact: true }),
    ).toBeEnabled();
    const retained = page.getByRole('region', { name: 'Set-aside native starts' });
    await retained.locator('summary').click();
    await expect(retained).toContainText(starts[0]!.key);
    await expect(retained).toContainText(folderId);
    const saved = await page.evaluate(() => {
      const entry = Object.entries(localStorage).find(([key]) =>
        key.endsWith(':native-runner-start:set-aside'),
      )!;
      return { key: entry[0], raw: entry[1], items: JSON.parse(entry[1]) };
    });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].input).toEqual(starts[0]);
    expect(saved.items[0].outcome).toBe(ending);
    if (ending === 'uncertain')
      expect(saved.items[0].lastReceipt).toMatchObject({ ...starts[0], state: 'uncertain' });
    else expect(saved.items[0].lastReceipt).toBeNull();
    await readable(page);
    await page.screenshot({
      path: `../../data/native-folder-ui/${info.project.name}-${ending}-set-aside.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Start native session', exact: true }),
    ).toBeEnabled();
    expect(starts).toHaveLength(1);
    expect(reads).toHaveLength(1);
    expect(await page.evaluate((key) => localStorage.getItem(key), saved.key)).toBe(saved.raw);
    await retained.locator('summary').click();
    // A failed retained-check write does not erase the prior receipt or permit a new handoff.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      let blocked = true;
      Storage.prototype.setItem = function (key, value) {
        if (blocked && key.endsWith(':native-runner-start:set-aside'))
          throw new DOMException('Cannot update retained check.', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      Object.defineProperty(window, 'allowRetainedCheckSave', {
        value: () => {
          blocked = false;
        },
      });
    });
    await retained.getByRole('button', { name: 'Check original receipt' }).click();
    await expect(page.getByRole('alert')).toContainText('retained original has not been removed');
    expect(await page.evaluate((key) => localStorage.getItem(key), saved.key)).toBe(saved.raw);
    expect(starts).toHaveLength(1);
    await page.evaluate(() =>
      (window as unknown as { allowRetainedCheckSave: () => void }).allowRetainedCheckSave(),
    );
    await retained.getByRole('button', { name: 'Check original receipt' }).click();
    await expect(
      page.getByRole('button', { name: 'Start native session', exact: true }),
    ).toBeEnabled();
    expect(reads).toEqual([starts[0]!.key, starts[0]!.key, starts[0]!.key]);
    expect(attaches).toBe(0);
    // Only this separate explicit owner Start creates a fresh request identity.
    await page.getByRole('button', { name: 'Start native session', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
      'Native session created',
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]!.key).not.toBe(starts[0]!.key);
    expect(starts[1]).toMatchObject({
      folderId,
      sourceId: starts[0]!.sourceId,
      provider: starts[0]!.provider,
      choice: starts[0]!.choice,
    });
    await retained.getByRole('button', { name: 'Check original receipt' }).click();
    await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
      'Native session created',
    );
    await page.reload();
    await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
      'Native session created',
    );
    expect(starts).toHaveLength(2);
    expect(reads).toHaveLength(4);
    expect(attaches).toBe(0);
    const final = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), saved.key);
    expect(final[0].input).toEqual(starts[0]);
    expect(final[0].lastReceipt?.state ?? null).toBe(ending === 'uncertain' ? 'uncertain' : null);
  });
}

test('set-aside capacity and unreadable saved records hold the original without silently pruning', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Storage bound is independent of viewport; both normal recovery flows cover all four layouts.',
  );
  const view = options();
  await folders(page);
  let original!: NativeRunnerStart;
  let starts = 0;
  await page.route('**/api/native-connections/launch-options', (route) =>
    route.fulfill({ json: view }),
  );
  await page.route('**/api/native-connections/start', (route) => {
    starts++;
    original = nativeRunnerStartSchema.parse(route.request().postDataJSON());
    return route.abort('failed');
  });
  await page.route('**/api/native-connections/starts/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Original receipt missing.' } }),
  );
  await page.goto('/#/new/native');
  await choose(page);
  await page.getByRole('button', { name: 'Start native session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check saved start receipt' }).click();
  await expect(page.getByRole('button', { name: 'Set aside unconfirmed start' })).toBeDisabled();
  // A later receipt can be retained even when its check-marker update fails.
  const latest = receipt(original, 'uncertain');
  latest.message = 'Newest retained receipt, after the earlier missing check.';
  await page.route('**/api/native-connections/starts/*', (route) =>
    route.fulfill({ json: latest }),
  );
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let blocked = true;
    Storage.prototype.setItem = function (key, value) {
      if (blocked && key.endsWith(':native-runner-start:check'))
        throw new DOMException('Cannot update check marker.', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    Object.defineProperty(window, 'allowStartCheckMarker', {
      value: () => {
        blocked = false;
      },
    });
  });
  await page.getByRole('button', { name: 'Check saved start receipt' }).click();
  await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
    latest.message,
  );
  await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toBeEnabled();
  await page.evaluate(() =>
    (window as unknown as { allowStartCheckMarker: () => void }).allowStartCheckMarker(),
  );
  const state = await page.evaluate(() => {
    const [key, raw] = Object.entries(localStorage).find(([key]) =>
      key.endsWith(':native-runner-start:check'),
    )!;
    const checked = JSON.parse(raw);
    const retainedKey = key.replace(/:check$/, ':set-aside');
    const items = Array.from({ length: 32 }, () => ({
      ...checked,
      input: { ...checked.input, key: crypto.randomUUID() },
    }));
    const retainedRaw = JSON.stringify(items);
    localStorage.setItem(retainedKey, retainedRaw);
    return { key: retainedKey, raw: retainedRaw };
  });
  await page
    .getByRole('checkbox', {
      name: 'I understand the original may have created a session and is not cancelled or stopped.',
    })
    .check();
  await page.getByRole('button', { name: 'Set aside unconfirmed start' }).click();
  await expect(page.getByRole('alert')).toContainText('Set-aside storage is full');
  expect(await page.evaluate((key) => localStorage.getItem(key), state.key)).toBe(state.raw);
  await expect(page.getByRole('button', { name: 'Start native session', exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(
        Object.entries(localStorage).find(([key]) =>
          key.endsWith(':native-runner-start:pending'),
        )![1],
      ),
    ),
  ).toEqual(original);
  await page.evaluate((key) => localStorage.setItem(key, '{unreadable original record'), state.key);
  await page.getByRole('button', { name: 'Set aside unconfirmed start' }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), state.key)).toBe(
    '{unreadable original record',
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(
        Object.entries(localStorage).find(([key]) =>
          key.endsWith(':native-runner-start:pending'),
        )![1],
      ),
    ),
  ).toEqual(original);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('saved bytes have not been changed');
  await expect(page.getByRole('button', { name: 'Start native session', exact: true })).toHaveCount(
    0,
  );
  expect(starts).toBe(1);
  // Fixture supplies an empty valid retained store; normal explicit set-aside must copy the newest receipt.
  await page.evaluate((key) => localStorage.setItem(key, '[]'), state.key);
  await page
    .getByRole('checkbox', {
      name: 'I understand the original may have created a session and is not cancelled or stopped.',
    })
    .check();
  await page.getByRole('button', { name: 'Set aside unconfirmed start' }).click();
  await expect(
    page.getByRole('button', { name: 'Start native session', exact: true }),
  ).toBeEnabled();
  const retained = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), state.key);
  expect(retained[0].input).toEqual(original);
  expect(retained[0].lastReceipt).toEqual(latest);
  expect(starts).toBe(1);
});

test('an old tab missing check preserves the newer receipt saved by another tab', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Two-tab storage ordering is viewport-independent.');
  const view = options();
  await folders(page);
  const starts: NativeRunnerStart[] = [];
  let reads = 0;
  let held!: () => void;
  let reached!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    held = resolve;
  });
  let latest!: NativeRunnerStartReceipt;
  await context.route('**/api/native-connections/launch-options', (route) =>
    route.fulfill({ json: view }),
  );
  await context.route('**/api/native-connections/start', (route) => {
    const input = nativeRunnerStartSchema.parse(route.request().postDataJSON());
    starts.push(input);
    return route.fulfill({ json: receipt(input, 'uncertain') });
  });
  await context.route('**/api/native-connections/starts/*', async (route) => {
    expect(new URL(route.request().url()).pathname.split('/').at(-1)).toBe(starts[0]!.key);
    reads++;
    if (reads === 1) return route.fulfill({ json: receipt(starts[0]!, 'uncertain') });
    if (reads === 2) {
      reached();
      await release;
      return route.fulfill({ status: 404, json: { error: 'Original receipt currently missing.' } });
    }
    latest = receipt(starts[0]!, 'created');
    latest.message = 'Later creation receipt saved in the other tab.';
    return route.fulfill({ json: latest });
  });
  const other = await context.newPage();
  try {
    await page.goto('/#/new/native');
    await choose(page);
    await page.getByRole('button', { name: 'Start native session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toBeEnabled();
    await page.getByRole('button', { name: 'Check saved start receipt' }).click();
    await page
      .getByRole('checkbox', {
        name: 'I understand the original may have created a session and is not cancelled or stopped.',
      })
      .check();
    await page.getByRole('button', { name: 'Set aside unconfirmed start' }).click();
    const oldRecord = page.getByRole('region', { name: 'Set-aside native starts' });
    await oldRecord.locator('summary').click();
    await other.goto('/#/new/native');
    const newerRecord = other.getByRole('region', { name: 'Set-aside native starts' });
    await newerRecord.locator('summary').click();
    await oldRecord.getByRole('button', { name: 'Check original receipt' }).click();
    await heldRead;
    await newerRecord.getByRole('button', { name: 'Check original receipt' }).click();
    await expect(newerRecord).toContainText('Later creation receipt saved in the other tab.');
    held();
    await expect(oldRecord.locator('summary')).toContainText('Receipt missing');
    await expect(oldRecord).toContainText('Later creation receipt saved in the other tab.');
    const saved = await page.evaluate(() =>
      JSON.parse(
        Object.entries(localStorage).find(([key]) =>
          key.endsWith(':native-runner-start:set-aside'),
        )![1],
      ),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].input).toEqual(starts[0]);
    expect(saved[0].lastReceipt).toEqual(latest);
    expect(saved[0].outcome).toBe('missing');
    await page.reload();
    const reloaded = page.getByRole('region', { name: 'Set-aside native starts' });
    await reloaded.locator('summary').click();
    await expect(reloaded).toContainText(latest.message);
    expect(starts).toHaveLength(1);
    expect(reads).toBe(3);
  } finally {
    held();
    await other.close();
    await context.unrouteAll({ behavior: 'wait' });
  }
});

test('an unrelated later start receipt does not prevent an older tab recording its original missing check', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Two-tab storage ordering is viewport-independent.');
  const view = options();
  await folders(page);
  const starts: NativeRunnerStart[] = [];
  let reads = 0;
  let later!: NativeRunnerStartReceipt;
  await context.route('**/api/native-connections/launch-options', (route) =>
    route.fulfill({ json: view }),
  );
  await context.route('**/api/native-connections/start', (route) => {
    const input = nativeRunnerStartSchema.parse(route.request().postDataJSON());
    starts.push(input);
    if (starts.length === 1) return route.fulfill({ json: receipt(input, 'uncertain') });
    later = receipt(input, 'created');
    return route.fulfill({ json: later });
  });
  await context.route('**/api/native-connections/starts/*', (route) => {
    expect(new URL(route.request().url()).pathname.split('/').at(-1)).toBe(starts[0]!.key);
    reads++;
    return reads === 1
      ? route.fulfill({ json: receipt(starts[0]!, 'uncertain') })
      : route.fulfill({ status: 404, json: { error: 'Original receipt currently missing.' } });
  });
  const other = await context.newPage();
  try {
    await page.goto('/#/new/native');
    await choose(page);
    await page.getByRole('button', { name: 'Start native session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check saved start receipt' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Set aside unconfirmed start' })).toHaveCount(0);
    await other.goto('/#/new/native');
    await other.getByRole('button', { name: 'Check saved start receipt' }).click();
    await other
      .getByRole('checkbox', {
        name: 'I understand the original may have created a session and is not cancelled or stopped.',
      })
      .check();
    await other.getByRole('button', { name: 'Set aside unconfirmed start' }).click();
    await other.getByRole('button', { name: 'Start native session', exact: true }).click();
    await expect(other.getByRole('region', { name: 'Native start receipt' })).toContainText(
      'Native session created',
    );
    expect(starts[1]!.key).not.toBe(starts[0]!.key);
    await page.getByRole('button', { name: 'Check saved start receipt' }).click();
    await expect(page.getByRole('button', { name: 'Set aside unconfirmed start' })).toBeDisabled();
    const saved = await page.evaluate(() => {
      const entry = (suffix: string) =>
        JSON.parse(
          Object.entries(localStorage).find(([key]) =>
            key.endsWith(`:native-runner-start:${suffix}`),
          )![1],
        );
      return { check: entry('check'), result: entry('result'), retained: entry('set-aside') };
    });
    expect(saved.check.input).toEqual(starts[0]);
    expect(saved.check.outcome).toBe('missing');
    expect(saved.check.lastReceipt).toBeNull();
    expect(saved.result).toEqual(later);
    expect(saved.retained[0].input).toEqual(starts[0]);
    expect(saved.retained[0].lastReceipt.state).toBe('uncertain');
    await page.reload();
    await expect(page.getByRole('region', { name: 'Native start receipt' })).toContainText(
      'Native session created',
    );
    expect(starts).toHaveLength(2);
    expect(reads).toBe(2);
  } finally {
    await other.close();
    await context.unrouteAll({ behavior: 'wait' });
  }
});
