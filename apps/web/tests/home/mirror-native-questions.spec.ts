import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  mirrorPage,
  mirrorWindowSchema,
  snapshotSchema,
  type MirrorNativeRequest,
  type MirrorNativeRequestsView,
  type MirrorState,
} from '@dock/shared';

async function fixture(page: Page) {
  const threadId = randomUUID();
  const request: MirrorNativeRequest = {
    token: randomUUID(),
    requestId: 'fixture-question-1',
    threadId,
    turnId: randomUUID(),
    itemId: 'fixture-item-1',
    kind: 'question',
    title: 'Choose the retained fixture values',
    message: 'The native turn is waiting for your explicit answer.',
    observation: 'pending',
    response: 'answer',
    questions: [
      {
        id: 'values',
        header: 'Fixture values',
        question: 'Which values should the saved fixture use? 🧪 café 漢字',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'Retain values', description: 'Keep the values in the original fixture.' },
          {
            label: 'Use updated values',
            description: 'Use the revised values after explicit review.',
          },
        ],
      },
    ],
  };
  const state: MirrorState = {
    windowId: randomUUID(),
    provider: 'codex',
    threadId,
    title: 'Native question fixture',
    label: 'Disposable editor fixture',
    status: 'attention',
    message: '',
    canReadNativeRequests: true,
    nativeRequests: [request],
    nativeRequestCount: 1,
    nativeRequestsUnavailable: false,
    entries: [{ id: 'fixture-reply', role: 'assistant', text: 'A retained reply stays readable.' }],
  };
  const questionView = (): MirrorNativeRequestsView => ({
    windowId: state.windowId,
    provider: state.provider,
    threadId: state.threadId,
    status: state.status,
    message: state.message,
    nativeRequests: state.nativeRequests,
    nativeRequestCount: state.nativeRequestCount,
    nativeRequestsUnavailable: state.nativeRequestsUnavailable,
  });
  let listingFailure = false;
  let questionFailure = false;
  let questionsUnavailable = false;
  let unavailableCount = 0;
  let lostAnswer = false;
  let deliveryFailure = false;
  let holdHistory = false;
  let releaseHistory: (() => void) | undefined;
  let holdQuestions = false;
  let releaseQuestions: (() => void) | undefined;
  let heldQuestionReads = 0;
  const answers: unknown[] = [];
  const deliveries: string[] = [];
  const modelWrites: string[] = [];
  const snapshot = snapshotSchema.parse(await (await page.request.get('/api/snapshot')).json());
  snapshot.agents.forEach((agent) => {
    agent.status = 'idle';
  });
  snapshot.approvals = [];
  snapshot.tasks = [];
  snapshot.backups = [];
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/work-items', (route) => route.fulfill({ json: { items: [] } }));
  for (const endpoint of ['pulsar', 'local-jobs']) {
    const data = await (await page.request.get(`/api/${endpoint}`)).json();
    await page.route(`**/api/${endpoint}`, (route) =>
      route.fulfill({ json: { ...data, jobs: [] } }),
    );
  }
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    listingFailure
      ? route.fulfill({ status: 503, json: { error: 'Fixture listing unavailable.' } })
      : route.fulfill({
          json: [
            mirrorWindowSchema.parse(
              questionsUnavailable
                ? {
                    ...state,
                    nativeRequestCount: unavailableCount,
                    nativeRequestsUnavailable: true,
                  }
                : state,
            ),
          ],
        }),
  );
  await page.route(/\/api\/vscode\/windows\/[^/?]+(?:\?.*)?$/, async (route) => {
    if (holdHistory)
      await new Promise<void>((resolve) => {
        releaseHistory = resolve;
      });
    return route.fulfill({ json: mirrorPage(state) });
  });
  await page.route(/\/api\/vscode\/windows\/[^/?]+\/questions$/, async (route) => {
    if (holdQuestions) {
      heldQuestionReads++;
      await new Promise<void>((resolve) => {
        releaseQuestions = resolve;
      });
    }
    return questionFailure
      ? route.fulfill({
          status: 503,
          json: { error: 'Fixture native request reading unavailable.' },
        })
      : route.fulfill({
          json: questionsUnavailable
            ? {
                ...questionView(),
                nativeRequests: [],
                nativeRequestCount: unavailableCount,
                nativeRequestsUnavailable: true,
              }
            : questionView(),
        });
  });
  await page.route(/\/api\/vscode\/windows\/[^/?]+\/questions\/answer$/, (route) => {
    answers.push(route.request().postDataJSON());
    return lostAnswer
      ? route.abort()
      : route.fulfill({
          json: {
            state: 'uncertain',
            message: 'Native acceptance is not confirmed. Inspect the original request in VS Code.',
          },
        });
  });
  await page.route('**/api/vscode/deliveries/*', (route) => {
    deliveries.push(route.request().url());
    return deliveryFailure
      ? route.fulfill({ status: 503, json: { error: 'Fixture receipt reading unavailable.' } })
      : route.fulfill({
          json: {
            state: 'uncertain',
            message:
              'The original native answer receipt remains unconfirmed. Nothing was repeated.',
          },
        });
  });
  page.on('request', (item) => {
    if (
      item.method() !== 'GET' &&
      /\/(messages|resume|send|control|goal)(?:\/|$)/.test(new URL(item.url()).pathname)
    )
      modelWrites.push(item.url());
  });
  return {
    state,
    request,
    answers,
    deliveries,
    modelWrites,
    href: `#/chats/vscode/${encodeURIComponent(`codex:${threadId}`)}`,
    failListing: (value: boolean) => {
      listingFailure = value;
    },
    failQuestions: (value: boolean) => {
      questionFailure = value;
    },
    unavailableQuestions: (value: boolean, count = 0) => {
      questionsUnavailable = value;
      unavailableCount = count;
    },
    loseAnswer: () => {
      lostAnswer = true;
    },
    failDelivery: (value: boolean) => {
      deliveryFailure = value;
    },
    holdQuestions: () => {
      holdQuestions = true;
    },
    heldQuestionReads: () => heldQuestionReads,
    releaseQuestions: () => {
      holdQuestions = false;
      releaseQuestions?.();
    },
    holdHistory: () => {
      holdHistory = true;
    },
    releaseHistory: () => {
      holdHistory = false;
      releaseHistory?.();
    },
  };
}
const native = (page: Page) => page.getByRole('region', { name: 'Native requests', exact: true });
const form = (page: Page) => page.getByRole('dialog', { name: 'Native request', exact: true });
async function screen(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: `../../data/screenshots/editor-prompts/${test.info().project.name}-${name}.png`,
  });
}

