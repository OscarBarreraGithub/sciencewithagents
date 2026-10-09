import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mirrorPage, type MirrorState, type MirrorCommand } from '@dock/shared';
import { prepareChatMath } from '../../src/chatMath';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const WebSocket = require('ws') as typeof import('ws').default;
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});
const equations =
  String.raw`The temperature is \(T = 300\,\mathrm{K}\), with $E = mc^2$.

\[
\begin{aligned}
Z &= \int_0^\infty e^{-\beta E}\,dE \\
\langle E\rangle &= -\frac{\partial \log Z}{\partial\beta}
\end{aligned}
\]

$$\begin{pmatrix}1 & 0 \\ 0 & 1\end{pmatrix}$$

| Quantity | Value |
| --- | --- |
| Energy | $\frac{1}{2}mv^2$ |

Long equation:
\[ F = ${Array.from({ length: 20 }, (_, i) => `\\frac{x_{${i}}^2}{1+x_{${i}}}`).join(' + ')} \]

Prices are $5 and $10, not equations. An escaped dollar is \$20.

` + 'Literal source: `$x^2$` and `\\(a_b\\)`.\n';
const sourceExample = '\n```latex\n\\[ x^2 \\]\n```\n';

async function fixture(page: Page, text: string) {
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const created = await page.request.post('/api/projects', {
    headers: { origin },
    data: {
      key: randomUUID(),
      name: `Math fixture ${randomUUID().slice(0, 8)}`,
      provider: 'codex',
    },
  });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  let current = text;
  await page.route(new RegExp(`/api/agents/${project.managerId}(?:\\?.*)?$`), async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.entries = [
      {
        id: 'math-answer',
        agentId: project.managerId,
        runId: null,
        kind: 'assistant',
        title: 'Report',
        status: 'completed',
        createdAt: new Date().toISOString(),
        text: current,
      },
    ];
    await route.fulfill({ json: detail });
  });
  await page.goto(`/#/chat/${project.managerId}`);
  await expect(page.locator('.conversation .chat-markdown')).toBeVisible();
  return {
    setText: (value: string) => {
      current = value;
    },
  };
}

test('math parsing preserves Markdown literals, prices, links and unfinished equations', () => {
  for (const text of [
    'Prices $5 and $10; $30–$40.',
    '`$x$` and `\\(x\\)`',
    '```latex\n\\[x\\]\n```',
    '    $x$\n',
    '[report](https://example.com/$x$)',
    'Visit https://example.com/$x$ now.',
    '![image](https://example.com/$x$)',
    '\\$20 and \\$30',
    'Still writing \\[ \\frac{1}',
    'Still writing $x +',
  ])
    expect(prepareChatMath(text).text).toBe(text);
  expect(prepareChatMath('Math $x$ and \\(y\\).').text).not.toContain('$x$');
  expect(prepareChatMath('Prices $5 and $10. Math $x$.').text).toBe(
    'Prices $5 and $10. Math `swa-math-0`.',
  );
});

test('chat equations render automatically and stay within phone and zoomed layouts', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fixture(page, equations + sourceExample);
  const content = page.locator('.conversation .chat-markdown');
  await expect(content.locator('.katex')).toHaveCount(6);
  await expect(content.locator('.katex-display')).toHaveCount(3);
  await expect(content.locator('.katex-error')).toHaveCount(0);
  await expect(content.locator('math')).toHaveCount(6);
  await expect(content).toContainText('Prices are $5 and $10, not equations.');
  await expect(content.locator('code').first()).toHaveText('$x^2$');
  await expect(content.locator('pre code')).toHaveText('\\[ x^2 \\]\n');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  const wide = content.locator('.katex-display').last();
  expect(await wide.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await wide.evaluate((element) => {
    element.scrollLeft = 180;
  });
  expect(await wide.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  for (const zoom of [1, 1.25, 1.5, 2]) {
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom);
    }, zoom);
    expect(
      await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 2),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
      ),
    ).toBe(true);
  }
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  await wide.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.locator('.conversation').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: `../../data/chat-math-20261004/${info.project.name}.png` });
  expect(errors).toEqual([]);
});

