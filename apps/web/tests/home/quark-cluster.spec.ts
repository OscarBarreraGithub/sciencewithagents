import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const job = (jobId: string, state: string, extra: Record<string, unknown> = {}) => ({
  jobId,
  baseJobId: jobId.replace(/_.*/, ''),
  name: 'parameter-sweep-with-a-long-descriptive-name',
  state,
  reason: state === 'PENDING' ? 'Priority' : '',
  partition: 'shared,serial_requeue',
  account: 'lab_account',
  qos: 'normal',
  submittedAt: '2026-10-05T08:00:00',
  startAt: '2026-10-05T09:30:00',
  timeLimit: '12:00:00',
  timeUsed: state === 'RUNNING' ? '1:02:03' : '0:00',
  cpus: 8,
  memory: '32G',
  gres: '',
  nodes: 1,
  nodeList: state === 'RUNNING' ? 'node101' : '',
  priority: 1_001_499,
  workDir: '/n/labs/lab_account/researcher/very/long/project/directory/for/wrapping',
  owner: null,
  ...extra,
});
// A reading kept from before the SSH sign-in expired, shaped like the server contract.
function reading(state: 'connected' | 'sign-in-needed') {
  return {
    configured: true,
    settings: { enabled: true, alias: 'hpc', label: 'Lab cluster', accountingDays: 3 },
    revision: 1,
    connection: {
      state,
      master: state === 'connected' ? 'running' : 'absent',
      checkedAt: at(1),
      connectedAt: at(state === 'connected' ? 1 : 40),
      message:
        state === 'connected'
          ? 'Connected through your existing SSH sign-in.'
          : 'Cluster sign-in is needed. Batch jobs already submitted keep running.',
    },
    scheduler: { version: '26.05.4', cluster: 'cluster1' },
    queue: {
      observedAt: at(state === 'connected' ? 1 : 40),
      error: null,
      items: [
        job('51000001', 'RUNNING', {
          owner: {
            agentId: crypto.randomUUID(),
            agentName: 'Simulation manager',
            projectId: crypto.randomUUID(),
            projectName: 'Simulation',
          },
        }),
        job('51000002_[1-200%20]', 'PENDING'),
      ],
      omitted: 0,
      priority: [],
    },
    fairshare: {
      observedAt: at(40),
      error: null,
      items: [
        {
          account: 'lab_account',
          fairShare: 0.163485,
          levelFairShare: null,
          accountNormShares: 0.005966,
          accountEffectiveUsage: 0.015587,
          accountRawUsage: 12255632911,
          userRawUsage: 0,
        },
        {
          account: 'institute_account_with_a_long_name',
          fairShare: 0.999952,
          levelFairShare: null,
          accountNormShares: 0.000195,
          accountEffectiveUsage: 0,
          accountRawUsage: 10675,
          userRawUsage: 10675,
        },
      ],
      omitted: 0,
    },
    limits: {
      observedAt: at(40),
      error: null,
      items: [
        {
          cluster: 'cluster1',
          account: 'lab_account',
          partition: '',
          qos: ['normal'],
          defaultQos: '',
          maxJobs: 10100,
          maxSubmit: 10100,
          maxWall: '',
          maxTres: '',
          maxTresPerNode: '',
          grpJobs: null,
          grpSubmit: null,
          grpTres: '',
          grpTresRunMins: '',
          grpWall: '',
        },
      ],
      omitted: 0,
      accounts: [
        {
          cluster: 'cluster1',
          account: 'lab_account',
          parent: 'div_parent',
          partition: '',
          qos: ['normal'],
          defaultQos: '',
          maxJobs: 10100,
          maxSubmit: 10100,
          maxWall: '',
          maxTres: '',
          maxTresPerNode: '',
          grpJobs: null,
          grpSubmit: null,
          grpTres: '',
          grpTresRunMins: '',
          grpWall: '',
        },
      ],
      site: {
        maxArraySize: 10000,
        maxJobCount: 300000,
        enforce: 'associations,limits,qos,safe',
        priorityType: 'priority/multifactor',
        priorityFlags: 'NO_FAIR_TREE',
      },
      qos: [
        {
          name: 'test',
          maxJobsPerUser: 5,
          maxSubmitPerUser: 5,
          maxTresPerUser: 'cpu=112,mem=1000G',
          maxJobsPerAccount: null,
          maxSubmitPerAccount: null,
          maxTresPerAccount: '',
          maxTres: '',
          maxTresPerNode: '',
          maxWall: '',
          grpJobs: null,
          grpSubmit: null,
          grpTres: '',
          flags: '',
        },
      ],
      partitions: [
        {
          name: 'shared',
          state: 'UP',
          maxTime: '3-00:00:00',
          defaultTime: '',
          maxNodes: 'unlimited',
          maxCpusPerNode: 'unlimited',
          defMemPerCpu: '',
          defMemPerNode: '',
          maxMemPerNode: 'unlimited',
          qos: '',
          preemptMode: 'OFF',
          priorityTier: 3,
          totalCpus: 17760,
          totalNodes: 370,
          gres: '',
          cpus: { allocated: 5565, idle: 3175, other: 9020, total: 17760 },
          accessible: true,
        },
        {
          name: 'another_lab_partition',
          state: 'UP',
          maxTime: '3-00:00:00',
          defaultTime: '',
          maxNodes: 'unlimited',
          maxCpusPerNode: 'unlimited',
          defMemPerCpu: '',
          defMemPerNode: '',
          maxMemPerNode: 'unlimited',
          qos: '',
          preemptMode: 'OFF',
          priorityTier: 5,
          totalCpus: 64,
          totalNodes: 1,
          gres: 'gpu=4',
          cpus: { allocated: 64, idle: 0, other: 0, total: 64 },
          accessible: false,
        },
      ],
    },
    recent: {
      observedAt: at(40),
      error: null,
      items: [
        {
          jobId: '50999999',
          baseJobId: '50999999',
          name: 'fit',
          partition: 'shared',
          account: 'lab_account',
          state: 'OUT_OF_MEMORY',
          exitCode: '0:125',
          submittedAt: '2026-10-04T08:00:00',
          startedAt: '2026-10-04T08:01:00',
          endedAt: '2026-10-04T09:00:00',
          elapsedSeconds: 3540,
          timeLimitSeconds: 43200,
          cpus: 8,
          memoryBytes: 16 * 1024 ** 3,
          gpus: null,
          cpuSeconds: 20000,
          maxRssBytes: 16 * 1024 ** 3,
          cpuEfficiency: 0.706,
          memoryEfficiency: 1,
          workDir: '/n/labs/lab_account/researcher/run',
          stdout: '/n/labs/lab_account/researcher/run/logs/fit-50999999.out',
          stderr: '/n/labs/lab_account/researcher/run/logs/fit-50999999.err',
          owner: null,
        },
      ],
      omitted: 0,
    },
    tracked: [],
    unavailable:
      state === 'connected'
        ? []
        : [{ section: 'sinfo', message: 'sinfo: error: Unable to contact slurm controller' }],
    refreshing: false,
    nextRefreshAt: null,
    stale: state !== 'connected',
    notice:
      'Read-only observations of native Slurm state through your own SSH sign-in. sciencewithagents imposes no cluster limits or submission gate.',
  };
}