test('fresh native question appears from Home and stays answerable while transcript read is held', async ({
  page,
}) => {
  const data = await fixture(page);
  data.holdHistory();
  await page.goto('/#/home');
  const attention = page.getByRole('region', { name: 'For your attention', exact: true });
  await attention
    .getByRole('button', { name: '1 request for Computer and other requests', exact: true })
    .click();
  const link = attention.getByRole('link', { name: /1 native request needs your input/ });
  await expect(link).toHaveAttribute('href', data.href);
  await screen(page, 'home');
  await link.click();
  await expect(page.locator('.mirror-header')).toContainText('Waiting for your input');
  await expect(native(page)).toContainText(data.request.questions[0]!.question);
  await native(page).getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(form(page).getByRole('radio', { name: /Retain values/ })).toBeVisible();
  await form(page)
    .getByRole('radio', { name: /Retain values/ })
    .check();
  const choice = form(page).locator('.mirror-native-choice').first();
  expect(await choice.evaluate((element) => getComputedStyle(element).flexDirection)).toBe('row');
  expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const radio = (await choice.locator('input').boundingBox())!;
  const wording = (await choice.locator('span').boundingBox())!;
  expect(wording.x).toBeGreaterThanOrEqual(radio.x + radio.width);
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toBeEnabled();
  await screen(page, 'question');
  const cached = await page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith('dock:mirror-chats:'))
      .map((key) => sessionStorage.getItem(key))
      .join(''),
  );
  expect(cached).not.toContain(data.request.questions[0]!.question);
  expect(cached).not.toContain('Retain values');
  expect(cached).not.toContain(data.request.token);
  expect(data.answers).toEqual([]);
  expect(data.modelWrites).toEqual([]);
  data.releaseHistory();
  await form(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByText('A retained reply stays readable.', { exact: true })).toBeVisible();
});

