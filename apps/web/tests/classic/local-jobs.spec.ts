import { expect, test } from './fixture';

test('transcription starts from an empty queue, retains a lost-response receipt after reload, retries and returns text', async ({
  page,
}, info) => {
  const job: any = {
    id: '00000000-0000-4000-8000-000000000005',
    kind: 'youtube-transcription',
    projectId: null,
    taskId: null,
    requestedBy: null,
    url: 'https://youtu.be/abcdefghijk',
    resources: {
      priority: 'interactive',
      cpuCores: 2,
      memoryMb: 1024,
      expectedSeconds: 300,
      deadline: null,
    },
    status: 'queued',
    phase: 'waiting',
    message: 'Waiting for capacity.',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    autoPaused: false,
    attempt: 1,
    transcriptAvailable: false,
    expectedFinishAt: null,
  };
  const state = {
    jobs: [] as any[],
    toolsReady: true,
    modelReady: false,
    setupMessage: 'The first job downloads and verifies the Whisper model.',
  };
  const keys: string[] = [];
  let reads = 0;
  await page.route('**/api/local-jobs', (route) => {
    if (route.request().method() === 'GET')
      return ++reads === 1
        ? route.fulfill({ status: 500, json: { error: 'Temporary read failure' } })
        : route.fulfill({ json: state });
    const body = route.request().postDataJSON();
    keys.push(body.key);
    job.resources = body.resources;
    state.jobs = [job];
    return keys.length === 1
      ? route.fulfill({ status: 500, json: { error: 'Connection lost; check and retry.' } })
      : route.fulfill({ json: job });
  });
  await page.route('**/api/local-jobs/control', (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'retry') {
      job.status = 'completed';
      job.phase = 'finished';
      job.transcriptAvailable = true;
      job.message = 'Transcript ready.';
      job.attempt++;
    }
    return route.fulfill({ json: job });
  });
  await page.route('**/api/local-jobs/read', (route) =>
    route.fulfill({ json: { job, text: 'A transcript made on this computer.', nextOffset: null } }),
  );
  const open = async () => {
    if (page.viewportSize()!.width <= 720)
      await page.getByRole('button', { name: 'Open projects' }).click();
    await page.getByRole('button', { name: 'Transcribe a video', exact: true }).click();
  };
  await page.goto('/');
  await open();
  let dialog = page.getByRole('dialog', { name: 'Local video transcription' });
  await expect(dialog).toContainText('No local transcription jobs yet.');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByLabel('YouTube video link').fill(job.url);
  await expect(dialog.getByRole('combobox', { name: 'Priority' })).toHaveValue('interactive');
  await dialog.getByRole('button', { name: 'Queue transcription', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Connection lost');
  await page.reload();
  await open();
  dialog = page.getByRole('dialog', { name: 'Local video transcription' });
  await expect(dialog.getByLabel('YouTube video link')).toHaveValue(job.url);
  await dialog.getByRole('button', { name: 'Queue transcription', exact: true }).click();
  await expect(dialog.getByLabel('YouTube video link')).toHaveValue('');
  expect(keys[1]).toBe(keys[0]);
  job.status = 'failed';
  job.message = 'The downloading step did not finish. Retry another public link.';
  await dialog.getByRole('button', { name: 'Retry transcription', exact: true }).click();
  await dialog.getByRole('button', { name: 'Read transcript', exact: true }).click();
  await expect(dialog).toContainText('A transcript made on this computer.');
  await expect(dialog.getByRole('button', { name: 'Download complete transcript' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `../../data/screenshots/${info.project.name}-local-transcription.png`,
  });
});
