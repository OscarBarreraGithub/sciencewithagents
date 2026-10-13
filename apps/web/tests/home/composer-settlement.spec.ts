import { expect, test } from '@playwright/test';
import { onPendingMessageSettled, settlePendingMessage } from '../../src/composer-settlement';

test('composer settlement isolates storage scopes and preserves accepted legacy receipt identity', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    } as Storage;
  };
  const first = memory(),
    other = memory();
  const key = 'workspace:send:one';
  const pending = { key: 'accepted-original', text: 'Retained text', steer: false };
  const events: string[] = [];
  const stop = onPendingMessageSettled(first, key, (value) => events.push(value.key));
  const stopOther = onPendingMessageSettled(other, key, () => events.push('wrong storage'));
  const stopKey = onPendingMessageSettled(first, 'workspace:send:other', () =>
    events.push('wrong key'),
  );
  try {
    const newer = { ...pending, key: 'newer-attempt' };
    first.setItem(`${key}:pending`, JSON.stringify(newer));
    expect(settlePendingMessage(first, key, pending)).toBe(false);
    expect(JSON.parse(first.getItem(`${key}:pending`)!)).toEqual(newer);
    expect(events).toEqual([]);
    // The old record had no steer field. Existing generic receipt lookup can
    // acknowledge it by exact text without ever replaying an unknown send mode.
    first.setItem(`${key}:pending`, JSON.stringify({ key: pending.key, text: pending.text }));
    expect(settlePendingMessage(first, key, { ...pending, modeUnknown: true })).toBe(true);
    expect(first.getItem(`${key}:pending`)).toBeNull();
    expect(events).toEqual([pending.key]);
  } finally {
    stop();
    stopOther();
    stopKey();
  }
});