test('lost answer reply retains key-only receipt through reload and disappearance without repeating input or losing composer draft', async ({
  page,
}) => {
  const data = await fixture(page);
  data.loseAnswer();
  await page.goto(`/${data.href}`);
  const draft = 'Separate unsent composer draft 🧪 café 漢字';
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await composer.fill(draft);
  await native(page).getByRole('button', { name: 'Review request', exact: true }).click();
  const answer = 'Exact custom fixture answer 🧪 café 漢字';
  await form(page)
    .getByRole('textbox', { name: 'Fixture values — your answer', exact: true })
    .fill(answer);
  await form(page).getByRole('button', { name: 'Send native answer', exact: true }).click();
  await expect(form(page)).toContainText('Answer delivery is not confirmed');
  expect(data.answers).toHaveLength(1);
  const submitted = data.answers[0] as Record<string, unknown>;
  expect(submitted).toMatchObject({
    provider: 'codex',
    token: data.request.token,
    threadId: data.state.threadId,
    turnId: data.request.turnId,
    answers: { values: [answer] },
  });
  const receipt = await page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith('dock:mirror-question-receipts:'))
      .map((key) => sessionStorage.getItem(key))
      .join(''),
  );
  expect(receipt).not.toContain(answer);
  expect(receipt).not.toContain(data.request.questions[0]!.question);
  expect(JSON.parse(receipt)).toEqual([
    {
      key: submitted.key,
      token: data.request.token,
      threadId: data.state.threadId,
      turnId: data.request.turnId,
    },
  ]);
  data.state.nativeRequests = [];
  data.state.nativeRequestCount = 0;
  data.state.status = 'idle';
  await page.reload();
  await expect(composer).toHaveValue(draft);
  await expect(native(page)).toContainText('1 native answer receipt to check');
  await expect(
    native(page).getByRole('button', { name: 'Review request', exact: true }),
  ).toHaveCount(0);
  await native(page).locator('.mirror-native-receipts summary').click();
  data.failDelivery(true);
  await native(page).getByRole('button', { name: 'Check answer status', exact: true }).click();
  await expect(native(page)).toContainText('The original receipt is retained');
  data.failDelivery(false);
  await native(page).getByRole('button', { name: 'Check answer status', exact: true }).click();
  await expect(native(page)).toContainText('Nothing was repeated');
  expect(data.answers).toHaveLength(1);
  expect(data.deliveries.every((url) => url.endsWith(`/deliveries/${submitted.key}`))).toBe(true);
  expect(data.modelWrites).toEqual([]);
  await screen(page, 'receipt');
});