test('an unconnected cluster keeps the owner entry after a rejected save', async ({ page }) => {
  await page.goto('/#/work');
  const connect = page.locator('.quark-cluster-connect');
  await connect.locator('summary').click();
  await connect.getByLabel('SSH host alias').fill('hpc');
  await connect.getByRole('button', { name: 'Save cluster' }).click();
  // Demonstration mode never stores cluster settings or opens SSH.
  await expect(connect.getByRole('alert')).toContainText('real installation');
  await expect(connect.getByLabel('SSH host alias')).toHaveValue('hpc');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('old readings stay readable through sign-in loss and refresh recovers', async ({
  page,
}, info) => {
  let state: 'connected' | 'sign-in-needed' = 'sign-in-needed';
  let refreshes = 0;
  await page.route('**/api/cluster', (route) => route.fulfill({ json: reading(state) }));
  await page.route('**/api/cluster/refresh', async (route) => {
    refreshes++;
    state = 'connected';
    await route.fulfill({ json: reading(state) });
  });
  await page.goto('/#/work');
  const panel = page.getByRole('region', { name: 'Lab cluster · Slurm cluster' });
  await expect(panel.getByText('Sign-in needed', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText(
    'Batch jobs already submitted keep running',
  );
  await expect(panel.getByText('Waiting: Priority')).toBeVisible();
  await expect(panel.getByRole('link', { name: /Simulation manager/ })).toBeVisible();
  await expect(panel.getByText('0.163')).toBeVisible();
  await expect(panel.getByText(/not remaining capacity/)).toBeVisible();
  await expect(panel.getByText(/does not guarantee an\s+earlier start/)).toBeVisible();
  // A section the cluster could not answer is flagged rather than shown as current.
  await expect(panel.getByText('Not read in the latest reading: idle CPUs')).toBeVisible();
  await panel.getByText('Native account, QOS and partition limits').click();
  await expect(panel.getByText('5 jobs per person')).toBeVisible();
  await expect(panel.getByText(/10,000 tasks per job array/)).toBeVisible();
  await expect(panel.getByText('under div_parent')).toBeVisible();
  await expect(panel.getByText(/not that none applies/)).toBeVisible();
  await expect(panel.getByText('another_lab_partition')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show all partitions' }).click();
  await expect(panel.getByText('not available to you')).toBeVisible();
  await panel.getByText(/Recent jobs · last 3 days/).click();
  await expect(panel.getByText('out_of_memory · exit 0:125')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const overflow = await panel.evaluate((section) => {
    const bounds = section.getBoundingClientRect();
    return [...section.querySelectorAll('li, button, input, select')]
      .filter((el) => el.getClientRects().length)
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.left < bounds.left - 1 || box.right > bounds.right + 1;
      })
      .map((el) => el.textContent?.slice(0, 60));
  });
  expect(overflow).toEqual([]);
  await mkdir('../../data/screenshots/quark-cluster', { recursive: true });
  await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `../../data/screenshots/quark-cluster/${info.project.name}.png` });
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(panel.getByText(/Not read in the latest reading/)).toHaveCount(0);
  expect(refreshes).toBe(1);
});

test('Home asks for a cluster sign-in only while it is needed', async ({ page }) => {
  let state: 'connected' | 'sign-in-needed' = 'sign-in-needed';
  await page.route('**/api/cluster', (route) => route.fulfill({ json: reading(state) }));
  await page.goto('/');
  const need = page.getByRole('link', { name: /Lab cluster: sign in again/ });
  await expect(need).toBeVisible();
  await expect(need).toHaveAttribute('href', '#/work');
  state = 'connected';
  await page.evaluate(() => window.dispatchEvent(new Event('swa:refresh-home')));
  await expect(need).toHaveCount(0);
});

test('cluster sign-in sends each answer once and keeps it out of browser storage', async ({
  page,
}) => {
  let state: 'connected' | 'sign-in-needed' = 'sign-in-needed';
  const id = crypto.randomUUID();
  const flow = (patch: Record<string, unknown>) => ({
    id,
    state: 'prompt',
    prompt: null,
    message: '',
    startedAt: new Date().toISOString(),
    ...patch,
  });
  const answers: unknown[] = [];
  let current = flow({ prompt: { id: 1, kind: 'password', label: 'Password:' } });
  await page.route('**/api/cluster', (route) => route.fulfill({ json: reading(state) }));
  await page.route('**/api/cluster/sign-in', (route) => route.fulfill({ json: current }));
  await page.route('**/api/cluster/sign-in/respond', async (route) => {
    const body = route.request().postDataJSON();
    answers.push(body);
    current =
      body.promptId === 1
        ? flow({ prompt: { id: 2, kind: 'code', label: 'VerificationCode:' } })
        : flow({ state: 'connected', message: 'Signed in. Cluster readings are refreshing.' });
    if (body.promptId === 2) state = 'connected';
    await route.fulfill({ json: current });
  });
  await page.goto('/#/work');
  const panel = page.getByRole('region', { name: 'Lab cluster · Slurm cluster' });
  await panel.getByRole('button', { name: 'Sign in to Lab cluster' }).click();
  const password = panel.getByLabel('Password:');
  await expect(password).toHaveAttribute('type', 'password');
  await mkdir('../../data/screenshots/quark-cluster', { recursive: true });
  await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: `../../data/screenshots/quark-cluster/sign-in-${test.info().project.name}.png`,
  });
  await password.fill('correct horse battery');
  await panel.getByRole('button', { name: 'Send' }).click();
  const code = panel.getByLabel('VerificationCode:');
  await expect(code).toHaveValue('');
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await code.fill('246810');
  await code.press('Enter');
  await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
  expect(answers).toEqual([
    { id, promptId: 1, response: 'correct horse battery' },
    { id, promptId: 2, response: '246810' },
  ]);
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  expect(stored).not.toContain('correct horse');
  expect(stored).not.toContain('246810');
});

