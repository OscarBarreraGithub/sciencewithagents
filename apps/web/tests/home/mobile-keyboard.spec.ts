import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mirrorPage, type MirrorState } from '@dock/shared';

declare global {
  interface Window {
    __testKeyboard: {
      set(height: number, offsetTop: number, event: 'resize' | 'scroll'): void;
      windowScrolls: number;
      intoView: number;
    };
  }
}

// Safari's keyboard changes the visual viewport independently of the layout viewport.
// Keep the native EventTarget, override only its geometry, and do not resize the window.
// This exercises app geometry/events, not iOS's actual keyboard animation or focus panning.
async function keyboardFixture(page: Page) {
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    const prototype = Object.getPrototypeOf(viewport);
    const nativeHeight = Object.getOwnPropertyDescriptor(prototype, 'height')!.get!.bind(viewport);
    const nativeTop = Object.getOwnPropertyDescriptor(prototype, 'offsetTop')!.get!.bind(viewport);
    let height: number | null = null;
    let offsetTop: number | null = null;
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => height ?? nativeHeight() },
      offsetTop: { configurable: true, get: () => offsetTop ?? nativeTop() },
      pageTop: { configurable: true, get: () => (offsetTop ?? nativeTop()) + window.scrollY },
    });
    const fixture = {
      windowScrolls: 0,
      intoView: 0,
      set(nextHeight: number, nextTop: number, event: 'resize' | 'scroll') {
        height = nextHeight;
        offsetTop = nextTop;
        viewport.dispatchEvent(new Event(event));
      },
    };
    window.__testKeyboard = fixture;
    for (const name of ['scrollTo', 'scrollBy'] as const) {
      const original = window[name].bind(window);
      window[name] = (x?: number | ScrollToOptions, y?: number) => {
        fixture.windowScrolls++;
        if (typeof x === 'number') original(x, y ?? 0);
        else original(x);
      };
    }
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
      fixture.intoView++;
      original.call(this, options);
    };
  });
}

async function viewportEvent(
  page: Page,
  height: number,
  offsetTop: number,
  event: 'resize' | 'scroll',
  scrollBeforeObserver?: string,
) {
  return page.evaluate(
    async ({ height, offsetTop, event, scrollBeforeObserver }) => {
      const log = scrollBeforeObserver
        ? document.querySelector<HTMLElement>(scrollBeforeObserver)
        : null;
      const beforeHeight = log?.clientHeight ?? 0;
      const beforeTop = log?.scrollTop ?? 0;
      const layoutScroll: {
        beforeHeight: number;
        height: number;
        beforeTop: number;
        top: number;
        gap: number;
      }[] = [];
      // The shell's style commit precedes ResizeObserver delivery. Read the actual
      // shrunken log and deliver Safari's possible layout-scroll ordering explicitly;
      // leave scrollTop and the native ResizeObserver untouched.
      const observer = log
        ? new MutationObserver(() => {
            if (log.clientHeight >= beforeHeight) return;
            observer!.disconnect();
            layoutScroll.push({
              beforeHeight,
              height: log.clientHeight,
              beforeTop,
              top: log.scrollTop,
              gap: log.scrollHeight - log.clientHeight - log.scrollTop,
            });
            log.dispatchEvent(new Event('scroll'));
          })
        : null;
      observer?.observe(document.querySelector('.home-shell')!, {
        attributes: true,
        attributeFilter: ['style'],
      });
      window.__testKeyboard.set(height, offsetTop, event);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      observer?.disconnect();
      return layoutScroll[0] ?? null;
    },
    { height, offsetTop, event, scrollBeforeObserver },
  );
}