test('wide inline fractions, math fences and equations inside lists remain readable', async ({
  page,
}) => {
  await fixture(
    page,
    String.raw`Inline \(\frac{\text{${'long measurement name '.repeat(10)}}}{2}\).

- An inline $x_1^2$ in a list.
- A display \[\sum_{n=1}^{\infty}n^{-2}=\frac{\pi^2}{6}\].

> The quoted energy is \(E=mc^2\).
` + '\n```math\n\\int_0^1 x\\,dx = \\frac{1}{2}\n```',
  );
  const content = page.locator('.conversation .chat-markdown');
  await expect(content.locator('.katex')).toHaveCount(5);
  await expect(content.locator('.katex-error')).toHaveCount(0);
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth + 2)).toBe(
    true,
  );
  const inline = content.locator('p').first();
  expect(await inline.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await inline.evaluate((element) => {
    element.scrollLeft = 100;
  });
  expect(await inline.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
});

test('partial and malformed math stays readable and cannot load external resources', async ({
  page,
}) => {
  const fixtureState = await fixture(page, String.raw`Still writing \[\frac{1}`);
  const content = page.locator('.conversation .chat-markdown');
  await expect(content.locator('.katex')).toHaveCount(0);
  fixtureState.setText(String.raw`Completed \[\frac{1}{2}\]`);
  await page.reload();
  await expect(content.locator('.katex')).toHaveCount(1);
  fixtureState.setText(String.raw`Malformed \[\frac{1}\]

\[\href{javascript:alert(1)}{click}\]

\[\includegraphics{https://example.com/tracker.png}\]

<script>alert(1)</script>

Still readable.`);
  await page.reload();
  await expect(content.locator('.katex-error')).toHaveCount(1);
  await expect(content).toContainText('Still readable.');
  await expect(content.locator('a, img, script')).toHaveCount(0);
});

test('shared editor chats render math even in paged messages and preserve raw tool activity', async ({
  page,
}) => {
  const state: MirrorState = {
    windowId: randomUUID(),
    provider: 'claude',
    label: 'Math editor',
    threadId: randomUUID(),
    title: 'Equation report',
    status: 'idle',
    message: '',
    paged: true,
    groupedActivity: true,
    entries: [
      {
        id: 'answer',
        role: 'assistant',
        text: String.raw`Read \(a_b^2\) and \[\frac{1}{2}\].` + '\n\nLong report. '.repeat(800),
      },
      { id: 'tool', role: 'activity', text: String.raw`commandExecution\n$raw_tool$` },
    ],
  };
  const bridgeUrl = new URL('/api/vscode/bridge', test.info().project.use.baseURL);
  bridgeUrl.protocol = bridgeUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(bridgeUrl);
  socket.on('message', (raw) => {
    const command = JSON.parse(raw.toString()) as MirrorCommand;
    const value = JSON.stringify(
      mirrorPage(state, command.type === 'read' ? command.page : undefined),
    );
    for (let i = 0; i < value.length; i += 4096)
      socket.send(
        JSON.stringify({
          type: 'chunk',
          id: command.id,
          text: value.slice(i, i + 4096),
          last: i + 4096 >= value.length,
        }),
      );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const { entries: _, ...window } = state;
    socket.send(JSON.stringify({ type: 'hello', window }));
    await expect
      .poll(async () =>
        (await (await page.request.get('/api/vscode/windows')).json()).some(
          (item: { windowId: string }) => item.windowId === state.windowId,
        ),
      )
      .toBe(true);
    await page.goto('/#/vscode');
    await page.getByRole('button', { name: /Equation report/ }).click();
    // Entry paging initially shows the tail; moving back must keep math formatting.
    const previous = page.getByRole('button', { name: 'Previous part', exact: true });
    if (await previous.isEnabled()) await previous.click();
    await expect(page.locator('.mirror-message .katex')).toHaveCount(2);
    await expect(page.locator('.mirror-text-pages')).toContainText('Long entry');
    await page.locator('.mirror-activity-group > summary').click();
    await page.locator('.mirror-activity > summary').click();
    await expect(page.locator('.mirror-activity pre')).toContainText('$raw_tool$');
    await expect(page.locator('.mirror-activity .katex')).toHaveCount(0);
  } finally {
    socket.terminate();
  }
});