test('a running notebook job opens a loopback tunnel in its own tab', async ({ page }) => {
  const base = reading('connected');
  base.queue.items = [
    job('51000003', 'RUNNING', { name: 'notebook', nodeList: 'node101', partition: 'test' }),
  ];
  const url = `http://127.0.0.1:43210/lab?token=${'k'.repeat(40)}`;
  let notebooks: unknown[] = [];
  let local = true;
  const closes: unknown[] = [];
  await page.route('**/api/cluster', (route) => route.fulfill({ json: base }));
  await page.route('**/api/cluster/notebooks', (route) =>
    route.fulfill({
      json: {
        localBrowser: local,
        notebooks,
        remoteMessage:
          'Open this notebook in the browser on the computer connected to the cluster.',
      },
    }),
  );
  await page.route('**/api/cluster/notebooks/open', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ jobId: '51000003' });
    notebooks = [
      {
        alias: 'hpc',
        jobId: '51000003',
        node: 'node101',
        remotePort: 45678,
        localPort: 43210,
        openedAt: new Date().toISOString(),
        running: true,
      },
    ];
    await route.fulfill({ json: { jobId: '51000003', url } });
  });
  await page.route('**/api/cluster/notebooks/close', async (route) => {
    closes.push(route.request().postDataJSON());
    notebooks = [];
    await route.fulfill({ json: { notebooks } });
  });
  // Stands in for the tunnel's Jupyter page in the new tab.
  await page
    .context()
    .route('http://127.0.0.1:43210/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>notebook</title>' }),
    );
  await page.goto('/#/work');
  const panel = page.getByRole('region', { name: 'Lab cluster · Slurm cluster' });
  const tab = page.context().waitForEvent('page');
  await panel.getByRole('button', { name: 'Open notebook' }).click();
  const opened = await tab;
  await expect.poll(() => opened.url()).toBe(url);
  expect(await opened.evaluate(() => window.opener)).toBeNull();
  await opened.close();
  await expect(panel.getByText('Notebook tunnels (1)')).toBeVisible();
  await panel.getByRole('button', { name: 'Close tunnel' }).click();
  await expect(panel.getByText('Notebook tunnels (1)')).toHaveCount(0);
  expect(closes).toEqual([{ jobId: '51000003' }]);
  // Through a phone entry or another selected computer the tunnel would point at the wrong device.
  local = false;
  await page.reload();
  await expect(
    panel.getByText('Open this notebook in the browser on the computer connected to the cluster.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open notebook' })).toHaveCount(0);
});