test('request read failure and offline reconnect disable last-observed question until fresh exact pending evidence', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(`/${data.href}`);
  await native(page).getByRole('button', { name: 'Review request', exact: true }).click();
  await form(page)
    .getByRole('radio', { name: /Retain values/ })
    .check();
  data.failQuestions(true);
  await expect(form(page)).toContainText('This is the last observed request');
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toBeDisabled();
  await form(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(native(page)).toContainText('Native requests could not be refreshed');
  data.failQuestions(false);
  await native(page).getByRole('button', { name: 'Retry native requests', exact: true }).click();
  await expect(native(page)).toContainText('1 native request needs your input');
  data.failListing(true);
  await expect(page.locator('.mirror-header')).toContainText('Offline');
  await native(page).getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toBeDisabled();
  await form(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  data.holdQuestions();
  data.failListing(false);
  await expect.poll(data.heldQuestionReads).toBeGreaterThan(0);
  await native(page).getByRole('button', { name: 'Review request', exact: true }).click();
  await expect(form(page)).toContainText('This is the last observed request');
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toBeDisabled();
  data.releaseQuestions();
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toBeEnabled();
  await form(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  data.state.windowId = randomUUID();
  data.state.nativeRequests = [];
  data.state.nativeRequestCount = 0;
  data.state.status = 'idle';
  data.failListing(false);
  await expect(native(page)).toHaveCount(0);
  expect(data.answers).toEqual([]);
  expect(data.modelWrites).toEqual([]);
});

test('successful unavailable reading retains only disabled last observation and fresh empty clears it without Home attention', async ({
  page,
}) => {
  const data = await fixture(page);
  await page.goto(`/${data.href}`);
  await native(page).getByRole('button', { name: 'Review request', exact: true }).click();
  await form(page)
    .getByRole('radio', { name: /Retain values/ })
    .check();
  data.unavailableQuestions(true);
  await expect(form(page)).toContainText('This is the last observed request');
  await expect(form(page)).toContainText(data.request.questions[0]!.question);
  await expect(form(page).getByRole('radio', { name: /Retain values/ })).toBeDisabled();
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.mirror-header')).not.toContainText('Waiting for your input');
  await form(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(native(page)).toContainText(
    'Last observed native request — confirmation unavailable',
  );
  data.state.nativeRequests = [];
  data.state.nativeRequestCount = 0;
  data.state.status = 'idle';
  data.unavailableQuestions(false);
  await expect(native(page)).toHaveCount(0);
  data.unavailableQuestions(true, 1);
  await page.goto('/#/home');
  const attention = page.getByRole('region', { name: 'For your attention', exact: true });
  await expect(attention.locator('.overview-panel-head .overview-count')).toHaveText('0');
  await expect(attention.getByRole('button', { name: /1 request for Computer/ })).toHaveCount(0);
  await expect(
    attention.getByRole('link', { name: /native request needs your input/ }),
  ).toHaveCount(0);
  expect(data.answers).toEqual([]);
  expect(data.modelWrites).toEqual([]);
});

test('older connections and native-only permissions or secret questions remain explicit without app answer controls', async ({
  page,
}) => {
  const data = await fixture(page);
  data.state.nativeRequests = undefined;
  data.state.nativeRequestCount = undefined;
  data.state.status = 'busy';
  await page.goto(`/${data.href}`);
  await expect(native(page)).toContainText('not supported by this connection');
  await native(page).locator('.mirror-native-support summary').click();
  await expect(native(page)).toContainText('An older companion may need an update');
  await expect(
    native(page).getByRole('link', { name: 'VS Code connection help', exact: true }),
  ).toHaveAttribute('href', '#/vscode');
  const permission = {
    ...data.request,
    token: randomUUID(),
    kind: 'approval' as const,
    response: 'editor_only' as const,
    title: 'Native fixture permission',
    message: 'Review the original native permission request.',
    questions: [],
  };
  const secret = {
    ...data.request,
    token: randomUUID(),
    response: 'editor_only' as const,
    title: 'Native private question',
    questions: [{ ...data.request.questions[0]!, options: null, isSecret: true }],
  };
  data.state.nativeRequests = [permission, secret];
  data.state.nativeRequestCount = 2;
  data.state.status = 'attention';
  await expect(native(page)).toContainText('2 native requests need your input');
  await native(page).getByRole('button', { name: 'Review requests', exact: true }).click();
  await expect(form(page)).toContainText(
    'Permissions and unsupported native request formats stay there',
  );
  await form(page)
    .getByRole('combobox', { name: 'Request', exact: true })
    .selectOption(secret.token);
  await expect(form(page)).toContainText('It is not collected here');
  await expect(form(page).getByRole('textbox')).toHaveCount(0);
  await expect(
    form(page).getByRole('button', { name: 'Send native answer', exact: true }),
  ).toHaveCount(0);
  expect(data.answers).toEqual([]);
  expect(data.modelWrites).toEqual([]);
  await screen(page, 'native-only');
});