test('Home stays fixed during full-height viewport overscroll and has no bottom navigation', async ({
  page,
}) => {
  await keyboardFixture(page);
  await page.goto('/#/home');
  await expect(page.locator('.overview')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0);
  const height = await page.evaluate(() => innerHeight);
  for (const offset of [105, -72, 36, 0]) {
    await viewportEvent(page, height, offset, 'scroll');
    const shell = await page.locator('.home-shell').boundingBox();
    expect(shell!.y).toBe(0);
    expect(shell!.height).toBe(height);
  }
  await page.evaluate(() => window.scrollTo(0, 500));
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const main = page.locator('.home-content');
  if (await main.evaluate((e) => e.scrollHeight > e.clientHeight)) {
    await main.evaluate((e) => e.scrollTo(0, e.scrollHeight));
    expect(await main.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
    expect((await page.locator('.home-shell').boundingBox())!.y).toBe(0);
  }
});

test('focusing the Home to-do keeps cards and editor geometry stable while the keyboard opens', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop', 'Keyboard geometry targets phone layouts.');
  await keyboardFixture(page);
  await page.route('**/api/work-items', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/#/home');
  const editor = page.getByRole('textbox', { name: 'New to-do', exact: true });
  await expect(editor).toBeEnabled();
  await editor.scrollIntoViewIfNeeded();
  await editor.click();
  const geometry = () =>
    page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('.home-content')!;
      const field = document.querySelector<HTMLElement>('#todo-new')!;
      const nav = document.querySelector('.overview-destinations')!;
      return {
        navHeight: nav.getBoundingClientRect().height,
        fieldOffset:
          field.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop,
        listCap: getComputedStyle(field.closest('.overview-section-body')!).maxHeight,
      };
    });
  const before = await geometry();
  const height = await page.evaluate(() => innerHeight);
  for (const [visibleHeight, top] of [
    [height * 0.65, 0],
    [height * 0.55, 32],
    [height, 0],
  ]) {
    await viewportEvent(page, visibleHeight!, top!, 'resize');
    const after = await geometry();
    expect(Math.abs(after.navHeight - before.navHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.fieldOffset - before.fieldOffset)).toBeLessThanOrEqual(1);
    expect(after.listCap).toBe(before.listCap);
  }
  await editor.fill('Remember this phone draft.');
  await page.reload();
  await expect(editor).toHaveValue('Remember this phone draft.');
});

test('manager names stay readable beside reachable header tools at larger text sizes', async ({
  page,
  baseURL,
}, info) => {
  const name = 'Thermal transport and materials research';
  const response = await page.request.post('/api/projects', {
    headers: { origin: baseURL! },
    data: { key: randomUUID(), name, provider: 'codex' },
  });
  expect(response.ok()).toBe(true);
  const { managerId } = await response.json();
  await page.goto(`/#/chat/${managerId}`);
  const title = page.locator('.chat-pane-title h1');
  await expect(title).toContainText(name);
  for (const scale of [1, 1.5, 2]) {
    await title.evaluate((el, scale) => {
      el.style.fontSize = `${18 * scale}px`;
    }, scale);
    const geometry = await title.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      // Font ink can extend outside its line box without being clipped. Check the
      // containing header, plus the title's own wrapping/scroll width.
      const bounds = el.closest('.chat-pane-head')!.getBoundingClientRect();
      return {
        fits: text.right <= bounds.right + 1 && text.bottom <= bounds.bottom + 1,
        wraps: getComputedStyle(el).whiteSpace !== 'nowrap',
        overflow: el.scrollWidth > el.clientWidth,
      };
    });
    expect(geometry).toEqual({ fits: true, wraps: true, overflow: false });
    for (const label of ['Notes', 'Subagents', 'Configure']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await title.evaluate((el) => {
    el.style.fontSize = '';
  });
  await page.screenshot({ path: info.outputPath('manager-name.png') });
});

type ChatElements = {
  log: string;
  composer: string;
  input: string;
  send: string;
  header: string;
  entry: string;
  latest?: string;
};

async function geometry(page: Page, elements: ChatElements) {
  return page.evaluate((selectors) => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    };
    const log = document.querySelector<HTMLElement>(selectors.log)!;
    return {
      shell: rect('.home-shell'),
      header: rect(selectors.header),
      composer: rect(selectors.composer),
      input: rect(selectors.input),
      send: rect(selectors.send),
      log: rect(selectors.log),
      gap: log.scrollHeight - log.clientHeight - log.scrollTop,
      innerHeight,
      scrollY,
      documentHeight: document.documentElement.scrollHeight,
    };
  }, elements);
}