for (const mode of ['phone', 'selected-host'] as const) {
  test(`${mode} notebook launch retries, refreshes blocked-popup handoffs and keeps the QUARK location`, async ({
    page,
    baseURL,
  }, info) => {
    const base = reading('connected');
    base.queue.items = [job('51000003', 'RUNNING', { name: 'notebook', nodeList: 'node101' })];
    const host = randomUUID();
    const prefix = mode === 'selected-host' ? `/api/hosts/${host}/proxy` : '/api';
    if (mode === 'selected-host') {
      await page.addInitScript((id) => localStorage.setItem('dock:host', id), host);
      await page.route('**/api/hosts', (route) =>
        route.fulfill({
          json: {
            local: { id: 'local', label: 'Entry fixture' },
            setupError: null,
            hosts: [
              {
                id: host,
                label: 'Selected fixture',
                accountLabel: 'owner fixture',
                status: 'connected',
                error: null,
              },
            ],
          },
        }),
      );
      await page.route(`**${prefix}/**`, async (route) => {
        const source = route.request();
        const url = source.url().replace(prefix, '/api');
        if (new URL(url).pathname === '/api/events')
          return route.fulfill({
            contentType: 'text/event-stream',
            body: 'event: ready\ndata: {}\n\n',
          });
        const response = await page.request.fetch(url, {
          method: source.method(),
          data: source.postData() ?? undefined,
          headers: { 'Content-Type': 'application/json', Origin: baseURL! },
        });
        return route.fulfill({ response });
      });
    }
    await page.route(`**${prefix}/cluster`, (route) => route.fulfill({ json: base }));
    await page.route(`**${prefix}/cluster/notebooks`, (route) =>
      route.fulfill({
        json: { localBrowser: false, remoteAvailable: true, remoteMessage: '', notebooks: [] },
      }),
    );
    const notebookOrigin = 'https://notebooks.example.test:9443';
    await page.context().route(`${notebookOrigin}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>Private notebook fixture</title>',
      }),
    );
    const attempts: { key: string; jobId: string }[] = [];
    const urls: string[] = [];
    let releaseLaunch = () => {};
    const readyToLaunch = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    await page.route(`**${prefix}/cluster/notebooks/launch`, async (route) => {
      attempts.push(route.request().postDataJSON());
      urls.push(route.request().url());
      // The first failure checks opener removal while the request is still pending.
      if (attempts.length === 1) {
        await expect
          .poll(
            () =>
              page
                .context()
                .pages()
                .filter((tab) => tab !== page && !tab.isClosed()).length,
          )
          .toBe(1);
        const tab = page
          .context()
          .pages()
          .find((tab) => tab !== page && !tab.isClosed())!;
        expect(await tab.evaluate(() => window.opener)).toBeNull();
        return route.fulfill({
          status: 503,
          json: { error: 'Notebook address temporarily unavailable.' },
        });
      }
      if (attempts.length === 2) await readyToLaunch;
      return route.fulfill({
        json: {
          jobId: '51000003',
          url: `${notebookOrigin}/launch#notebook-fixture-handoff-${attempts.length}`,
        },
      });
    });
    let localOpens = 0;
    await page.route(`**${prefix}/cluster/notebooks/open`, (route) => {
      localOpens++;
      return route.abort();
    });
    await page.goto('/#/work');
    const panel = page.getByRole('region', { name: 'Lab cluster · Slurm cluster' });
    const open = panel.getByRole('button', { name: 'Open notebook', exact: true });
    await expect(open).toBeEnabled();
    await open.click();
    await expect(panel.getByRole('alert')).toContainText(
      'Notebook address temporarily unavailable.',
    );
    await expect.poll(() => page.context().pages().length).toBe(1);
    await open.scrollIntoViewIfNeeded();
    const location = page.url();
    const nextTab = page.context().waitForEvent('page');
    await open.click();
    const launched = await nextTab;
    // Removing the previous error can legitimately re-anchor the page. Measure
    // retention after that UI update and before navigating the reserved tab.
    await expect(panel.getByRole('alert')).toHaveCount(0);
    const scroll = await page.locator('#home-content').evaluate((element) => element.scrollTop);
    releaseLaunch();
    await expect
      .poll(() => launched.url())
      .toBe(`${notebookOrigin}/launch#notebook-fixture-handoff-2`);
    expect(await launched.evaluate(() => window.opener)).toBeNull();
    await launched.close();
    expect(page.url()).toBe(location);
    expect(await page.locator('#home-content').evaluate((element) => element.scrollTop)).toBe(
      scroll,
    );
    expect(attempts[1].key).not.toBe(attempts[0].key);

    await page.clock.install();
    await page.evaluate(() => {
      window.open = () => null;
    });
    await open.click();
    const fallback = panel.getByRole('link', { name: 'Open notebook 51000003', exact: true });
    await expect(fallback).toHaveAttribute(
      'href',
      `${notebookOrigin}/launch#notebook-fixture-handoff-3`,
    );
    await expect(fallback).toHaveAttribute('rel', 'noopener noreferrer');
    await page.clock.fastForward(31_000);
    await expect(fallback).toHaveCount(0);
    await expect(panel.getByText('Open again for a fresh link.')).toBeVisible();
    await panel.getByRole('button', { name: 'Open notebook 51000003', exact: true }).click();
    await expect(fallback).toHaveAttribute(
      'href',
      `${notebookOrigin}/launch#notebook-fixture-handoff-4`,
    );
    expect(attempts[3].key).not.toBe(attempts[2].key);
    expect(attempts.every((attempt) => attempt.jobId === '51000003')).toBe(true);
    expect(
      urls.every((url) => new URL(url).pathname === `${prefix}/cluster/notebooks/launch`),
    ).toBe(true);
    expect(localOpens).toBe(0);
    expect(
      await page.evaluate(() =>
        [localStorage, sessionStorage].some((storage) =>
          Object.values(storage).some((value) => value.includes('notebook-fixture-handoff-')),
        ),
      ),
    ).toBe(false);
    await mkdir('../../data/notebook-ui', { recursive: true });
    await page.screenshot({
      path: `../../data/notebook-ui/${info.project.name}-${mode}-fallback.png`,
    });
    const manualTab = page.context().waitForEvent('page');
    await fallback.click();
    const manual = await manualTab;
    await expect
      .poll(() => manual.url())
      .toBe(`${notebookOrigin}/launch#notebook-fixture-handoff-4`);
    expect(await manual.evaluate(() => window.opener)).toBeNull();
    await manual.close();
    expect(page.url()).toBe(location);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('phone notebook setup shows the current unavailable message without offering a local tunnel', async ({
  page,
}) => {
  const base = reading('connected');
  base.queue.items = [job('51000003', 'RUNNING', { name: 'notebook', nodeList: 'node101' })];
  await page.route('**/api/cluster', (route) => route.fulfill({ json: base }));
  await page.route('**/api/cluster/notebooks', (route) =>
    route.fulfill({
      json: {
        localBrowser: false,
        remoteAvailable: false,
        remoteMessage: 'Ask your setup agent to connect this computer’s private notebook address.',
        notebooks: [],
      },
    }),
  );
  await page.goto('/#/work');
  const panel = page.getByRole('region', { name: 'Lab cluster · Slurm cluster' });
  await expect(
    panel.getByText('Ask your setup agent to connect this computer’s private notebook address.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open notebook', exact: true })).toHaveCount(0);
});