for (const legacy of [false, true]) {
  test(`an accepted ${legacy ? 'legacy unknown-mode' : 'separate-message'} receipt settles without replay or changing the next send mode`, async ({
    page,
    baseURL,
  }) => {
    const created = await page.request.post('/api/projects', {
      headers: { Origin: baseURL! },
      data: { key: crypto.randomUUID(), name: 'Receipt settlement', provider: 'codex' },
    });
    expect(created.ok()).toBe(true);
    const { managerId } = await created.json();
    const accepted = {
      key: crypto.randomUUID(),
      text: 'Previously accepted message',
      steer: false,
    };
    expect(
      (
        await page.request.post(`/api/agents/${managerId}/messages`, {
          headers: { Origin: baseURL! },
          data: accepted,
        })
      ).ok(),
    ).toBe(true);
    // Expose the existing Codex choice: successful read-only reconciliation must
    // retain Queue next instead of silently changing it to Steer now.
    await page.route(`**/api/agents/${managerId}*`, async (route) => {
      if (new URL(route.request().url()).pathname !== `/api/agents/${managerId}`)
        return route.continue();
      const response = await route.fetch();
      const value = await response.json();
      value.agent.status = 'running';
      await route.fulfill({ response, json: value });
    });
    let sends = 0;
    await page.route(`**/api/agents/${managerId}/messages`, async (route) => {
      sends++;
      await route.fulfill({ status: 500, json: { error: 'Unexpected replay' } });
    });
    try {
      await page.goto(`/#/chat/${managerId}`);
      const input = page.locator('.composer textarea');
      const newer = 'Keep this newer unsent draft.';
      await input.fill(newer);
      await expect(page.locator('.composer')).toHaveClass(/draft-steady/);
      const storageKey = `dock:local:workspace:send:${managerId}:pending`;
      await page.evaluate(
        ({ storageKey, accepted, legacy }) => {
          localStorage.setItem(
            storageKey,
            JSON.stringify(legacy ? { key: accepted.key, text: accepted.text } : accepted),
          );
        },
        { storageKey, accepted, legacy },
      );
      await page.reload();
      await expect
        .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
        .toBeNull();
      await expect(input).toHaveValue(newer);
      await expect(page.getByRole('combobox', { name: 'Send timing', exact: true })).toHaveValue(
        'queue',
      );
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
      expect(sends).toBe(0);
      const detail = await (await page.request.get(`/api/agents/${managerId}`)).json();
      expect(
        detail.runs.filter((run: { text: string }) => run.text === accepted.text),
      ).toHaveLength(1);
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

for (const code of ['DRAFT_CHANGED', 'NO_ACTIVE_TURN'] as const) {
  for (const newerAttempt of [false, true]) {
    test(`a held ${code} refusal after remount preserves ${newerAttempt ? 'a newer same-text K2' : 'the restored K'} without replay`, async ({
      page,
      baseURL,
    }) => {
      const created = await page.request.post('/api/projects', {
        headers: { Origin: baseURL! },
        data: { key: crypto.randomUUID(), name: 'Refusal ownership', provider: 'codex' },
      });
      expect(created.ok()).toBe(true);
      const { managerId } = await created.json();
      const messagesPath = `/api/agents/${managerId}/messages`;
      const storageKey = `dock:local:workspace:send:${managerId}`;
      await page.addInitScript(
        ({ messagesPath, storageKey }) => {
          const view = window as typeof window & {
            completedRefusals: number[];
            receiptMutations: string[];
          };
          view.completedRefusals = [];
          view.receiptMutations = [];
          const json = Response.prototype.json;
          Response.prototype.json = async function () {
            const value = await json.call(this);
            if (new URL(this.url).pathname === messagesPath && value.fixtureAttempt) {
              // The terminal catch and finally run in the rejection's microtask
              // chain. This task runs after that chain, so assertions cannot beat
              // the old callback or rely on an arbitrary response-wait delay.
              const channel = new MessageChannel();
              channel.port1.onmessage = () => {
                view.completedRefusals.push(value.fixtureAttempt);
                channel.port1.close();
                channel.port2.close();
              };
              channel.port2.postMessage(null);
            }
            return value;
          };
          const set = Storage.prototype.setItem;
          const remove = Storage.prototype.removeItem;
          const record = (storage: Storage, key: string) => {
            if (
              storage === localStorage &&
              [`${storageKey}:pending`, `${storageKey}:rejected`].includes(key)
            )
              view.receiptMutations.push(key);
          };
          Storage.prototype.setItem = function (key, value) {
            set.call(this, key, value);
            record(this, key);
          };
          Storage.prototype.removeItem = function (key) {
            remove.call(this, key);
            record(this, key);
          };
        },
        { messagesPath, storageKey },
      );
      await page.route(new RegExp(`/api/agents/${managerId}(?:\\?.*)?$`), async (route) => {
        const response = await route.fetch();
        const value = await response.json();
        value.agent.status = 'running';
        await route.fulfill({ response, json: value });
      });
      await page.route(`**/api/agents/${managerId}/receipts/*`, (route) =>
        route.fulfill({ json: { run: null, submitted: null } }),
      );
      const posts: { key: string; text: string; steer: boolean; draft?: unknown }[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(`**${messagesPath}`, async (route) => {
        posts.push(route.request().postDataJSON());
        const attempt = posts.length;
        if (attempt === 1) await gate;
        await route.fulfill({
          status: attempt <= 2 ? 409 : 503,
          json:
            attempt <= 2
              ? { code, error: 'Confirmed pre-reservation refusal', fixtureAttempt: attempt }
              : { error: 'K2 acknowledgement unavailable' },
        });
      });
      const input = page.locator('.composer textarea');
      const timing = page.getByRole('combobox', { name: 'Send timing', exact: true });
      const text = 'Identical words retain the identity of each explicit attempt.';
      const pending = () =>
        page.evaluate((key) => localStorage.getItem(`${key}:pending`), storageKey);
      const snapshot = () =>
        page.evaluate((key) => {
          const view = window as typeof window & { receiptMutations: string[] };
          return {
            pending: localStorage.getItem(`${key}:pending`),
            rejected: localStorage.getItem(`${key}:rejected`),
            mutations: view.receiptMutations,
          };
        }, storageKey);
      try {
        await page.goto(`/#/chat/${managerId}`);
        await input.fill(text);
        await timing.selectOption('steer');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await expect.poll(() => posts.length).toBe(1);
        const original = JSON.parse((await pending())!);
        expect(original).toMatchObject({ key: posts[0]!.key, text, steer: true });
        // In-app navigation unmounts the old composer but keeps its callback alive.
        await page.evaluate(() => {
          location.hash = '#/home';
        });
        await expect(input).toHaveCount(0);
        await page.evaluate((id) => {
          location.hash = `#/chat/${id}`;
        }, managerId);
        await expect(input).toHaveValue(text);
        await expect(
          page.getByRole('button', { name: 'Retry previous message', exact: true }),
        ).toBeEnabled();
        if (newerAttempt) {
          // The mounted owner still handles the same exact K refusal normally.
          await page.getByRole('button', { name: 'Retry previous message', exact: true }).click();
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as typeof window & { completedRefusals: number[] }).completedRefusals,
              ),
            )
            .toContain(2);
          await expect.poll(pending).toBeNull();
          expect(posts[1]).toEqual(posts[0]);
          await expect(input).toHaveValue(text);
          await expect(
            page.getByRole('button', { name: 'Send message', exact: true }),
          ).toBeEnabled();
          if (code === 'DRAFT_CHANGED') {
            await expect(
              page
                .getByRole('alert')
                .filter({ hasText: 'That message was not sent because the draft changed' }),
            ).toBeVisible();
            expect((await snapshot()).rejected).toBe(text);
          } else {
            await expect(
              page
                .getByRole('alert')
                .filter({ hasText: 'The reply finished before your update was sent' }),
            ).toBeVisible();
            await expect(timing).toHaveValue('queue');
            expect((await snapshot()).rejected).toBeNull();
          }
          expect(posts).toHaveLength(2); // A terminal refusal never retries automatically.
          await timing.selectOption('steer');
          await input.fill(text);
          await page.getByRole('button', { name: 'Send message', exact: true }).click();
          await expect(
            page.getByRole('alert').filter({ hasText: 'K2 acknowledgement unavailable' }),
          ).toBeVisible();
          expect(posts).toHaveLength(3);
          expect(posts[2]).toMatchObject({ text, steer: true });
          expect(posts[2]!.key).not.toBe(posts[0]!.key);
        }
        await expect(page.locator('.composer')).toHaveClass(/draft-steady/);
        const before = await snapshot();
        const ownedKey = newerAttempt ? posts[2]!.key : posts[0]!.key;
        expect(JSON.parse(before.pending!)).toMatchObject({ key: ownedKey, text, steer: true });
        release();
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as typeof window & { completedRefusals: number[] }).completedRefusals,
            ),
          )
          .toContain(1);
        expect(await snapshot()).toEqual(before);
        await expect(input).toHaveValue(text);
        await expect(timing).toHaveValue('steer');
        await expect(
          page.getByRole('button', { name: 'Retry previous message', exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole('alert').filter({ hasText: 'Confirmed pre-reservation refusal' }),
        ).toHaveCount(0);
        const postCount = newerAttempt ? 3 : 1;
        expect(posts).toHaveLength(postCount);
        await page.reload();
        await expect(input).toHaveValue(text);
        await expect(timing).toHaveValue('steer');
        await expect(
          page.getByRole('button', { name: 'Retry previous message', exact: true }),
        ).toBeEnabled();
        expect(await pending()).toBe(before.pending);
        expect((await snapshot()).rejected).toBe(before.rejected);
        expect(posts).toHaveLength(postCount); // Remount and reload never dispatch another turn.
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }
}