async function checkKeyboard(page: Page, elements: ChatElements, screenshot: string) {
  const input = page.locator(elements.input);
  const log = page.locator(elements.log);
  await expect(input).toBeVisible();
  await expect(log.locator(elements.entry)).toHaveCount(40);
  await expect
    .poll(async () =>
      log.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
    )
    .toBeLessThanOrEqual(2);
  const initial = await geometry(page, elements);
  const keyboardHeight = Math.round(initial.innerHeight * (initial.innerHeight < 500 ? 0.72 : 0.6));
  await input.focus();
  const layoutScroll = await viewportEvent(
    page,
    keyboardHeight,
    0,
    'resize',
    elements.latest ? elements.log : undefined,
  );
  if (elements.latest) {
    expect(layoutScroll).not.toBeNull();
    expect(layoutScroll!.beforeHeight - layoutScroll!.height).toBeGreaterThan(80);
    expect(Math.abs(layoutScroll!.top - layoutScroll!.beforeTop)).toBeLessThanOrEqual(1);
    expect(layoutScroll!.gap).toBeGreaterThan(80);
  }
  const opened = await geometry(page, elements);
  expect(opened.innerHeight).toBe(initial.innerHeight);
  expect(opened.log.height).toBeLessThan(initial.log.height - 80);
  // Check immediately after layout settles; a later history poll must not be needed to repin.
  expect(opened.gap).toBeLessThanOrEqual(3);

  const draft = Array.from({ length: 8 }, (_, i) => `Unsent phone draft line ${i + 1}`).join('\n');
  await input.fill(draft);
  // Read an older message inside the existing page. This is an intentional timeline scroll,
  // independent of Safari's visual viewport scroll as it keeps the caret above the keyboard.
  const anchor = log.locator(elements.entry).nth(6);
  await anchor.evaluate((node, selector) => {
    const log = document.querySelector<HTMLElement>(selector)!;
    log.scrollTop += node.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
    log.dispatchEvent(new Event('scroll'));
  }, elements.log);
  const anchorOffset = () =>
    anchor.evaluate(
      (node, selector) =>
        node.getBoundingClientRect().top -
        document.querySelector(selector)!.getBoundingClientRect().top,
      elements.log,
    );
  const readingAt = await anchorOffset();
  const assertVisible = async (height: number, top: number) => {
    const current = await geometry(page, elements);
    expect(current.innerHeight).toBe(initial.innerHeight);
    expect(current.scrollY).toBe(0);
    expect(current.documentHeight).toBeLessThanOrEqual(initial.innerHeight + 1);
    expect(Math.abs(current.shell.top - top)).toBeLessThanOrEqual(2);
    expect(Math.abs(current.shell.height - height)).toBeLessThanOrEqual(2);
    expect(current.header.top).toBeGreaterThanOrEqual(top - 1);
    expect(current.input.top).toBeGreaterThanOrEqual(top);
    expect(current.input.bottom).toBeLessThanOrEqual(top + height + 1);
    expect(current.composer.bottom).toBeLessThanOrEqual(top + height + 1);
    expect(current.send.top).toBeGreaterThanOrEqual(top);
    expect(current.send.bottom).toBeLessThanOrEqual(top + height + 1);
    expect(current.send.bottom).toBeLessThanOrEqual(current.composer.bottom + 1);
    expect(current.log.height).toBeGreaterThan(20);
    expect(Math.abs((await anchorOffset()) - readingAt)).toBeLessThanOrEqual(2);
    if (elements.latest) {
      const latest = page.locator(elements.latest);
      await expect(latest).toBeVisible();
      const bounds = (await latest.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(top - 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(current.composer.top + 1);
    }
  };

  await viewportEvent(page, keyboardHeight - 16, 24, 'resize');
  await assertVisible(keyboardHeight - 16, 24);
  await page.evaluate(() => {
    window.__testKeyboard.windowScrolls = 0;
    window.__testKeyboard.intoView = 0;
  });
  for (const top of [48, 30, 12]) {
    await viewportEvent(page, keyboardHeight - 16, top, 'scroll');
    await assertVisible(keyboardHeight - 16, top);
  }
  expect(
    await page.evaluate(() => ({
      scrolls: window.__testKeyboard.windowScrolls,
      intoView: window.__testKeyboard.intoView,
    })),
  ).toEqual({ scrolls: 0, intoView: 0 });
  await expect(input).toHaveValue(draft);
  await page.screenshot({ path: screenshot });

  await input.evaluate((node) => (node as HTMLTextAreaElement).blur());
  await viewportEvent(page, initial.innerHeight, 0, 'resize');
  await assertVisible(initial.innerHeight, 0);
  // Dismissing the keyboard must preserve the older reading position and the draft.
  await expect(input).toHaveValue(draft);
  if (elements.latest) {
    await page.locator(elements.latest).click();
    await expect
      .poll(async () =>
        log.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop),
      )
      .toBeLessThanOrEqual(3);
  }
}

test('shared phone chat handles keyboard viewport offsets without covering its composer or moving older history', async ({
  page,
}, info) => {
  test.skip(
    info.project.name === 'desktop',
    'Synthetic keyboard geometry targets the mobile layouts.',
  );
  await keyboardFixture(page);
  const state: MirrorState = {
    windowId: randomUUID(),
    provider: 'codex',
    label: 'Keyboard fixture editor',
    threadId: randomUUID(),
    title: 'Shared keyboard regression',
    status: 'busy',
    message: '',
    canSteer: true,
    steerToken: 'keyboard-fixture-turn',
    paged: true,
    entries: Array.from({ length: 40 }, (_, i) => ({
      id: `keyboard-message-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      text: `Saved message ${i + 1}. ${'Keep this reading position while the keyboard moves. '.repeat(3)}`,
    })),
  };
  const { entries: _, ...window } = state;
  await page.route(/\/api\/vscode\/windows(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [window] }),
  );
  await page.route(`**/api/vscode/windows/${state.windowId}`, (route) =>
    route.fulfill({ json: mirrorPage(state) }),
  );
  const sends: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(send|control)$/.test(request.url()))
      sends.push(request.url());
  });
  await page.goto(`/#/chats/vscode/${encodeURIComponent(`codex:${state.threadId}`)}`);
  await checkKeyboard(
    page,
    {
      log: '.mirror-log',
      composer: '.mirror-composer',
      input: '.mirror-input-row textarea',
      send: '.mirror-send',
      header: '.mirror-header',
      entry: '.mirror-message',
      latest: '.mirror-latest',
    },
    `../../data/screenshots/keyboard/${info.project.name}-shared-keyboard.png`,
  );
  expect(sends).toEqual([]);
});

test('managed phone chat resizes its message pane for the keyboard and retains an older reading anchor', async ({
  page,
}, info) => {
  test.skip(
    info.project.name === 'desktop',
    'Synthetic keyboard geometry targets the mobile layouts.',
  );
  await keyboardFixture(page);
  const response = await page.request.post('/api/projects', {
    headers: { origin: new URL(info.project.use.baseURL!).origin },
    data: { key: randomUUID(), name: `Keyboard ${randomUUID().slice(0, 8)}`, provider: 'codex' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const project = await response.json();
  const detail = await (await page.request.get(`/api/agents/${project.managerId}`)).json();
  detail.agent.status = 'running';
  const snapshot = await (await page.request.get('/api/snapshot')).json();
  snapshot.agents.find((agent: { id: string }) => agent.id === project.managerId).status =
    'running';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: snapshot }));
  detail.entries = Array.from({ length: 40 }, (_, i) => ({
    id: randomUUID(),
    agentId: project.managerId,
    runId: null,
    kind: i % 2 ? 'assistant' : 'user',
    title: i % 2 ? 'Assistant' : 'You',
    text: `Saved managed message ${i + 1}. ${'Retain this point in the conversation. '.repeat(3)}`,
    status: 'completed',
    createdAt: new Date().toISOString(),
  }));
  detail.hasMore = false;
  await page.route(`**/api/agents/${project.managerId}`, (route) =>
    route.fulfill({ json: detail }),
  );
  const messages: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages'))
      messages.push(request.url());
  });
  await page.goto(`/#/chat/${project.managerId}`);
  await expect(page.getByRole('combobox', { name: 'Send timing' })).toHaveValue('steer');
  // The queue choice adds priority; exercise the taller toolbar with the keyboard open.
  await page.getByRole('combobox', { name: 'Send timing' }).selectOption('queue');
  await checkKeyboard(
    page,
    {
      log: '.conversation',
      composer: '.composer',
      input: '.composer textarea',
      send: '.composer .send-button',
      header: '.chat-pane-head',
      entry: '.message',
    },
    `../../data/screenshots/keyboard/${info.project.name}-managed-keyboard.png`,
  );
  expect(messages).toEqual([]);
});
